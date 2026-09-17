import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InstallationLayout } from "./installation-store.ts";

export type ProtectedDataRoot = {
  name: string;
  path: string;
};

export type DataSnapshot = {
  schemaVersion: 1;
  transactionId: string;
  createdAt: string;
  roots: { name: string; existed: boolean }[];
};

const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT_NAME = /^[a-z][a-z0-9-]{0,62}$/;

async function stat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function validateTransactionId(transactionId: string): void {
  if (!TRANSACTION_ID.test(transactionId)) {
    throw new Error("data snapshot transactionId must be a UUID");
  }
}

function validateRoots(layout: InstallationLayout, roots: readonly ProtectedDataRoot[]): void {
  if (roots.length === 0) {
    throw new Error("at least one protected data root is required");
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const root of roots) {
    if (!ROOT_NAME.test(root.name)) {
      throw new Error(`protected data root name ${root.name} is not safe`);
    }
    if (names.has(root.name)) {
      throw new Error(`protected data root name ${root.name} is duplicated`);
    }
    names.add(root.name);
    if (!isAbsolute(root.path)) {
      throw new Error(`protected data root ${root.name} must be absolute`);
    }
    const path = resolve(root.path);
    if (dirname(path) === path) {
      throw new Error(`protected data root ${root.name} cannot be a filesystem root`);
    }
    if (paths.has(path)) {
      throw new Error(`protected data root path ${path} is duplicated`);
    }
    paths.add(path);
    if (
      path === resolve(layout.programDirectory) ||
      isInside(layout.programDirectory, path) ||
      isInside(path, layout.programDirectory) ||
      path === resolve(layout.transactionDirectory) ||
      isInside(layout.transactionDirectory, path) ||
      isInside(path, layout.transactionDirectory)
    ) {
      throw new Error(`protected data root ${root.name} overlaps installer-owned storage`);
    }
  }
  const resolved = [...paths];
  for (let left = 0; left < resolved.length; left += 1) {
    for (let right = left + 1; right < resolved.length; right += 1) {
      if (isInside(resolved[left], resolved[right]) || isInside(resolved[right], resolved[left])) {
        throw new Error("protected data roots must not overlap each other");
      }
    }
  }
}

function snapshotRoot(layout: InstallationLayout): string {
  return join(resolve(layout.transactionDirectory), "snapshots");
}

export function dataSnapshotPath(layout: InstallationLayout, transactionId: string): string {
  validateTransactionId(transactionId);
  return join(snapshotRoot(layout), transactionId);
}

export async function dataSnapshotExists(
  layout: InstallationLayout,
  transactionId: string,
): Promise<boolean> {
  return (await stat(dataSnapshotPath(layout, transactionId))) !== undefined;
}

function parseSnapshot(value: unknown, transactionId: string): DataSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("data snapshot manifest must be an object");
  }
  const parsed = value as Record<string, unknown>;
  const expected = ["schemaVersion", "transactionId", "createdAt", "roots"];
  const unknown = Object.keys(parsed).find((key) => !expected.includes(key));
  if (unknown || expected.some((key) => !Object.hasOwn(parsed, key))) {
    throw new Error("data snapshot manifest fields are invalid");
  }
  if (parsed.schemaVersion !== 1 || parsed.transactionId !== transactionId) {
    throw new Error("data snapshot manifest identity is invalid");
  }
  if (
    typeof parsed.createdAt !== "string" ||
    Number.isNaN(Date.parse(parsed.createdAt)) ||
    !parsed.createdAt.endsWith("Z")
  ) {
    throw new Error("data snapshot createdAt must be an ISO UTC timestamp");
  }
  if (!Array.isArray(parsed.roots)) {
    throw new Error("data snapshot roots must be an array");
  }
  const names = new Set<string>();
  const roots = parsed.roots.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("data snapshot root must be an object");
    }
    const root = entry as Record<string, unknown>;
    if (
      Object.keys(root).length !== 2 ||
      !Object.hasOwn(root, "name") ||
      !Object.hasOwn(root, "existed") ||
      typeof root.name !== "string" ||
      !ROOT_NAME.test(root.name) ||
      typeof root.existed !== "boolean" ||
      names.has(root.name)
    ) {
      throw new Error("data snapshot root fields are invalid");
    }
    names.add(root.name);
    return { name: root.name, existed: root.existed };
  });
  return {
    schemaVersion: 1,
    transactionId,
    createdAt: parsed.createdAt,
    roots,
  };
}

