import { isInsideWorkspace, isProtectedRoot, isSensitivePath } from "./paths.ts";
import { hasRiskyOutputRedirection, parseShellInvocations } from "./shell.ts";
import type { PermissionContext, PermissionRule } from "./types.ts";

function shellCommand(context: PermissionContext): string | undefined {
  if (context.toolName !== "bash" && context.toolName !== "powershell") {
    return undefined;
  }
  const input = context.input as { command?: unknown } | undefined;
  return typeof input?.command === "string" ? input.command : undefined;
}

function hasRecursiveFlag(name: string, args: readonly string[]): boolean {
  if (name === "rm") {
    return args.some((arg) => /^-[^-]*r/i.test(arg) || arg === "--recursive");
  }
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
  if (["rd", "rmdir", "del", "erase"].includes(name)) {
    return literalTargets(args);
  }
  return [];
}

const blockProtectedRootDeletion: PermissionRule = (context) => {
  const command = shellCommand(context);
  if (!command) {
    return undefined;
  }

  for (const invocation of parseShellInvocations(command)) {
    if (!hasRecursiveFlag(invocation.name, invocation.args)) {
      continue;
    }
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
  if (!command) {
    return undefined;
  }

  const destructive = new Set(["format-volume", "clear-disk", "initialize-disk", "wipefs"]);
  for (const invocation of parseShellInvocations(command)) {
    const informationOnly = invocation.args.some((arg) =>
      ["--help", "-h", "/?", "--version", "-whatif"].includes(arg.toLowerCase()),
    );
    if (informationOnly) {
      continue;
    }
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
  if (!command) {
    return undefined;
  }

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

const BUILT_IN_TOOLS = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

const askMalformedBuiltInInput: PermissionRule = (context) => {
  const input = context.input as { path?: unknown; command?: unknown } | undefined;
  const needsPath =
    context.toolName === "read" || context.toolName === "edit" || context.toolName === "write";
  const needsCommand = context.toolName === "bash" || context.toolName === "powershell";
  if (
    (needsPath && (typeof input?.path !== "string" || input.path.trim() === "")) ||
    (needsCommand && (typeof input?.command !== "string" || input.command.trim() === ""))
  ) {
    return {
      ruleId: "input.unclassified",
      reason: "The built-in tool input could not be classified safely",
    };
  }
  return undefined;
};

const askSensitivePath: PermissionRule = (context) => {
  const input = context.input as { path?: unknown } | undefined;
  if (!["read", "edit", "write", "grep"].includes(context.toolName)) {
    return undefined;
  }
  if (typeof input?.path !== "string" || !isSensitivePath(input.path, context)) {
    return undefined;
  }
  return {
    ruleId: "path.sensitive",
    reason: `Access to sensitive path "${input.path}" requires confirmation`,
  };
};

const askOutsideWorkspaceWrite: PermissionRule = (context) => {
  if (context.toolName !== "edit" && context.toolName !== "write") {
    return undefined;
  }
  const path = (context.input as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || isInsideWorkspace(path, context)) {
    return undefined;
  }
  return {
    ruleId: "path.write-outside-workspace",
    reason: `Writing outside the workspace to "${path}" requires confirmation`,
  };
};

function isInformationOnly(args: readonly string[]): boolean {
  return args.some((arg) =>
    ["--help", "-h", "/?", "--version", "-whatif"].includes(arg.toLowerCase()),
  );
}

const askShellRisk: PermissionRule = (context) => {
  const command = shellCommand(context);
  if (!command) {
    return undefined;
  }

  if (hasRiskyOutputRedirection(command)) {
    return {
      ruleId: "shell.output-redirection",
      reason: "Shell output redirection can overwrite files and requires confirmation",
    };
  }

  const deletionCommands = new Set([
    "rm",
    "remove-item",
    "ri",
    "del",
    "erase",
    "rd",
    "rmdir",
    "unlink",
  ]);
  const permissionCommands = new Set(["chmod", "chown", "icacls", "takeown", "set-acl"]);
  const overwriteCommands = new Set(["set-content", "out-file", "clear-content"]);
  const fileAccessCommands = new Set([
    "cat",
    "type",
    "get-content",
    "gc",
    "grep",
    "select-string",
    "head",
    "tail",
    "more",
    "less",
    "set-content",
    "out-file",
    "clear-content",
  ]);

  for (const invocation of parseShellInvocations(command)) {
    if (isInformationOnly(invocation.args)) {
      continue;
    }
    if (invocation.wrappers.includes("sudo")) {
      return { ruleId: "shell.elevation", reason: "Privilege elevation requires confirmation" };
    }
    if (deletionCommands.has(invocation.name)) {
      return {
        ruleId: "shell.delete",
        reason: `File deletion by "${invocation.name}" requires confirmation`,
      };
    }
    if (permissionCommands.has(invocation.name)) {
      return {
        ruleId: "shell.change-permissions",
        reason: `Permission change by "${invocation.name}" requires confirmation`,
      };
    }
    if (overwriteCommands.has(invocation.name)) {
      return {
        ruleId: "shell.overwrite",
        reason: `File overwrite by "${invocation.name}" requires confirmation`,
      };
    }
    if (
      fileAccessCommands.has(invocation.name) &&
      invocation.args.some((arg) => !arg.startsWith("-") && isSensitivePath(arg, context))
    ) {
      return {
        ruleId: "shell.sensitive-path",
        reason: "Shell access to a sensitive path requires confirmation",
      };
    }
    if (invocation.name === "git") {
      const args = invocation.args.map((arg) => arg.toLowerCase());
      const operation = args[0];
      const force = args.some(
        (arg) => arg === "--force" || arg === "-f" || /^-[a-z]*f[a-z]*$/i.test(arg),
      );
      if (
        (operation === "reset" && args.includes("--hard")) ||
        (operation === "clean" && force) ||
        operation === "restore" ||
        (operation === "checkout" && args.includes("--")) ||
        (operation === "push" && (force || args.includes("--force-with-lease")))
      ) {
        return {
          ruleId: "shell.destructive-git",
          reason: `Destructive Git operation "${operation}" requires confirmation`,
        };
      }
    }
  }
  return undefined;
};

const askUnknownTool: PermissionRule = (context) => {
  if (BUILT_IN_TOOLS.has(context.toolName)) {
    return undefined;
  }
  return {
    ruleId: "tool.unknown",
    reason: `Unknown tool "${context.toolName}" requires confirmation`,
  };
};

export const ASK_RULES: readonly PermissionRule[] = [
  askMalformedBuiltInInput,
  askSensitivePath,
  askOutsideWorkspaceWrite,
  askShellRisk,
  askUnknownTool,
];
