import { isProtectedRoot } from "./paths.ts";
import { parseShellInvocations } from "./shell.ts";
import type { PermissionContext, PermissionRule } from "./types.ts";

function shellCommand(context: PermissionContext): string | undefined {
  if (context.toolName !== "bash" && context.toolName !== "powershell") return undefined;
  const input = context.input as { command?: unknown } | undefined;
  return typeof input?.command === "string" ? input.command : undefined;
}

function hasRecursiveFlag(name: string, args: readonly string[]): boolean {
  if (name === "rm") return args.some((arg) => /^-[^-]*r/i.test(arg) || arg === "--recursive");
  if (["remove-item", "ri", "del", "erase", "rd", "rmdir"].includes(name)) {
    if (args.some((arg) => ["-r", "-rec", "-recurse"].includes(arg.toLowerCase()))) {
      return true;
    }
  }
  if (name === "rd" || name === "rmdir" || name === "del" || name === "erase") {
    return args.some((arg) => arg.toLowerCase() === "/s");
  }
  return false;
}

function literalTargets(args: readonly string[]): string[] {
  return args.filter((arg) => !arg.startsWith("-") && !arg.startsWith("/"));
}

function deletionTargets(name: string, args: readonly string[]): string[] {
  if (["rm", "remove-item", "ri"].includes(name)) {
    return args.filter((arg) => !arg.startsWith("-") && arg !== "--");
  }
  if (["rd", "rmdir", "del", "erase"].includes(name)) return literalTargets(args);
  return [];
}

const blockProtectedRootDeletion: PermissionRule = (context) => {
  const command = shellCommand(context);
  if (!command) return undefined;

  for (const invocation of parseShellInvocations(command)) {
    if (!hasRecursiveFlag(invocation.name, invocation.args)) continue;
    const target = deletionTargets(invocation.name, invocation.args).find((candidate) =>
      isProtectedRoot(candidate, context),
    );
    if (target) {
      return {
        ruleId: "shell.delete-protected-root",
        reason: `Recursive deletion of protected root "${target}" is blocked`,
      };
    }
  }
  return undefined;
};

const blockDiskDestruction: PermissionRule = (context) => {
  const command = shellCommand(context);
  if (!command) return undefined;

  const destructive = new Set(["format-volume", "clear-disk", "initialize-disk", "wipefs"]);
  for (const invocation of parseShellInvocations(command)) {
    const informationOnly = invocation.args.some((arg) =>
      ["--help", "-h", "/?", "--version", "-whatif"].includes(arg.toLowerCase()),
    );
    if (informationOnly) continue;
    if (
      destructive.has(invocation.name) ||
      (context.platform === "win32" && invocation.name === "format") ||
      invocation.name === "mkfs" ||
      invocation.name.startsWith("mkfs.")
    ) {
      return {
        ruleId: "shell.destroy-disk",
        reason: `Disk-destructive command "${invocation.name}" is blocked`,
      };
    }
  }
  return undefined;
};

const blockProtectedRootPermissionChange: PermissionRule = (context) => {
  const command = shellCommand(context);
  if (!command) return undefined;

  for (const invocation of parseShellInvocations(command)) {
    const recursive = invocation.args.some((arg) =>
      ["-r", "--recursive", "/r", "/t"].includes(arg.toLowerCase()),
    );
    if (!recursive || !["chmod", "chown", "icacls", "takeown"].includes(invocation.name)) {
      continue;
    }
    const target = invocation.args.find(
      (arg) => !arg.startsWith("-") && isProtectedRoot(arg, context),
    );
    if (target) {
      return {
        ruleId: "shell.change-protected-root-permissions",
        reason: `Recursive permission change on protected root "${target}" is blocked`,
      };
    }
  }
  return undefined;
};

export const BLOCK_RULES: readonly PermissionRule[] = [
  blockProtectedRootDeletion,
  blockDiskDestruction,
  blockProtectedRootPermissionChange,
];
