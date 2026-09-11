import { ASK_RULES, BLOCK_RULES } from "./rules.ts";
import type { PermissionContext, PermissionDecision } from "./types.ts";

/** Evaluate explicit restrictions first, then allow ordinary built-in operations. */
export function evaluatePermission(context: PermissionContext): PermissionDecision {
  try {
    for (const rule of BLOCK_RULES) {
      const match = rule(context);
      if (match) return { effect: "block", ...match };
    }
    for (const rule of ASK_RULES) {
      const match = rule(context);
      if (match) return { effect: "ask", ...match };
    }
  } catch {
    return {
      effect: "ask",
      ruleId: "fallback.unclassified",
      reason: "The operation could not be classified safely",
    };
  }

  return {
    effect: "allow",
    ruleId: "default.allow",
    reason: "No restricted operation matched",
  };
}
