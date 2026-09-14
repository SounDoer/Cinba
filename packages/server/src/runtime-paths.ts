import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
