import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the private state owned by one Core instance without changing HOME. */
export function resolveCinbaStateDirectory(
  configured = process.env.CINBA_STATE_DIR,
  homeDirectory = homedir(),
): string {
  if (configured === undefined || configured.trim() === "") {
    return join(homeDirectory, ".cinba");
  }
  if (!isAbsolute(configured)) {
    throw new Error("CINBA_STATE_DIR must be an absolute path");
  }
  return resolve(configured);
}

export function resolveWebRoot(
  configured = process.env.CINBA_WEB_ROOT,
  moduleUrl = import.meta.url,
): string {
  if (configured !== undefined && configured.trim() !== "") {
    if (!isAbsolute(configured)) {
      throw new Error("CINBA_WEB_ROOT must be an absolute path");
    }
    return resolve(configured);
  }
  return join(dirname(fileURLToPath(moduleUrl)), "..", "..", "web", "dist");
}