async function readSnapshot(
  layout: InstallationLayout,
  transactionId: string,
): Promise<DataSnapshot> {
  const directory = dataSnapshotPath(layout, transactionId);
  return parseSnapshot(
    JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8")) as unknown,
    transactionId,
  );
}

export async function createDataSnapshot(options: {
  layout: InstallationLayout;
  transactionId: string;
  roots: readonly ProtectedDataRoot[];
  now?: () => Date;
}): Promise<DataSnapshot> {
  validateRoots(options.layout, options.roots);
  const destination = dataSnapshotPath(options.layout, options.transactionId);
  const temporary = join(
    snapshotRoot(options.layout),
    `.${options.transactionId}.${randomUUID()}.tmp`,
  );
  await mkdir(snapshotRoot(options.layout), { recursive: true, mode: 0o700 });
  if (await stat(destination)) {
    throw new Error("data snapshot already exists for this transaction");
  }
  await mkdir(temporary, { mode: 0o700 });
  try {
    const roots: DataSnapshot["roots"] = [];
    for (const root of options.roots) {
      const source = await stat(root.path);
      if (source && (!source.isDirectory() || source.isSymbolicLink())) {
        throw new Error(`protected data root ${root.name} must be a real directory`);
      }
      roots.push({ name: root.name, existed: source !== undefined });
      if (source) {
        await cp(root.path, join(temporary, root.name), {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: false,
        });
      }
    }
    const snapshot: DataSnapshot = {
      schemaVersion: 1,
      transactionId: options.transactionId,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      roots,
    };
    await writeFile(join(temporary, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
    return snapshot;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreDataSnapshot(options: {
  layout: InstallationLayout;
  transactionId: string;
  roots: readonly ProtectedDataRoot[];
}): Promise<void> {
  validateRoots(options.layout, options.roots);
  const snapshot = await readSnapshot(options.layout, options.transactionId);
  if (
    snapshot.roots.length !== options.roots.length ||
    snapshot.roots.some((root, index) => root.name !== options.roots[index]?.name)
  ) {
    throw new Error("protected data roots do not match the snapshot manifest");
  }
  const directory = dataSnapshotPath(options.layout, options.transactionId);
  const moved: { root: ProtectedDataRoot; backup: string | undefined }[] = [];
  try {
    for (const [index, root] of options.roots.entries()) {
      const current = await stat(root.path);
      if (current && (!current.isDirectory() || current.isSymbolicLink())) {
        throw new Error(`protected data root ${root.name} must be a real directory`);
      }
      const backup = current
        ? join(dirname(root.path), `.${basename(root.path)}.cinba-restore-${options.transactionId}`)
        : undefined;
      if (backup) {
        if (await stat(backup)) {
          throw new Error(`protected data restore backup already exists for ${root.name}`);
        }
        await rename(root.path, backup);
      }
      moved.push({ root, backup });
      if (snapshot.roots[index].existed) {
        await cp(join(directory, root.name), root.path, {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: false,
        });
      }
    }
  } catch (restoreError) {
    const rollbackErrors: unknown[] = [];
    for (const entry of moved.toReversed()) {
      try {
        await rm(entry.root.path, { recursive: true, force: true });
        if (entry.backup) {
          await rename(entry.backup, entry.root.path);
        }
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      const combined = new Error("data snapshot restore and its rollback both failed", {
        cause: restoreError,
      });
      Object.assign(combined, { rollbackErrors });
      throw combined;
    }
    throw restoreError;
  }
  for (const entry of moved) {
    if (entry.backup) {
      await rm(entry.backup, { recursive: true, force: true });
    }
  }
}

export async function discardDataSnapshot(
  layout: InstallationLayout,
  transactionId: string,
): Promise<void> {
  await rm(dataSnapshotPath(layout, transactionId), { recursive: true, force: true });
}
