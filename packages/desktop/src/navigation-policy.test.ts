import assert from "node:assert/strict";
import test from "node:test";
import {
  decideCoreNavigation,
  decideDesktopNavigation,
  protectDesktopNavigation,
} from "./navigation-policy.ts";

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

test("Desktop navigation allows only the normalized exact local page", () => {
  const shell = "file:///C:/Cinba/dist/shell/index.html";
  assert.equal(
    decideDesktopNavigation(shell, "file:///C:/Cinba/dist/shell/../shell/index.html"),
    "allow",
  );
  assert.equal(decideDesktopNavigation(shell, "file:///C:/Cinba/dist/shell/manage.html"), "deny");
  assert.equal(decideDesktopNavigation(shell, `${shell}?external=1`), "deny");
  assert.equal(decideDesktopNavigation(shell, "https://example.com/docs"), "external");
  assert.equal(decideDesktopNavigation(shell, "javascript:alert(1)"), "deny");
  assert.equal(decideDesktopNavigation(shell, "data:text/html,untrusted"), "deny");
});

test("Desktop will-navigate blocks non-matching pages and opens only web URLs externally", () => {
  let navigate: ((event: { url: string; preventDefault(): void }) => void) | undefined;
  let openWindow: ((details: { url: string }) => { action: "deny" }) | undefined;
  const external: string[] = [];
  protectDesktopNavigation(
    {
      on: (_event, listener) => {
        navigate = listener;
      },
      setWindowOpenHandler: (handler) => {
        openWindow = handler;
      },
    },
    "file:///C:/Cinba/dist/shell/index.html",
    (url) => {
      external.push(url);
    },
  );

  let prevented = false;
  navigate!({
    url: "file:///C:/Cinba/dist/shell/index.html",
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, false);

  navigate!({
    url: "https://example.com/docs",
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.deepEqual(external, ["https://example.com/docs"]);

  prevented = false;
  navigate!({
    url: "file:///C:/Cinba/dist/shell/manage.html",
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.deepEqual(external, ["https://example.com/docs"]);

  assert.deepEqual(openWindow!({ url: "https://pi.dev/docs/latest" }), { action: "deny" });
  assert.deepEqual(openWindow!({ url: "javascript:alert(1)" }), { action: "deny" });
  assert.deepEqual(external, ["https://example.com/docs", "https://pi.dev/docs/latest"]);
});
