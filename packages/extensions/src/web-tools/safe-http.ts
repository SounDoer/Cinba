import { promises as dns } from "node:dns";
import {
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
  request as httpRequest,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, type LookupFunction, isIP } from "node:net";
import { hostname as localHostname } from "node:os";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export type SafeHttpResponse = {
  finalUrl: string;
  contentType: string | undefined;
  body: Uint8Array;
  downloadTruncated: boolean;
};

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type SafeHttpOptions = {
  maxBodyBytes?: number;
  resolveHostname?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  request?: SafeRequestFunction;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type SafeRequestFunction = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

const NON_PUBLIC_ADDRESSES = new BlockList();
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const LOCAL_HOSTNAME = localHostname().toLowerCase();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

function mappedIpv4Address(address: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) {
    return dotted[1];
  }
  const hexadecimal = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(address);
  if (!hexadecimal) {
    return undefined;
  }
  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isNonPublicAddress(address: string): boolean {
  const mapped = mappedIpv4Address(address);
  if (mapped) {
    return NON_PUBLIC_ADDRESSES.check(mapped, "ipv4");
  }
  const family = isIP(address);
  return family !== 0 && NON_PUBLIC_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

function decodedResponseStream(response: IncomingMessage): Readable {
  const contentEncoding = response.headers["content-encoding"];
  const encoding = (Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding)
    ?.trim()
    .toLowerCase();
  if (!encoding || encoding === "identity") {
    return response;
  }
  if (encoding === "gzip") {
    return response.pipe(createGunzip());
  }
  if (encoding === "deflate") {
    return response.pipe(createInflate());
  }
  if (encoding === "br") {
    return response.pipe(createBrotliDecompress());
  }
  throw new Error(`web_fetch received unsupported content encoding: ${encoding}`);
}

export function createPinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  const approved = addresses.map(({ address, family }) => ({ address, family }));
  return (_hostname, options, callback) => {
    const family = typeof options.family === "number" ? options.family : 0;
    const matching = approved.filter((address) => family === 0 || address.family === family);
    if (matching.length === 0) {
      const error = new Error(
        "No approved address matches the requested family",
      ) as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "");
      return;
    }
    if (options.all) {
      callback(null, matching);
      return;
    }
    callback(null, matching[0].address, matching[0].family);
  };
}

export async function fetchPublicUrl(
  input: string,
  options: SafeHttpOptions = {},
): Promise<SafeHttpResponse> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new Error("web_fetch timed out")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  timeout.unref();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    return await fetchPublicUrlWithRedirects(input, { ...options, signal }, 0);
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    if (timeoutController.signal.aborted && !options.signal?.aborted) {
      throw new Error("web_fetch timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPublicUrlWithRedirects(
  input: string,
  options: SafeHttpOptions,
  redirectCount: number,
): Promise<SafeHttpResponse> {
  options.signal?.throwIfAborted();
  const url = new URL(input);
  const literalAddress = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const normalizedHostname = literalAddress.toLowerCase();
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    isNonPublicAddress(literalAddress) ||
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".localhost") ||
    normalizedHostname === LOCAL_HOSTNAME
  ) {
    throw new Error("web_fetch requires a public HTTP or HTTPS URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("web_fetch URL must not contain user information");
  }

  let addresses: readonly ResolvedAddress[];
  if (isIP(literalAddress) === 0) {
    const resolveHostname: NonNullable<SafeHttpOptions["resolveHostname"]> =
      options.resolveHostname ??
      (async (hostname: string) => {
        const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
        return resolved.map(({ address, family }) => {
          if (family !== 4 && family !== 6) {
            throw new Error("web_fetch hostname resolved to an unsupported address family");
          }
          return { address, family };
        });
      });
    addresses = await resolveHostname(url.hostname);
    options.signal?.throwIfAborted();
    if (addresses.length === 0) {
      throw new Error("web_fetch hostname did not resolve to an address");
    }
    if (addresses.some(({ address }) => isNonPublicAddress(address))) {
      throw new Error("web_fetch hostname resolved to a non-public address");
    }
  } else {
    addresses = [
      {
        address: literalAddress,
        family: isIP(literalAddress) as 4 | 6,
      },
    ];
  }

  const requestFunction =
    options.request ?? (url.protocol === "https:" ? httpsRequest : httpRequest);
  return new Promise<SafeHttpResponse>((resolve, reject) => {
    const request = requestFunction(
      url,
      {
        method: "GET",
        headers: {
          accept: "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8",
          "accept-encoding": "gzip, deflate, br",
          "user-agent": "Cinba web_fetch",
        },
        lookup: createPinnedLookup(addresses),
        signal: options.signal,
      },
      (response) => {
        if (
          response.statusCode !== undefined &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          typeof response.headers.location === "string"
        ) {
          response.resume();
          if (redirectCount >= 5) {
            reject(new Error("web_fetch followed more than 5 redirects"));
            return;
          }
          void fetchPublicUrlWithRedirects(
            new URL(response.headers.location, url).href,
            options,
            redirectCount + 1,
          ).then(resolve, reject);
          return;
        }
        if (
          response.statusCode === undefined ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          response.resume();
          reject(
            new Error(
              response.statusCode === undefined
                ? "web_fetch received an invalid HTTP response"
                : `web_fetch received HTTP ${response.statusCode}`,
            ),
          );
          return;
        }
        let bodyStream: Readable;
        try {
          bodyStream = decodedResponseStream(response);
        } catch (error) {
          response.resume();
          reject(error);
          return;
        }
        const chunks: Buffer[] = [];
        const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
        let bodyBytes = 0;
        let responseSettled = false;
        const finish = (downloadTruncated: boolean): void => {
          if (responseSettled) {
            return;
          }
          responseSettled = true;
          const contentType = response.headers["content-type"];
          resolve({
            finalUrl: url.href,
            contentType: Array.isArray(contentType) ? contentType[0] : contentType,
            body: new Uint8Array(Buffer.concat(chunks)),
            downloadTruncated,
          });
        };
        bodyStream.on("data", (chunk: Buffer | string) => {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          const remaining = maxBodyBytes - bodyBytes;
          if (bytes.length <= remaining) {
            chunks.push(bytes);
            bodyBytes += bytes.length;
            return;
          }
          if (remaining > 0) {
            chunks.push(bytes.subarray(0, remaining));
          }
          finish(true);
          bodyStream.destroy();
          response.destroy();
        });
        response.once("error", reject);
        bodyStream.once("error", reject);
        bodyStream.once("end", () => finish(false));
      },
    );
    request.once("error", reject);
    request.end();
  });
}
