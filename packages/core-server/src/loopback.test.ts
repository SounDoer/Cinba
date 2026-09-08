import { test } from "node:test";
import assert from "node:assert/strict";
import { isLoopback } from "./loopback.ts";

test("this machine's own addresses pass, in every form Node reports them", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  // An IPv4 client on a dual-stack socket arrives looking like this.
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  // The loopback block is a whole /8, not one address.
  assert.equal(isLoopback("127.0.0.53"), true);
  assert.equal(isLoopback("127.255.255.254"), true);
});

test("anything else fails, including the shapes that look close", () => {
  assert.equal(isLoopback("192.168.1.10"), false);
  assert.equal(isLoopback("10.0.0.1"), false);
  // A Tailscale address, which is exactly the case this will one day face.
  assert.equal(isLoopback("100.101.102.103"), false);
  assert.equal(isLoopback("::ffff:192.168.1.10"), false);
  assert.equal(isLoopback("1270.0.0.1"), false);
  assert.equal(isLoopback("127.0.0"), false);
  assert.equal(isLoopback("127.0.0.1.evil.com"), false);
});

test("an unknown address fails closed", () => {
  // A socket reports undefined once it has gone away; that must not read as local.
  assert.equal(isLoopback(undefined), false);
  assert.equal(isLoopback(""), false);
});
