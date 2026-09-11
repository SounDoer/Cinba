export type PermissionEffect = "allow" | "ask" | "block";

export type PermissionContext = {
  toolName: string;
  input: unknown;
  cwd: string;
  homeDir: string;
  platform: NodeJS.Platform;
  systemRoot?: string;
};

export type PermissionDecision = {
  effect: PermissionEffect;
  ruleId: string;
  reason: string;
};

export type PermissionRule = (
  context: PermissionContext,
) => Omit<PermissionDecision, "effect"> | undefined;
