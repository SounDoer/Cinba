import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  type ArtifactInventory,
  type InstalledRelease,
  type InventoryVerification,
  type ManagedServiceStatus,
  type ProductTarget,
  parseArtifactInventory,
  readCurrentRelease,
  requireProductTarget,
  resolveProductPaths,
  verifyArtifactInventory,
} from "@cinba/installer";
import { resolveProductPayloadLayout } from "./layout.ts";
import { inspectProductComponentMode } from "./managed-services.ts";
import { type ProductRelease, readProductRelease } from "./release.ts";

export type InstalledDiagnosticLevel = "pass" | "info" | "fail";
export type InstalledDiagnostic = {
  level: InstalledDiagnosticLevel;
  label: string;
  detail: string;
};
export type InstalledDoctorReport = {
  healthy: boolean;
  diagnostics: InstalledDiagnostic[];
};

export type InstalledDoctorEvidence = {
  release: ProductRelease;
  current: InstalledRelease | undefined;
  expectedTarget: ProductTarget;
  runtimeVersion: string;
  inventory: ArtifactInventory;
  inventoryVerification: InventoryVerification;
  core: ManagedServiceStatus | Error;
  sync: ManagedServiceStatus | Error;
};

function componentDiagnostic(
  name: "Core" | "Sync",
  status: ManagedServiceStatus | Error,
): InstalledDiagnostic {
  if (status instanceof Error) {
    return { level: "fail", label: name, detail: `inspection failed: ${status.message}` };
  }
  if (status.state === "not-created") {
    return { level: "info", label: name, detail: "not created" };
  }
  if (status.state === "not-installed") {
    return { level: "fail", label: name, detail: "product is not installed" };
  }
  if (status.phase === "failed") {
    return {
      level: "fail",
      label: name,
      detail: `${status.state}; service operation failed (${status.failure ?? "unknown"})`,
    };
  }
  if (status.state === "background" && (!status.registered || !status.running)) {
    return { level: "fail", label: name, detail: "Background is configured but not running" };
  }
  if (status.healthy === false) {
    return { level: "fail", label: name, detail: `${status.state}; health check failed` };
  }
  return {
    level: "pass",
    label: name,
    detail: status.state === "background" ? "Background is running" : `mode is ${status.state}`,
  };
}

export function diagnoseInstalledProduct(evidence: InstalledDoctorEvidence): InstalledDoctorReport {
  const identityMatches =
    evidence.inventory.version === evidence.release.version &&
    evidence.inventory.revision === evidence.release.revision &&
    evidence.inventory.target === evidence.release.target;
  const diagnostics: InstalledDiagnostic[] = [
    evidence.release.target === evidence.expectedTarget
      ? {
          level: "pass",
          label: "Platform",
          detail: evidence.expectedTarget,
        }
      : {
          level: "fail",
          label: "Platform",
          detail: `release ${evidence.release.target} cannot run on ${evidence.expectedTarget}`,
        },
    evidence.runtimeVersion === evidence.release.nodeVersion
      ? {
          level: "pass",
          label: "Runtime",
          detail: `bundled Node.js ${evidence.runtimeVersion}`,
        }
      : {
          level: "fail",
          label: "Runtime",
          detail: `running Node.js ${evidence.runtimeVersion}; release expects ${evidence.release.nodeVersion}`,
        },
    identityMatches && evidence.inventoryVerification.valid
      ? {
          level: "pass",
          label: "Payload",
          detail: `Cinba ${evidence.release.version} (${evidence.release.revision})`,
        }
      : {
          level: "fail",
          label: "Payload",
          detail: identityMatches
            ? `${evidence.inventoryVerification.problems.length} integrity problem(s)`
            : "release and inventory identities do not match",
        },
    evidence.current?.revision === evidence.release.revision
      ? {
          level: "pass",
          label: "Activation",
          detail: `current release ${evidence.current.version}`,
        }
      : {
          level: "fail",
          label: "Activation",
          detail: evidence.current
            ? `launcher resolved ${evidence.release.revision}, current points to ${evidence.current.revision}`
            : "current release pointer is missing",
        },
    componentDiagnostic("Core", evidence.core),
    componentDiagnostic("Sync", evidence.sync),
  ];
  return {
    healthy: diagnostics.every((diagnostic) => diagnostic.level !== "fail"),
    diagnostics,
  };
}

export async function runInstalledDoctor(
  payloadRoot: string,
  options: {
    platform?: "win32" | "darwin" | "linux";
    architecture?: NodeJS.Architecture;
    homeDirectory?: string;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<InstalledDoctorReport> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Cinba is not available on ${platform}`);
  }
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const paths = resolveProductPaths({ platform, homeDirectory, environment });
  const layout = resolveProductPayloadLayout(payloadRoot, platform);
  const release = await readProductRelease(layout.root);
  const inventory = parseArtifactInventory(
    JSON.parse(await readFile(layout.inventoryFile, "utf8")) as unknown,
  );
  const managerLayout = {
    programDirectory: paths.programDirectory,
    releasesDirectory: paths.releasesDirectory,
    transactionDirectory: paths.transactionDirectory,
    currentPointerDirectory: paths.currentPointerDirectory,
  };
  const inspect = async (component: "core" | "sync"): Promise<ManagedServiceStatus | Error> => {
    try {
      return await inspectProductComponentMode(component, {
        platform,
        homeDirectory,
        environment,
      });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  const [inventoryVerification, current, core, sync] = await Promise.all([
    verifyArtifactInventory(layout.root, inventory),
    readCurrentRelease(managerLayout),
    inspect("core"),
    inspect("sync"),
  ]);
  return diagnoseInstalledProduct({
    release,
    current,
    expectedTarget: requireProductTarget(platform, options.architecture ?? process.arch),
    runtimeVersion: process.versions.node,
    inventory,
    inventoryVerification,
    core,
    sync,
  });
}

export function formatInstalledDoctorReport(report: InstalledDoctorReport): string {
  return [
    "Cinba Doctor",
    ...report.diagnostics.map(
      (diagnostic) =>
        `[${diagnostic.level.toUpperCase()}] ${diagnostic.label}: ${diagnostic.detail}`,
    ),
    `Result: ${report.healthy ? "ready" : "problems found"}`,
  ].join("\n");
}
