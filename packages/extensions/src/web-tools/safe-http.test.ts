import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { type SafeRequestFunction, createPinnedLookup, fetchPublicUrl } from "./safe-http.ts";

test("literal loopback URLs are rejected before a request is made", async () => {
  await assert.rejects(fetchPublicUrl("http://127.0.0.1/private"), /public HTTP or HTTPS URL/);
});

test("the full IPv4 loopback range is rejected", async () => {
  await assert.rejects(fetchPublicUrl("http://127.42.0.9/private"), /public HTTP or HTTPS URL/);
});

test("literal private, link-local, metadata, and non-public IPv6 addresses are rejected", async () => {
  const urls = [
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
  ];

  for (const url of urls) {
    await assert.rejects(fetchPublicUrl(url), /public HTTP or HTTPS URL/, url);
  }
});

test("URLs containing user information are rejected", async () => {
  await assert.rejects(
    fetchPublicUrl("https://user:password@example.com/private"),
    /must not contain user information/,
  );
});

test("hostnames resolving to a private address are rejected", async () => {
  await assert.rejects(
    fetchPublicUrl("https://internal.example/private", {
      resolveHostname: async () => [{ address: "10.0.0.8", family: 4 }],
    }),
    /resolved to a non-public address/,
  );
});

test("the local machine name is rejected even if DNS reports a public address", async () => {
  await assert.rejects(
    fetchPublicUrl(`http://${hostname()}/`, {
      resolveHostname: async () => [{ address: "1.1.1.1", family: 4 }],
      request: () => {
        throw new Error("a request must not be made");
      },
    }),
    /public HTTP or HTTPS URL/,
  );
});

test("socket lookup returns the exact addresses that passed validation", async () => {
  const approved = [
    { address: "1.1.1.1", family: 4 as const },
    { address: "2606:4700:4700::1111", family: 6 as const },
  ];
  const lookup = createPinnedLookup(approved);

  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    lookup("public.example", { all: true }, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      assert.ok(Array.isArray(result));
      resolve(result);
    });
  });

  assert.deepEqual(addresses, approved);
});

test("a successful request reads the response through the pinned socket lookup", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("public body");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const requestThroughFixture: SafeRequestFunction = (_url, options, onResponse) => {
      assert.ok(options.lookup);
      options.lookup("public.example", { all: true }, (error, result) => {
        assert.ifError(error);
        assert.deepEqual(result, [{ address: "1.1.1.1", family: 4 }]);
      });
      return httpRequest(
        new URL(`http://127.0.0.1:${port}/article`),
        { method: options.method, headers: options.headers, signal: options.signal },
        onResponse,
      );
    };

    const response = await fetchPublicUrl("http://public.example/article", {
      resolveHostname: async () => [{ address: "1.1.1.1", family: 4 }],
      request: requestThroughFixture,
    });

    assert.deepEqual(response, {
      finalUrl: "http://public.example/article",
      contentType: "text/plain; charset=utf-8",
      body: new TextEncoder().encode("public body"),
      downloadTruncated: false,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a redirect to a private address is rejected before the second request", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(302, { location: "http://127.0.0.1/private" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const requestThroughFixture: SafeRequestFunction = (_url, options, onResponse) =>
      httpRequest(
        new URL(`http://127.0.0.1:${port}/redirect`),
        { method: options.method, headers: options.headers, signal: options.signal },
        onResponse,
      );

    await assert.rejects(
      fetchPublicUrl("http://public.example/redirect", {
        resolveHostname: async () => [{ address: "1.1.1.1", family: 4 }],
        request: requestThroughFixture,
      }),
      /public HTTP or HTTPS URL/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("more than five redirects are rejected", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    if (requests < 8) {
      response.writeHead(302, { location: "/again" });
      response.end();
      return;
    }
    response.end("too late");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const requestThroughFixture: SafeRequestFunction = (_url, options, onResponse) =>
      httpRequest(
        new URL(`http://127.0.0.1:${port}/again`),
        { method: options.method, headers: options.headers, signal: options.signal },
        onResponse,
      );

    await assert.rejects(
      fetchPublicUrl("http://public.example/start", {
        resolveHostname: async () => [{ address: "1.1.1.1", family: 4 }],
        request: requestThroughFixture,
      }),
      /more than 5 redirects/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("the whole fetch is stopped by one total deadline", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("late body"), 100);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const requestThroughFixture: SafeRequestFunction = (_url, options, onResponse) =>
      httpRequest(
        new URL(`http://127.0.0.1:${port}/slow`),
        { method: options.method, headers: options.headers, signal: options.signal },
        onResponse,
      );

    await assert.rejects(
      fetchPublicUrl("http://public.example/slow", {
        resolveHostname: async () => [{ address: "1.1.1.1", family: 4 }],
        request: requestThroughFixture,
        timeoutMs: 20,
      }),
      /timed out/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a caller abort keeps the caller's reason", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("late body"), 100);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const requestThroughFixture: SafeRequestFunction = (_url, options, onResponse) =>
      httpRequest(
        new URL(`http://127.0.0.1:${port}/slow`),
        { method: options.method, headers: options.headers, signal: options.signal },
        onResponse,
      );
    const controller = new AbortController();
    const reason = new Error("user cancelled fetch");
    const pending = fetchPublicUrl("http://public.example/slow", {
      resolveHostname: async () => [{ address: "1.1.1.1", family: 4 }],
      request: requestThroughFixture,
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    controller.abort(reason);

    await assert.rejects(pending, (error) => error === reason);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("gzip responses are decoded before they are returned", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-encoding": "gzip",
      "content-type": "text/plain",
    });
    response.end(gzipSync("decoded body"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const requestThroughFixture: SafeRequestFunction = (_url, options, onResponse) =>
      httpRequest(
        new URL(`http://127.0.0.1:${port}/compressed`),
        { method: options.method, headers: options.headers, signal: options.signal },
        onResponse,
      );

    const response = await fetchPublicUrl("http://public.example/compressed", {
      resolveHostname: async () => [{ address: "1.1.1.1", family: 4 }],
      request: requestThroughFixture,
    });

    assert.equal(new TextDecoder().decode(response.body), "decoded body");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("the decoded response body is truncated at the download limit", async () => {
  const server = createServer((_request, response) => {
    response.end("abcdefgh");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const requestThroughFixture: SafeRequestFunction = (_url, options, onResponse) =>
      httpRequest(
        new URL(`http://127.0.0.1:${port}/large`),
        { method: options.method, headers: options.headers, signal: options.signal },
        onResponse,
      );

    const response = await fetchPublicUrl("http://public.example/large", {
      maxBodyBytes: 5,
      resolveHostname: async () => [{ address: "1.1.1.1", family: 4 }],
      request: requestThroughFixture,
    });

    assert.equal(new TextDecoder().decode(response.body), "abcde");
    assert.equal(response.downloadTruncated, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a non-success final HTTP status is rejected", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end("internal upstream details");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const requestThroughFixture: SafeRequestFunction = (_url, options, onResponse) =>
      httpRequest(
        new URL(`http://127.0.0.1:${port}/unavailable`),
        { method: options.method, headers: options.headers, signal: options.signal },
        onResponse,
      );

    await assert.rejects(
      fetchPublicUrl("http://public.example/unavailable", {
        resolveHostname: async () => [{ address: "1.1.1.1", family: 4 }],
        request: requestThroughFixture,
      }),
      (error: unknown) =>
        error instanceof Error &&
        /HTTP 503/.test(error.message) &&
        !error.message.includes("internal upstream details"),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
