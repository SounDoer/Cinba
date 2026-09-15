import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";

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
  resolveHostname?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
};

const NON_PUBLIC_ADDRESSES = new BlockList();

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
  ["::ffff:0:0", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && NON_PUBLIC_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

export async function fetchPublicUrl(
  input: string,
  options: SafeHttpOptions = {},
): Promise<SafeHttpResponse> {
  const url = new URL(input);
  const literalAddress = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    isNonPublicAddress(literalAddress)
  ) {
    throw new Error("web_fetch requires a public HTTP or HTTPS URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("web_fetch URL must not contain user information");
  }

  if (isIP(literalAddress) === 0) {
    const resolveHostname =
      options.resolveHostname ??
      ((hostname: string) => dns.lookup(hostname, { all: true, verbatim: true }));
    const addresses = await resolveHostname(url.hostname);
    if (addresses.length === 0) {
      throw new Error("web_fetch hostname did not resolve to an address");
    }
    if (addresses.some(({ address }) => isNonPublicAddress(address))) {
      throw new Error("web_fetch hostname resolved to a non-public address");
    }
  }

  throw new Error("Safe HTTP transport is not implemented for this URL yet");
}
