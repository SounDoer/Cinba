import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublicUrl } from "./safe-http.ts";

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
