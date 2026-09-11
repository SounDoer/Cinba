import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import sessionEdit from "./session-edit.ts";

test("the edit command navigates before the selected user message in the same session", async () => {
  let handler:
    | ((args: string, context: ExtensionCommandContext) => Promise<void>)
    | undefined;
  sessionEdit({
    registerCommand: (_name, options) => {
      handler = options.handler;
    },
  } as ExtensionAPI);

  let targetId = "";
  let summarize: boolean | undefined;
  const context = {
    sessionManager: {
      getBranch: () => [
        { id: "u1", type: "message", message: { role: "user" } },
        { id: "a1", type: "message", message: { role: "assistant" } },
        { id: "u2", type: "message", message: { role: "user" } },
      ],
    },
    navigateTree: async (id: string, options?: { summarize?: boolean }) => {
      targetId = id;
      summarize = options?.summarize;
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  assert(handler);
  await handler("u2", context);

  assert.equal(targetId, "u2");
  assert.equal(summarize, false);
});
