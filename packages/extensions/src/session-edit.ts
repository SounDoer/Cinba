// Internal bridge for editing a user message without creating a new session.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function messageRole(entry: unknown): unknown {
  return (entry as { type?: unknown; message?: { role?: unknown } } | undefined)?.message?.role;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cinba-edit-message", {
    description: "Move the current session branch to before a user message",
    handler: async (args, ctx) => {
      const entryId = args.trim();
      if (entryId === "") {
        throw new Error("The user message entry id is missing");
      }

      const target = ctx.sessionManager
        .getBranch()
        .find(
          (entry) =>
            entry.id === entryId && entry.type === "message" && messageRole(entry) === "user",
        );
      if (!target) {
        throw new Error("The user message is no longer on the active branch");
      }

      const result = await ctx.navigateTree(target.id, { summarize: false });
      if (result.cancelled) {
        throw new Error("Editing the user message was cancelled");
      }
    },
  });
}
