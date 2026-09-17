import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstallationLayout } from "./installation-store.ts";

type LockRecord = { schemaVersion: 1; pid: number; token: string };

function lockPath(layout: InstallationLayout): string {
  return join(layout.transactionDirectory, "install.lock");
}

async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
    return parsed.schemaVersion === 1 &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
      ? (parsed as LockRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function acquireInstallationLock(
  layout: InstallationLayout,
  options: { processId?: number } = {},
): Promise<() => Promise<void>> {
  const path = lockPath(layout);
  const processId = options.processId ?? process.pid;
  const token = randomUUID();
  await mkdir(dirname(path), { recursive: true });

  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ schemaVersion: 1, pid: processId, token } satisfies LockRecord),
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("another Cinba installation transaction is active", { cause: error });
    }
    throw error;
  }
  return async () => {
    if ((await readLock(path))?.token === token) {
      await rm(path, { force: true });
    }
  };
}
