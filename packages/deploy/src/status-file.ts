import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type DeploymentStatus,
  parseDeploymentStatus,
  stringifyDeploymentStatus,
} from "./status.ts";

export async function readDeploymentStatus(path: string): Promise<DeploymentStatus | undefined> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(`Deployment status file is not valid JSON: ${path}`);
  }
  const status = parseDeploymentStatus(raw);
  if (!status) {
    throw new Error(`Deployment status file has an invalid shape: ${path}`);
  }
  return status;
}

/** Write beside the destination and rename only after the complete file is durable. */
export async function writeDeploymentStatus(path: string, status: DeploymentStatus): Promise<void> {
  const body = stringifyDeploymentStatus(status);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(body, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
