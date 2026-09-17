import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstallationLayout } from "./installation-store.ts";

type LockRecord = { schemaVersion: 1; pid: number; token: string };

function lockPath(layout: InstallationLayout): string {
  return join(layout.transactionDirectory, "install.lock");
}

function acquisitionPath(layout: InstallationLayout): string {
  return join(layout.transactionDirectory, "lock-acquisition");
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

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireAcquisitionMutex(
  layout: InstallationLayout,
  processId: number,
): Promise<() => Promise<void>> {
  const path = acquisitionPath(layout);
  const ownerPath = join(path, "owner.json");
  const token = randomUUID();
  await mkdir(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path);
      await writeFile(
        ownerPath,
        JSON.stringify({ schemaVersion: 1, pid: processId, token } satisfies LockRecord),
        { flag: "wx", mode: 0o600 },
      );
      return async () => {
        if ((await readLock(ownerPath))?.token === token) {
          await rm(path, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = await readLock(ownerPath);
      if (!owner || processIsAlive(owner.pid)) {
        throw new Error("another Cinba installation lock acquisition is active", {
          cause: error,
        });
      }
      await rm(path, { recursive: true, force: true });
    }
  }
  throw new Error("could not acquire the Cinba installation lock");
}

export async function acquireInstallationLock(
  layout: InstallationLayout,
  options: { processId?: number } = {},
): Promise<() => Promise<void>> {
  const path = lockPath(layout);
  const processId = options.processId ?? process.pid;
  const token = randomUUID();
  const releaseAcquisition = await acquireAcquisitionMutex(layout, processId);

  try {
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = await readLock(path);
      if (!owner || processIsAlive(owner.pid)) {
        throw new Error("another Cinba installation transaction is active", { cause: error });
      }
      await rm(path);
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ schemaVersion: 1, pid: processId, token } satisfies LockRecord),
        );
      } finally {
        await handle.close();
      }
    }
  } finally {
    await releaseAcquisition();
  }
  return async () => {
    if ((await readLock(path))?.token === token) {
      await rm(path, { force: true });
    }
  };
}
