import { rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve, win32 } from "node:path";
import {
  PRODUCT_IDENTITIES,
  type ProductPaths,
  type ResolveProductPathsOptions,
  resolveProductPaths,
} from "./paths.ts";

export type PurgeAuthorization =
  { kind: "interactive-confirmed" } | { kind: "non-interactive"; deleteAllCinbaData: true };

export type UninstallRequest =
  { mode: "normal" } | { mode: "purge"; authorization: PurgeAuthorization };

export type UninstallTargetKind =
  | "program"
  | "release-storage"
  | "manager"
  | "runtime-state"
  | "cache"
  | "logs"
  | "launcher"
  | "persistent-data"
  | "configuration";

export type UninstallTarget = {
  kind: UninstallTargetKind;
  path: string;
};

export type UninstallPlan = {
  schemaVersion: 1;
  identity: ProductPaths["identity"];
  mode: UninstallRequest["mode"];
  targets: UninstallTarget[];
  preserved: { kind: "persistent-data" | "configuration"; path: string }[];
  /** Cinba-owned directories that hold targets; each is removed after them only if left empty. */
  emptyParents: string[];
};

export type UninstallResult = {
  removed: UninstallTarget[];
  failed: { target: UninstallTarget; error: unknown }[];
};

type PathImplementation = typeof posix;

function inside(paths: PathImplementation, parent: string, child: string): boolean {
  const path = paths.relative(paths.resolve(parent), paths.resolve(child));
  return (
    path !== "" && path !== ".." && !path.startsWith(`..${paths.sep}`) && !paths.isAbsolute(path)
  );
}

function validateProductPath(paths: PathImplementation, path: string, field: string): string {
  if (!paths.isAbsolute(path)) {
    throw new Error(`${field} must be an absolute path`);
  }
  const normalized = paths.resolve(path);
  if (paths.dirname(normalized) === normalized) {
    throw new Error(`${field} cannot be a filesystem root`);
  }
  return normalized;
}

