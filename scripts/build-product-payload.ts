import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  PRODUCT_DATA_FORMAT_VERSION,
  PRODUCT_PROTOCOL_VERSION,
  type ProductTarget,
  createArtifactInventory,
  requireProductTarget,
  verifyArtifactInventory,
} from "@cinba/installer";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRODUCT_DIST = join(REPOSITORY_ROOT, "dist", "product");

type RootPackage = { version?: unknown };

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function gitRevision(): string {
  const revision = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  })
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("Git did not return a full product revision");
  }
  return revision;
}

async function productVersion(): Promise<string> {
  const parsed = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
  ) as RootPackage;
  if (
    typeof parsed.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(parsed.version)
  ) {
    throw new Error("root package.json must contain the product SemVer");
  }
  return parsed.version;
}

async function findPackageRoot(specifier: string): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.resolve(specifier)));
  while (directory !== dirname(directory)) {
    try {
      const parsed = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (parsed.name === specifier) {
        return directory;
      }
    } catch {
      // Keep walking from the resolved entry to its owning package.
    }
    directory = dirname(directory);
  }
  throw new Error(`could not locate installed package ${specifier}`);
}

const NATIVE_DEPENDENCIES: Record<
  ProductTarget,
  { esbuild: string; clipboard: string; tui: readonly string[] }
> = {
  "windows-x64": {
    esbuild: "win32-x64",
    clipboard: "clipboard-win32-x64-msvc",
    tui: ["win32", "prebuilds", "win32-x64"],
  },
  "macos-arm64": {
    esbuild: "darwin-arm64",
    clipboard: "clipboard-darwin-arm64",
    tui: ["darwin", "prebuilds", "darwin-arm64"],
  },
  "linux-x64-gnu": {
    esbuild: "linux-x64",
    clipboard: "clipboard-linux-x64-gnu",
    tui: [],
  },
};

async function keepDirectories(directory: string, names: ReadonlySet<string>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !names.has(entry.name)) {
      await rm(join(directory, entry.name), { recursive: true, force: true });
    }
  }
}

async function copyPiRuntime(payload: string, productTarget: ProductTarget): Promise<void> {
  const source = await findPackageRoot("@earendil-works/pi-coding-agent");
  const target = join(payload, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(target, { recursive: true });
  await Promise.all([
    cp(join(source, "dist"), join(target, "dist"), { recursive: true }),
    cp(join(source, "package.json"), join(target, "package.json")),
    cp(join(source, "node_modules"), join(target, "node_modules"), { recursive: true }),
  ]);
  const native = NATIVE_DEPENDENCIES[productTarget];
  await keepDirectories(join(target, "node_modules", "@esbuild"), new Set([native.esbuild]));
  await keepDirectories(
    join(target, "node_modules", "@mariozechner"),
    new Set(["clipboard", native.clipboard, "photon-node"]),
  );

  const copiedTui = join(target, "node_modules", "@earendil-works", "pi-tui", "native");
  await rm(copiedTui, { recursive: true, force: true });
  if (native.tui.length > 0) {
    const tuiTarget = join(copiedTui, ...native.tui);
    await mkdir(dirname(tuiTarget), { recursive: true });
    await cp(
      join(source, "node_modules", "@earendil-works", "pi-tui", "native", ...native.tui),
      tuiTarget,
      { recursive: true },
    );
  }
}

async function copyTuiNative(payload: string, productTarget: ProductTarget): Promise<void> {
  const native = NATIVE_DEPENDENCIES[productTarget];
  if (native.tui.length === 0) {
    return;
  }
  const source = await findPackageRoot("@earendil-works/pi-tui");
  const target = join(payload, "native", ...native.tui);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(source, "native", ...native.tui), target, { recursive: true });
}

async function copyNodeRuntime(payload: string): Promise<void> {
  if (process.release.name !== "node") {
    throw new Error("payloads must be built by the standalone Node runtime");
  }
  const target =
    process.platform === "win32"
      ? join(payload, "runtime", "node.exe")
      : join(payload, "runtime", "bin", "node");
  await mkdir(dirname(target), { recursive: true });
  await cp(process.execPath, target);
  if (process.platform !== "win32") {
    const current = await stat(target);
    await chmod(target, current.mode | 0o755);
  }
}

