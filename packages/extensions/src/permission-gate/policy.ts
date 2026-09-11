import { BLOCK_RULES } from "./rules.ts";
import type { PermissionContext, PermissionDecision } from "./types.ts";

const CURRENT_AUTO_ALLOW = new Set(["read", "glob", "grep"]);

/** Evaluate rules in severity order. The Ask and default-Allow policy follows in the next phase. */
export function evaluatePermission(context: PermissionContext): PermissionDecision {
  try {
    for (const rule of BLOCK_RULES) {
      const match = rule(context);
      if (match) return { effect: "block", ...match };
    }
  } catch {
    return {
      effect: "ask",
      ruleId: "fallback.unclassified",
      reason: "The operation could not be classified safely",
    };
  }

  if (CURRENT_AUTO_ALLOW.has(context.toolName)) {
    return {
      effect: "allow",
      ruleId: "legacy.read-only",
      reason: "The tool is read-only",
    };
  }

  return {
    effect: "ask",
    ruleId: "legacy.confirm-other-tools",
    reason: "This tool still requires confirmation under the current policy",
  };
}