function validateNativePath(path: string, field: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${field} must be an absolute path`);
  }
  const normalized = resolve(path);
  if (dirname(normalized) === normalized) {
    throw new Error(`${field} cannot be a filesystem root`);
  }
  return normalized;
}

function compactTargets(
  paths: PathImplementation,
  targets: readonly UninstallTarget[],
): UninstallTarget[] {
  const unique = new Map<string, UninstallTarget>();
  for (const target of targets) {
    unique.set(paths.resolve(target.path), { ...target, path: paths.resolve(target.path) });
  }
  return [...unique.values()].filter(
    (target, _index, all) =>
      !all.some(
        (candidate) => candidate.path !== target.path && inside(paths, candidate.path, target.path),
      ),
  );
}

export function createUninstallPlan(
  pathOptions: ResolveProductPathsOptions,
  request: UninstallRequest,
): UninstallPlan {
  if (request.mode !== "normal" && request.mode !== "purge") {
    throw new Error("uninstall mode is not supported");
  }
  if (request.mode === "purge") {
    const authorization = request.authorization;
    if (
      authorization?.kind !== "interactive-confirmed" &&
      !(authorization?.kind === "non-interactive" && authorization.deleteAllCinbaData === true)
    ) {
      throw new Error("purge requires dedicated delete-all-data authorization");
    }
  }
  const paths = resolveProductPaths(pathOptions);
  const pathImplementation = pathOptions.platform === "win32" ? win32 : posix;
  const checked = {
    program: validateProductPath(pathImplementation, paths.programDirectory, "programDirectory"),
    releases: validateProductPath(pathImplementation, paths.releasesDirectory, "releasesDirectory"),
    manager: validateProductPath(pathImplementation, paths.managerDirectory, "managerDirectory"),
    state: validateProductPath(pathImplementation, paths.stateDirectory, "stateDirectory"),
    cache: validateProductPath(pathImplementation, paths.cacheDirectory, "cacheDirectory"),
    logs: validateProductPath(pathImplementation, paths.logDirectory, "logDirectory"),
    launcher: validateProductPath(pathImplementation, paths.launcherPath, "launcherPath"),
    data: validateProductPath(pathImplementation, paths.dataDirectory, "dataDirectory"),
    configuration: validateProductPath(
      pathImplementation,
      paths.configurationDirectory,
      "configurationDirectory",
    ),
  };
  if (!inside(pathImplementation, paths.launcherDirectory, checked.launcher)) {
    throw new Error("launcherPath must be inside launcherDirectory");
  }
  // Data sits in a directory of its own on every platform, which on Windows and macOS also holds
  // state, logs, or releases. Only that directory is owned; the shared directory above it is not.
  const productRoot = validateProductPath(
    pathImplementation,
    pathImplementation.dirname(checked.data),
    "product root",
  );
  const definition = PRODUCT_IDENTITIES[paths.identity];
  const ownedNames: readonly string[] = [
    definition.directoryName,
    definition.slug,
    definition.applicationId,
  ];
  if (!ownedNames.includes(pathImplementation.basename(productRoot))) {
    throw new Error("dataDirectory must be inside a Cinba-owned directory");
  }

  const targets: UninstallTarget[] = [
    { kind: "program", path: checked.program },
    { kind: "release-storage", path: checked.releases },
    { kind: "manager", path: checked.manager },
    { kind: "runtime-state", path: checked.state },
    { kind: "cache", path: checked.cache },
    { kind: "logs", path: checked.logs },
    { kind: "launcher", path: checked.launcher },
  ];
  if (request.mode === "purge") {
    targets.push(
      { kind: "persistent-data", path: checked.data },
      { kind: "configuration", path: checked.configuration },
    );
  }
  return {
    schemaVersion: 1,
    identity: paths.identity,
    mode: request.mode,
    targets: compactTargets(pathImplementation, targets),
    preserved:
      request.mode === "normal"
        ? [
            { kind: "persistent-data", path: checked.data },
            { kind: "configuration", path: checked.configuration },
          ]
        : [],
    emptyParents: [productRoot],
  };
}

// Windows can keep program files locked for a while after Desktop's processes exit, while images
// unmap and antivirus scans finish. Node's own retries compound at every directory level of a
// deep tree, so the program is retried here instead, with backoff, for about 30 seconds.
const PROGRAM_REMOVAL_WAIT_MS = 30_000;
const PROGRAM_REMOVAL_MAX_DELAY_MS = 2_000;

async function removeProgram(
  path: string,
  remove: typeof rm,
  delay: (milliseconds: number) => Promise<void>,
): Promise<void> {
  let waited = 0;
  for (let next = 100; ; next = Math.min(next * 2, PROGRAM_REMOVAL_MAX_DELAY_MS)) {
    try {
      await remove(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (waited >= PROGRAM_REMOVAL_WAIT_MS) {
        throw error;
      }
    }
    await delay(next);
    waited += next;
  }
}

export async function executeUninstallPlan(
  plan: UninstallPlan,
  remove: typeof rm = rm,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((wake) => setTimeout(wake, milliseconds)),
): Promise<UninstallResult> {
  const result: UninstallResult = { removed: [], failed: [] };
  // The launcher is last so a platform-specific helper can keep managing the rest of the plan.
  // Runtime state holds the installation lock, so it goes just before the launcher: an installer
  // waiting on that lock must not start while program files are still being removed.
  const lastKinds: UninstallTargetKind[] = ["runtime-state", "launcher"];
  const order = (target: UninstallTarget): number => lastKinds.indexOf(target.kind);
  const targets = plan.targets.toSorted((left, right) => order(left) - order(right));
  for (const target of targets) {
    try {
      const path = validateNativePath(target.path, `uninstall target ${target.kind}`);
      if (target.kind === "program") {
        await removeProgram(path, remove, delay);
      } else {
        await remove(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
      result.removed.push(target);
    } catch (error) {
      result.failed.push({ target, error });
    }
  }
  for (const parent of plan.emptyParents) {
    try {
      // rmdir removes only an empty directory, so preserved data or a failure log keeps it.
      await rmdir(validateNativePath(parent, "uninstall parent"));
    } catch {
      // Not empty, already gone, or still in use; it held nothing the plan was asked to remove.
    }
  }
  return result;
}
