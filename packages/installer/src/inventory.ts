import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { type ProductTarget, isProductTarget } from "./platform.ts";

export type InventoryFile = {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
};

export type InventoryLink = {
  path: string;
  target: string;
};

export type InventoryEntry = InventoryFile | InventoryLink;

export type ArtifactInventory = {
  schemaVersion: 1;
  product: "Cinba";
  version: string;
  revision: string;
  target: ProductTarget;
  files: InventoryEntry[];
};

export type InventoryProblem = {
  path: string;
  reason:
    | "missing"
    | "unexpected"
    | "not-file"
    | "not-symlink"
    | "symlink"
    | "target"
    | "size"
    | "sha256"
    | "executable";
};

export type InventoryVerification = {
  valid: boolean;
  problems: InventoryProblem[];
};

export type InventoryIdentity = Pick<ArtifactInventory, "version" | "revision" | "target">;

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], context: string): void {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(value).find((key) => !expectedSet.has(key));
  if (unknown) {
    throw new Error(`${context} contains unknown field ${unknown}`);
  }
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing) {
    throw new Error(`${context} is missing field ${missing}`);
  }
}

function safeRelativePath(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new Error(`${context} must be a normalized relative POSIX path`);
  }
  const parts = value.split("/");
  if (value.startsWith("/") || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${context} must be a normalized relative POSIX path`);
  }
  return value;
}

function safeLinkTarget(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value)
  ) {
    throw new Error(`${context} must be a relative POSIX symlink target`);
  }
  return value;
}

function parseEntry(value: unknown, index: number): InventoryEntry {
  const context = `inventory files[${index}]`;
  const parsed = record(value, context);
  if (Object.hasOwn(parsed, "target")) {
    exactKeys(parsed, ["path", "target"], context);
    return {
      path: safeRelativePath(parsed.path, `${context}.path`),
      target: safeLinkTarget(parsed.target, `${context}.target`),
    };
  }
  exactKeys(parsed, ["path", "size", "sha256", "executable"], context);
  const path = safeRelativePath(parsed.path, `${context}.path`);
  if (!Number.isSafeInteger(parsed.size) || (parsed.size as number) < 0) {
    throw new Error(`${context}.size must be a non-negative integer`);
  }
  if (typeof parsed.sha256 !== "string" || !SHA256.test(parsed.sha256)) {
    throw new Error(`${context}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (typeof parsed.executable !== "boolean") {
    throw new Error(`${context}.executable must be a boolean`);
  }
  return {
    path,
    size: parsed.size as number,
    sha256: parsed.sha256,
    executable: parsed.executable,
  };
}

export function parseArtifactInventory(value: unknown): ArtifactInventory {
  const parsed = record(value, "artifact inventory");
  exactKeys(
    parsed,
    ["schemaVersion", "product", "version", "revision", "target", "files"],
    "artifact inventory",
  );
  if (parsed.schemaVersion !== 1) {
    throw new Error("artifact inventory schemaVersion must be 1");
  }
  if (parsed.product !== "Cinba") {
    throw new Error('artifact inventory product must be "Cinba"');
  }
  if (typeof parsed.version !== "string" || !SEMVER.test(parsed.version)) {
    throw new Error("artifact inventory version must be SemVer without a leading v");
  }
  if (typeof parsed.revision !== "string" || !REVISION.test(parsed.revision)) {
    throw new Error("artifact inventory revision must be a full lowercase Git commit");
  }
  if (!isProductTarget(parsed.target)) {
    throw new Error("artifact inventory target is not a supported product target");
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error("artifact inventory files must be a non-empty array");
  }
  const files = parsed.files.map(parseEntry);
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1]!.path >= files[index]!.path) {
      throw new Error("artifact inventory files must be unique and sorted by path");
    }
  }
  return {
    schemaVersion: 1,
    product: "Cinba",
    version: parsed.version,
    revision: parsed.revision,
    target: parsed.target,
    files,
  };
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

type CollectedEntry = { path: string; kind: "file" | "symlink" };

async function collectEntries(
  root: string,
  directory: string,
  problems: InventoryProblem[],
): Promise<CollectedEntry[]> {
  const collected: CollectedEntry[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      collected.push({ path, kind: "symlink" });
    } else if (entry.isDirectory()) {
      collected.push(...(await collectEntries(root, absolute, problems)));
    } else if (entry.isFile()) {
      collected.push({ path, kind: "file" });
    } else {
      problems.push({ path, reason: "not-file" });
    }
  }
  return collected;
}

