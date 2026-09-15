import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteCoreProfile } from "./profiles.ts";

test("a user can create a normalized remote Core profile", () => {
  assert.deepEqual(
    createRemoteCoreProfile(
      { label: "  VPS  ", baseUrl: "https://cinba-vps.example.ts.net" },
      () => "profile-1",
    ),
    {
      id: "profile-1",
      kind: "remote",
      label: "VPS",
      baseUrl: "https://cinba-vps.example.ts.net/",
    },
  );
});

test("a remote Core profile must use HTTPS", () => {
  assert.throws(() => createRemoteCoreProfile({ label: "VPS", baseUrl: "http://cinba-vps.test" }), {
    message: "Remote Core URL must use HTTPS",
  });
});

test("a remote Core profile must have a visible label", () => {
  assert.throws(
    () => createRemoteCoreProfile({ label: "   ", baseUrl: "https://cinba-vps.test" }),
    { message: "Core profile label is required" },
  );
});

test("a remote Core profile label stays within the management UI limit", () => {
  assert.throws(
    () => createRemoteCoreProfile({ label: "x".repeat(81), baseUrl: "https://cinba-vps.test" }),
    { message: "Core profile label must be 80 characters or fewer" },
  );
});

test("a remote Core profile must point at an origin root", () => {
  assert.throws(
    () => createRemoteCoreProfile({ label: "VPS", baseUrl: "https://cinba-vps.test/private" }),
    { message: "Remote Core URL must point at an origin root" },
  );
});

test("a remote Core profile cannot contain a query", () => {
  assert.throws(
    () => createRemoteCoreProfile({ label: "VPS", baseUrl: "https://cinba-vps.test/?x=1" }),
    { message: "Remote Core URL must point at an origin root" },
  );
});

test("a remote Core profile cannot contain credentials", () => {
  assert.throws(
    () => createRemoteCoreProfile({ label: "VPS", baseUrl: "https://user:pass@cinba-vps.test/" }),
    { message: "Remote Core URL must point at an origin root" },
  );
});

test("a remote Core profile cannot contain a fragment", () => {
  assert.throws(
    () => createRemoteCoreProfile({ label: "VPS", baseUrl: "https://cinba-vps.test/#other" }),
    { message: "Remote Core URL must point at an origin root" },
  );
});
