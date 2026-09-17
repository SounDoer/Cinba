import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
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
};

function inside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function validatePath(path: string, field: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${field} must be an absolute path`);
  }
  const normalized = resolve(path);
  if (dirname(normalized) === normalized) {
    throw new Error(`${field} cannot be a filesystem root`);
  }
  return normalized;
}

function compactTargets(targets: readonly UninstallTarget[]): UninstallTarget[] {
  const unique = new Map<string, UninstallTarget>();
  for (const target of targets) {
    unique.set(resolve(target.path), { ...target, path: resolve(target.path) });
  }
  return [...unique.values()].filter(
    (target, _index, all) =>
      !all.some(
        (candidate) => candidate.path !== target.path && inside(candidate.path, target.path),
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
  const checked = {
    program: validatePath(paths.programDirectory, "programDirectory"),
    manager: validatePath(paths.managerDirectory, "managerDirectory"),
    state: validatePath(paths.stateDirectory, "stateDirectory"),
    cache: validatePath(paths.cacheDirectory, "cacheDirectory"),
    logs: validatePath(paths.logDirectory, "logDirectory"),
    launcher: validatePath(paths.launcherPath, "launcherPath"),
    data: validatePath(paths.dataDirectory, "dataDirectory"),
    configuration: validatePath(paths.configurationDirectory, "configurationDirectory"),
  };
  if (!inside(paths.launcherDirectory, checked.launcher)) {
    throw new Error("launcherPath must be inside launcherDirectory");
  }

  const targets: UninstallTarget[] = [
    { kind: "program", path: checked.program },
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
    targets: compactTargets(targets),
    preserved:
      request.mode === "normal"
        ? [
            { kind: "persistent-data", path: checked.data },
            { kind: "configuration", path: checked.configuration },
          ]
        : [],
  };
}
