import { existsSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { PermissionContext } from "./types.ts";

function pathApi(context: PermissionContext): typeof posix | typeof win32 {
  return context.platform === "win32" ? win32 : posix;
}

function expandKnownLocation(value: string, context: PermissionContext): string {
  const normalized = value.trim();
  const homePrefixes = ["~", "$HOME", "${HOME}", "$env:USERPROFILE", "%USERPROFILE%"];
  for (const prefix of homePrefixes) {
    if (normalized.toLowerCase() === prefix.toLowerCase()) {
      return context.homeDir;
    }
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
    while (result.length > root.length && /[\\/]$/.test(result)) {
      result = result.slice(0, -1);
    }
    return context.platform === "win32" ? result.toLowerCase() : result;
  };
  return normalize(left) === normalize(right);
}

function canonicalPath(value: string, context: PermissionContext): string {
  const api = pathApi(context);
  const resolved = resolveLiteralPath(value, context);
  if (context.platform !== process.platform) {
    return resolved;
  }

  const missing: string[] = [];
  let existing = resolved;
  while (!existsSync(existing)) {
    const parent = api.dirname(existing);
    if (parent === existing) {
      return resolved;
    }
    missing.unshift(api.basename(existing));
    existing = parent;
  }

  try {
    return api.resolve(realpathSync.native(existing), ...missing);
  } catch {
    return resolved;
  }
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

export function isInsideWorkspace(value: string, context: PermissionContext): boolean {
  const api = pathApi(context);
  const target = canonicalPath(value, context);
  const relative = api.relative(canonicalPath(context.cwd, context), target);
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
}

export function isSensitivePath(value: string, context: PermissionContext): boolean {
  const api = pathApi(context);
  const candidates = [resolveLiteralPath(value, context), canonicalPath(value, context)];

  return candidates.some((candidate) => {
    const segments = candidate.split(/[\\/]/).filter(Boolean);
    const comparable =
      context.platform === "win32" ? segments.map((part) => part.toLowerCase()) : segments;
    const basename = comparable.at(-1) ?? "";

    const sensitiveDirectories = new Set([".ssh", ".aws", ".azure", ".gnupg", ".kube"]);
    if (comparable.some((part) => sensitiveDirectories.has(part.toLowerCase()))) {
      return true;
    }

    const sensitiveNames = new Set([
      ".npmrc",
      ".pypirc",
      ".netrc",
      "_netrc",
      "auth.json",
      "credentials",
      "credentials.json",
      "service-account.json",
      "service_account.json",
    ]);
    const name = basename.toLowerCase();
    if (name === ".env" || name.startsWith(".env.")) {
      return true;
    }
    if (sensitiveNames.has(name)) {
      return true;
    }
    if ([".pem", ".key", ".p12", ".pfx"].includes(api.extname(name).toLowerCase())) {
      return true;
    }

    const parent = comparable.at(-2)?.toLowerCase();
    return parent === ".git" && (name === "config" || name === "credentials");
  });
}