function linkStaysInside(root: string, linkPath: string, target: string): boolean {
  const resolvedTarget = resolve(dirname(linkPath), target);
  const fromRoot = relative(root, resolvedTarget);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}

function comparePaths(left: CollectedEntry, right: CollectedEntry): number {
  if (left.path < right.path) {
    return -1;
  }
  return left.path > right.path ? 1 : 0;
}

export async function createArtifactInventory(
  rootDirectory: string,
  identity: InventoryIdentity,
  options: { inventoryFileName?: string } = {},
): Promise<ArtifactInventory> {
  const root = resolve(rootDirectory);
  const inventoryFileName = options.inventoryFileName ?? "inventory.json";
  const structuralProblems: InventoryProblem[] = [];
  const entries = await collectEntries(root, root, structuralProblems);
  if (structuralProblems.length > 0) {
    const first = structuralProblems[0]!;
    throw new Error(`artifact contains unsupported ${first.reason} entry at ${first.path}`);
  }
  const files: InventoryEntry[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.path !== inventoryFileName)
    .toSorted(comparePaths)) {
    const absolute = resolve(root, ...entry.path.split("/"));
    if (entry.kind === "symlink") {
      const target = await readlink(absolute);
      if (!linkStaysInside(root, absolute, target)) {
        throw new Error(`artifact contains unsafe symlink entry at ${entry.path}`);
      }
      try {
        await stat(absolute);
      } catch {
        throw new Error(`artifact contains dangling symlink entry at ${entry.path}`);
      }
      files.push({ path: entry.path, target });
      continue;
    }
    const status = await lstat(absolute);
    files.push({
      path: entry.path,
      size: status.size,
      sha256: await sha256(absolute),
      executable: identity.target === "windows-x64" ? false : (status.mode & 0o111) !== 0,
    });
  }
  return parseArtifactInventory({
    schemaVersion: 1,
    product: "Cinba",
    ...identity,
    files,
  });
}

export async function verifyArtifactInventory(
  rootDirectory: string,
  inventory: ArtifactInventory,
  options: { inventoryFileName?: string; enforceExecutable?: boolean } = {},
): Promise<InventoryVerification> {
  const root = resolve(rootDirectory);
  const inventoryFileName = options.inventoryFileName ?? "inventory.json";
  const enforceExecutable = options.enforceExecutable ?? inventory.target !== "windows-x64";
  const problems: InventoryProblem[] = [];
  const actualEntries = await collectEntries(root, root, problems);
  const actualPaths = new Set(actualEntries.map((entry) => entry.path));
  actualPaths.delete(inventoryFileName);
  const expectedPaths = new Set(inventory.files.map((file) => file.path));

  for (const path of actualPaths) {
    if (!expectedPaths.has(path)) {
      problems.push({ path, reason: "unexpected" });
    }
  }

  for (const expected of inventory.files) {
    if (!actualPaths.has(expected.path)) {
      problems.push({ path: expected.path, reason: "missing" });
      continue;
    }
    const absolute = resolve(root, ...expected.path.split("/"));
    const status = await lstat(absolute);
    if ("target" in expected) {
      if (!status.isSymbolicLink()) {
        problems.push({ path: expected.path, reason: "not-symlink" });
        continue;
      }
      const target = await readlink(absolute);
      if (!linkStaysInside(root, absolute, target) || target !== expected.target) {
        problems.push({ path: expected.path, reason: "target" });
      }
      continue;
    }
    if (status.isSymbolicLink()) {
      problems.push({ path: expected.path, reason: "symlink" });
      continue;
    }
    if (!status.isFile()) {
      problems.push({ path: expected.path, reason: "not-file" });
      continue;
    }
    if (status.size !== expected.size) {
      problems.push({ path: expected.path, reason: "size" });
      continue;
    }
    if ((await sha256(absolute)) !== expected.sha256) {
      problems.push({ path: expected.path, reason: "sha256" });
    }
    if (enforceExecutable && ((status.mode & 0o111) !== 0) !== expected.executable) {
      problems.push({ path: expected.path, reason: "executable" });
    }
  }

  problems.sort((left, right) =>
    left.path === right.path
      ? left.reason.localeCompare(right.reason)
      : left.path.localeCompare(right.path),
  );
  return { valid: problems.length === 0, problems };
}
