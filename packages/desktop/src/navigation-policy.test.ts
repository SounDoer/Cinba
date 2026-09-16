import assert from "node:assert/strict";
import test from "node:test";
import { decideCoreNavigation, decideSyncNavigation } from "./navigation-policy.ts";

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

test("Sync navigation allows only its saved origin and safely externalizes HTTPS", () => {
  assert.equal(
    decideSyncNavigation("https://sync.example.test/", "https://sync.example.test/settings"),
    "allow",
  );
  assert.equal(
    decideSyncNavigation("https://sync.example.test/", "https://docs.example.test/"),
    "external",
  );
  for (const target of ["javascript:alert(1)", "file:///secret", "not a URL"]) {
    assert.equal(decideSyncNavigation("https://sync.example.test/", target), "deny");
  }
});
