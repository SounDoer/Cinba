import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "@cinba/test-support";
import { PiClient } from "./pi-client.ts";
import { startPi } from "./pi-process.ts";
import { StdioTransport } from "./transport.ts";

test("the bundled edit bridge moves the leaf without changing the session", async (t) => {
  const directory = temporaryDirectory("cinba-edit-", t);
  const sessionPath = join(directory, "session.jsonl");
  const timestamp = "2026-01-01T00:00:00.000Z";
  writeFileSync(
    sessionPath,
    [
      { type: "session", version: 3, id: "edit-session", timestamp, cwd: directory },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: { role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 },
      },
      {
        type: "message",
        id: "user-2",
        parentId: "user-1",
        timestamp,
        message: { role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );

  const child = startPi({ cwd: directory, sessionPath });
  const client = new PiClient(new StdioTransport(child));
  try {
    const before = await client.getState();
    assert.equal((before.data as { sessionId?: string }).sessionId, "edit-session");

    const edited = await client.prompt("/cinba-edit-message user-2");
    assert.equal(edited.success, true);

    const after = await client.getEntries();
    assert.equal((after.data as { leafId?: string }).leafId, "user-1");
    const state = await client.getState();
    assert.equal((state.data as { sessionId?: string }).sessionId, "edit-session");
  } finally {
    await client.close();
  }
});
