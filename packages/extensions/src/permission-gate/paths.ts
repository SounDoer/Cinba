import { posix, win32 } from "node:path";
import type { PermissionContext } from "./types.ts";

function pathApi(context: PermissionContext): typeof posix | typeof win32 {
  return context.platform === "win32" ? win32 : posix;
}

function expandKnownLocation(value: string, context: PermissionContext): string {
  const normalized = value.trim();
  const homePrefixes = ["~", "$HOME", "${HOME}", "$env:USERPROFILE", "%USERPROFILE%"];
  for (const prefix of homePrefixes) {
    if (normalized.toLowerCase() === prefix.toLowerCase()) return context.homeDir;
    const remainder = normalized.slice(prefix.length);
    if (
      normalized.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase() &&
      (remainder.startsWith("/") || remainder.startsWith("\\"))
    ) {
      return `${context.homeDir}${remainder}`;
    }
  }
  return normalized;
}

export function resolveLiteralPath(value: string, context: PermissionContext): string {
  const api = pathApi(context);
  const expanded = expandKnownLocation(value, context);
  return api.normalize(api.isAbsolute(expanded) ? expanded : api.resolve(context.cwd, expanded));
}

export function samePath(left: string, right: string, context: PermissionContext): boolean {
  const api = pathApi(context);
  const normalize = (value: string) => {
    let result = api.normalize(value);
    const root = api.parse(result).root;
    while (result.length > root.length && /[\\/]$/.test(result)) result = result.slice(0, -1);
    return context.platform === "win32" ? result.toLowerCase() : result;
  };
  return normalize(left) === normalize(right);
}

export function protectedRoots(context: PermissionContext): string[] {
  const api = pathApi(context);
  const roots = [api.parse(context.cwd).root, context.cwd, context.homeDir];

  if (context.platform === "win32") {
    const systemRoot = context.systemRoot || "C:\\Windows";
    const drive = api.parse(systemRoot).root || "C:\\";
    roots.push(
      systemRoot,
      api.join(drive, "Program Files"),
      api.join(drive, "Program Files (x86)"),
      api.join(drive, "ProgramData"),
    );
  } else {
    roots.push("/etc", "/usr", "/var", "/bin", "/sbin", "/boot", "/System", "/Library");
  }

  return roots;
}

export function isProtectedRoot(value: string, context: PermissionContext): boolean {
  let resolved: string;
  try {
    resolved = resolveLiteralPath(value, context);
  } catch {
    return false;
  }
  return protectedRoots(context).some((root) => samePath(resolved, root, context));
}
