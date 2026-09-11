// The Pi adapter for Cinba's permission policy.
//
// Phase 0 measurements are what make this necessary: Pi's RPC mode allows every
// tool call the model asks for by default, executing straight after tool_call.
// The policy decides which calls pass, need a person, or must never execute.

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluatePermission } from "./permission-gate/policy.ts";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const decision = evaluatePermission({
      toolName: event.toolName,
      input: event.input,
      cwd: ctx.cwd,
      homeDir: homedir(),
      platform: process.platform,
      systemRoot: process.env.SystemRoot,
    });
    if (decision.effect === "allow") return;
    if (decision.effect === "block") {
      return { block: true, reason: decision.reason };
    }

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

    const explanation = `Rule: ${decision.ruleId}\nReason: ${decision.reason}`;
    const allowed = await ctx.ui.confirm(`Allow ${event.toolName}?`, explanation);

    if (!allowed) {
      return { block: true, reason: "The user denied this tool call" };
    }
  });
}