async function buildEntries(payload: string): Promise<void> {
  const shared = {
    absWorkingDir: REPOSITORY_ROOT,
    bundle: true,
    format: "esm" as const,
    platform: "node" as const,
    target: "node24",
    sourcemap: false,
    legalComments: "none" as const,
    logLevel: "info" as const,
    banner: {
      js: 'import { createRequire as __cinbaCreateRequire } from "node:module"; const require = __cinbaCreateRequire(import.meta.url);',
    },
  };
  await build({
    ...shared,
    entryPoints: {
      cli: "packages/product-runtime/src/cli.ts",
      core: "packages/server/src/index.ts",
      sync: "packages/sync-server/src/service-entry.ts",
      tui: "packages/tui/src/index.ts",
    },
    entryNames: "[name]",
    outExtension: { ".js": ".mjs" },
    outdir: join(payload, "lib"),
    external: ["@earendil-works/pi-coding-agent"],
  });
  await build({
    ...shared,
    entryPoints: {
      "permission-gate": "packages/extensions/src/permission-gate.ts",
      "session-edit": "packages/extensions/src/session-edit.ts",
      "web-tools": "packages/extensions/src/web-tools.ts",
    },
    entryNames: "[name]",
    outExtension: { ".js": ".mjs" },
    outdir: join(payload, "extensions"),
  });
}

async function buildDesktopPayload(payload: string, target: ProductTarget): Promise<void> {
  if (target === "linux-x64-gnu") {
    return;
  }
  await mkdir(join(payload, "lib"), { recursive: true });
  await Promise.all([
    build({
      absWorkingDir: REPOSITORY_ROOT,
      entryPoints: ["packages/desktop/src/main.ts"],
      outfile: join(payload, "lib", "desktop.mjs"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      external: ["electron"],
      sourcemap: false,
      legalComments: "none",
    }),
    cp(
      join(REPOSITORY_ROOT, "packages", "desktop", "src", "desktop-preload.cjs"),
      join(payload, "lib", "desktop-preload.cjs"),
    ),
    cp(join(REPOSITORY_ROOT, "packages", "desktop", "dist"), join(payload, "dist"), {
      recursive: true,
    }),
  ]);
}

export async function buildProductPayload(): Promise<string> {
  const target = requireProductTarget();
  const output = join(PRODUCT_DIST, target);
  if (!inside(join(REPOSITORY_ROOT, "dist"), output)) {
    throw new Error("product output must stay inside the repository dist directory");
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  await Promise.all([
    buildEntries(output),
    cp(join(REPOSITORY_ROOT, "packages", "web", "dist"), join(output, "web"), {
      recursive: true,
    }),
    cp(join(REPOSITORY_ROOT, "packages", "sync-web", "dist"), join(output, "sync-web"), {
      recursive: true,
    }),
    copyPiRuntime(output, target),
    copyTuiNative(output, target),
    copyNodeRuntime(output),
    buildDesktopPayload(output, target),
  ]);

  const version = await productVersion();
  const revision = gitRevision();
  await writeFile(
    join(output, "release.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: "Cinba",
        version,
        revision,
        protocolVersion: PRODUCT_PROTOCOL_VERSION,
        dataFormatVersion: PRODUCT_DATA_FORMAT_VERSION,
        target,
        nodeVersion: process.versions.node,
      },
      null,
      2,
    )}\n`,
  );
  const inventory = await createArtifactInventory(output, { version, revision, target });
  await writeFile(join(output, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  const verification = await verifyArtifactInventory(output, inventory);
  if (!verification.valid) {
    throw new Error(
      `generated payload failed inventory verification: ${JSON.stringify(verification.problems)}`,
    );
  }
  return output;
}

if (import.meta.main) {
  buildProductPayload()
    .then((output) => console.log(`[payload] Built and verified ${output}`))
    .catch((error: unknown) => {
      console.error(`[payload] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
