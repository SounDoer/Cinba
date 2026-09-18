import assert from "node:assert/strict";
import test from "node:test";
import { authorizeDesktopIpcEvent } from "./desktop-ipc.ts";

const shellUrl = "file:///C:/Cinba/dist/shell/index.html";
const managerUrl = "file:///C:/Cinba/dist/shell/manage.html";

function ownsRendererFrame(id: number, url: string): boolean {
  return (id === 42 && url === shellUrl) || (id === 43 && url === managerUrl);
}

function event(id: number, url: string, top = true) {
  const mainFrame = { url };
  return {
    sender: { id, mainFrame },
    senderFrame: top ? mainFrame : { url },
  };
}

test("Desktop IPC authorizes a matching trusted top frame", () => {
  assert.doesNotThrow(() => authorizeDesktopIpcEvent(event(42, shellUrl), ownsRendererFrame));
  assert.doesNotThrow(() => authorizeDesktopIpcEvent(event(43, managerUrl), ownsRendererFrame));
});

test("Desktop IPC rejects subframes, external pages, and swapped local window URLs", () => {
  for (const untrusted of [
    event(42, shellUrl, false),
    event(42, "https://example.com/"),
    event(42, managerUrl),
    event(43, shellUrl),
  ]) {
    assert.throws(
      () => authorizeDesktopIpcEvent(untrusted, ownsRendererFrame),
      /Untrusted Desktop IPC sender/,
    );
  }
});
