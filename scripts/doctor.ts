import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CoreHealth, probeCoreHealth } from "@cinba/core-client";
import { type LocalCoreStatus, inspectLocalCore } from "@cinba/core-manager";
import { createDevelopmentCoreConfig } from "@cinba/product-runtime";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MINIMUM_NODE_MAJOR = 24;

export type DiagnosticLevel = "pass" | "info" | "fail";

export type Diagnostic = {
  level: DiagnosticLevel;
  label: string;
  detail: string;
};

export type DoctorReport = {
  healthy: boolean;
  diagnostics: Diagnostic[];
};

type PathKind = "file" | "directory" | "missing";

export type DoctorOptions = {
  projectDirectory: string;
  nodeVersion?: string;
  repositoryRoot?: string;
  serverUrl?: string;
  pathKind?: (path: string) => PathKind;
  inspectCore?: () => Promise<LocalCoreStatus>;
  probeCore?: (baseUrl: string) => Promise<CoreHealth | undefined>;
};

function defaultPathKind(path: string): PathKind {
  try {
    const stats = statSync(path);
    if (stats.isFile()) {
      return "file";
    }
    if (stats.isDirectory()) {
      return "directory";
    }
  } catch {
    // The diagnostic below reports all inaccessible and missing paths uniformly.
  }
  return "missing";
}

export function diagnoseNode(nodeVersion: string): Diagnostic {
  const major = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0] ?? "", 10);
  return Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR
    ? { level: "pass", label: "Runtime", detail: `Node.js ${nodeVersion}` }
    : {
        level: "fail",
        label: "Runtime",
        detail: `Node.js ${nodeVersion}; version ${MINIMUM_NODE_MAJOR} or newer is required`,
      };
}

export function diagnoseCheckout(
  repositoryRoot: string,
  pathKind: (path: string) => PathKind = defaultPathKind,
): Diagnostic {
  const required = [
    "package.json",
    join("scripts", "cinba.ts"),
    join("packages", "tui", "src", "index.ts"),
    join("packages", "server", "src", "index.ts"),
  ];
  const missing = required.filter((path) => pathKind(join(repositoryRoot, path)) !== "file");
  return missing.length === 0
    ? { level: "pass", label: "Checkout", detail: repositoryRoot }
    : {
        level: "fail",
        label: "Checkout",
        detail: `${repositoryRoot}; missing ${missing.join(", ")}`,
      };
}

export function diagnoseProject(
  projectDirectory: string,
  pathKind: (path: string) => PathKind = defaultPathKind,
): Diagnostic {
  const project = resolve(projectDirectory);
  return pathKind(project) === "directory"
    ? { level: "pass", label: "Project", detail: project }
    : { level: "fail", label: "Project", detail: `${project}; directory is not accessible` };
}

export function remoteHealthBaseUrl(serverUrl: string): string | undefined {
  try {
    const url = new URL(serverUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    } else if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function localCoreDiagnostic(status: LocalCoreStatus): Diagnostic {
  if (!status.running) {
    return {
      level: "info",
      label: "Core",
      detail: "local Core is stopped; a client will start it on demand",
    };
  }

  const ownership = status.managed
    ? `managed${status.pid === undefined ? "" : `, PID ${status.pid}`}`
    : "external";
  const revision = status.health?.revision ? `, revision ${status.health.revision}` : "";
  return {
    level: "pass",
    label: "Core",
    detail: `local Core is ${status.state} (${ownership})${revision}`,
  };
}

async function diagnoseCore(options: DoctorOptions): Promise<Diagnostic> {
  if (options.serverUrl) {
    const baseUrl = remoteHealthBaseUrl(options.serverUrl);
    if (!baseUrl) {
      return {
        level: "fail",
        label: "Core",
        detail: `CINBA_SERVER is not a valid WebSocket or HTTP URL: ${options.serverUrl}`,
      };
    }
    const health = await (options.probeCore ?? probeCoreHealth)(baseUrl);
    return health
      ? {
          level: "pass",
          label: "Core",
          detail: `configured Core is healthy at ${options.serverUrl}, revision ${health.revision}`,
        }
      : {
          level: "fail",
          label: "Core",
          detail: `configured Core is not reachable at ${options.serverUrl}`,
        };
  }

  const inspectCore =
    options.inspectCore ??
    (() =>
      inspectLocalCore(
        createDevelopmentCoreConfig(options.repositoryRoot ?? REPOSITORY_ROOT),
        options.probeCore ?? probeCoreHealth,
      ));
  try {
    return localCoreDiagnostic(await inspectCore());
  } catch (error) {
    return {
      level: "fail",
      label: "Core",
      detail: `local Core inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const pathKind = options.pathKind ?? defaultPathKind;
  const diagnostics = [
    diagnoseNode(options.nodeVersion ?? process.version),
    diagnoseCheckout(options.repositoryRoot ?? REPOSITORY_ROOT, pathKind),
    diagnoseProject(options.projectDirectory, pathKind),
    await diagnoseCore(options),
  ];
  return {
    healthy: diagnostics.every((diagnostic) => diagnostic.level !== "fail"),
    diagnostics,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "Cinba Doctor",
    ...report.diagnostics.map(
      (diagnostic) =>
        `[${diagnostic.level.toUpperCase()}] ${diagnostic.label}: ${diagnostic.detail}`,
    ),
    `Result: ${report.healthy ? "ready" : "problems found"}`,
  ];
  return lines.join("\n");
}
