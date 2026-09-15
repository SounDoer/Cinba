import assert from "node:assert/strict";
import test from "node:test";
import { decideCoreNavigation } from "./navigation-policy.ts";

test("a Core can navigate within its configured origin", () => {
  assert.equal(
    decideCoreNavigation(
      "https://cinba-vps.example.ts.net/",
      "https://cinba-vps.example.ts.net/settings",
    ),
    "allow",
  );
});

test("an external HTTPS link opens outside the Cinba window", () => {
  assert.equal(
    decideCoreNavigation("https://cinba-vps.example.ts.net/", "https://pi.dev/docs/latest"),
    "external",
  );
});

test("a dangerous navigation scheme is denied", () => {
  assert.equal(
    decideCoreNavigation("https://cinba-vps.example.ts.net/", "file:///etc/passwd"),
    "deny",
  );
});
