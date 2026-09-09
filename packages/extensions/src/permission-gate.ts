// The permission gate: every time the model wants a tool, ask the user first.
//
// Phase 0 measurements are what make this necessary: Pi's RPC mode allows every
// tool call the model asks for by default, executing straight after tool_call
// without waiting for the client. Without this gate, handing it a shell is
// handing over the shell.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Read-only tools. Asking would only spend the user's attention, so let them through. */
const AUTO_ALLOW = new Set(["read", "glob", "grep"]);

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (AUTO_ALLOW.has(event.toolName)) return;

    // With no UI there is nobody to ask. A safety gate has to block here rather
    // than allow: when the responsible party cannot be reached, the correct
    // default is to refuse (fail closed).
    //
    // Nothing reaches this today: the agent package always starts Pi through rpc-entry,
    // and hasUI is always true in RPC mode (measured in phase 0). But if
    // the agent package is ever used for headless automation, allowing here would mean
    // every tool passes silently, with no error to notice.
    if (!ctx.hasUI) {
      return { block: true, reason: "No UI available to confirm, so blocked by default" };
    }

    const detail = JSON.stringify(event.input, null, 2);
    const allowed = await ctx.ui.confirm(`Allow ${event.toolName}?`, detail);

    if (!allowed) {
      return { block: true, reason: "The user denied this tool call" };
    }
  });
}
