import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type UpdateLock = {
  schemaVersion: 1;
  pid: number;
  token: string;
  phase: "owned" | "transferred" | "claimed";
};

export type ProductUpdateLease = {
  stateDirectory: string;
  token: string;
  transferTo: (processId: number) => Promise<void>;
  waitForClaim: (processId: number) => Promise<void>;
  cancelTransfer: (processId: number) => Promise<void>;
  release: () => Promise<void>;
};

async function readLock(path: string): Promise<UpdateLock | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<UpdateLock>;
    return parsed.schemaVersion === 1 &&
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0 &&
      (parsed.phase === "owned" || parsed.phase === "transferred" || parsed.phase === "claimed")
      ? (parsed as UpdateLock)
      : undefined;
  } catch {
    return undefined;
  }
}

async function replaceOwner(path: string, owner: UpdateLock): Promise<void> {
  const temporary = `${path}.${owner.token}.${owner.phase}`;
  try {
    await writeFile(temporary, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function defaultProcessIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function leaseFor(
  stateDirectory: string,
  ownerPath: string,
  token: string,
  processId: number,
): ProductUpdateLease {
  let released = false;
  let transferred = false;
  return {
    stateDirectory,
    token,
    transferTo: async (nextProcessId) => {
      if (released || transferred || !Number.isSafeInteger(nextProcessId) || nextProcessId < 1) {
        throw new Error("Cinba update lease transfer is invalid");
      }
      const owner = await readLock(ownerPath);
      if (owner?.token !== token || owner.pid !== processId || owner.phase !== "owned") {
        throw new Error("Cinba update lease is no longer owned by this process");
      }
      await replaceOwner(ownerPath, {
        schemaVersion: 1,
        pid: nextProcessId,
        token,
        phase: "transferred",
      });
      transferred = true;
    },
    waitForClaim: async (nextProcessId) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const owner = await readLock(ownerPath);
        if (owner?.token === token && owner.pid === nextProcessId && owner.phase === "claimed") {
          return;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      throw new Error("Cinba update helper did not claim its transferred lease");
    },
    cancelTransfer: async (nextProcessId) => {
      const owner = await readLock(ownerPath);
      if (
        owner?.token === token &&
        owner.pid === nextProcessId &&
        (owner.phase === "transferred" || owner.phase === "claimed")
      ) {
        await rm(resolve(ownerPath, ".."), { recursive: true, force: true });
      }
    },
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      const owner = await readLock(ownerPath);
      if (owner?.token === token && owner.pid === processId) {
        await rm(resolve(ownerPath, ".."), { recursive: true, force: true });
      }
    },
  };
}

export async function acquireProductUpdateLease(
  stateDirectory: string,
  options: {
    processId?: number;
    processIsAlive?: (processId: number) => boolean;
  } = {},
): Promise<ProductUpdateLease> {
  const state = resolve(stateDirectory);
  const path = join(state, "update-operation");
  const ownerPath = join(path, "owner.json");
  const token = randomUUID();
  const processId = options.processId ?? process.pid;
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  await mkdir(state, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(
        ownerPath,
        JSON.stringify({
          schemaVersion: 1,
          pid: processId,
          token,
          phase: "owned",
        } satisfies UpdateLock),
        { flag: "wx", mode: 0o600 },
      );
      return leaseFor(state, ownerPath, token, processId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = await readLock(ownerPath);
      if (!owner || processIsAlive(owner.pid)) {
        throw new Error("another Cinba update operation is active", { cause: error });
      }
      await rm(path, { recursive: true, force: true });
    }
  }
  throw new Error("could not acquire the Cinba update operation lock");
}

export async function claimTransferredProductUpdateLease(
  stateDirectory: string,
  token: string,
  options: {
    processId?: number;
    delay?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<ProductUpdateLease> {
  if (!token) {
    throw new Error("Cinba update lease claim token is invalid");
  }
  const state = resolve(stateDirectory);
  const ownerPath = join(state, "update-operation", "owner.json");
  const processId = options.processId ?? process.pid;
  const delay =
    options.delay ??
    ((milliseconds: number) =>
      new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    const owner = await readLock(ownerPath);
    if (owner?.token === token && owner.pid === processId && owner.phase === "transferred") {
      await replaceOwner(ownerPath, { ...owner, phase: "claimed" });
      return leaseFor(state, ownerPath, token, processId);
    }
    if (owner && owner.token !== token) {
      throw new Error("Cinba update lease claim token does not match its owner");
    }
    await delay(10);
  }
  throw new Error("Cinba update helper could not claim its transferred lease");
}

export async function runWithProductUpdateLease<T>(
  stateDirectory: string,
  operation: (lease: ProductUpdateLease) => Promise<T>,
  options: {
    acquire?: (stateDirectory: string) => Promise<ProductUpdateLease>;
  } = {},
): Promise<T> {
  const lease = await (options.acquire ?? acquireProductUpdateLease)(stateDirectory);
  let result: { value: T } | undefined;
  let operationError: unknown;
  try {
    result = { value: await operation(lease) };
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await lease.release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError && releaseError) {
    throw new AggregateError(
      [operationError, releaseError],
      "Cinba update failed and its lease could not be released",
      { cause: operationError },
    );
  }
  if (operationError) {
    throw operationError;
  }
  if (releaseError) {
    throw releaseError;
  }
  return result!.value;
}
