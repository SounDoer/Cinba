import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { requireProductTarget } from "@cinba/installer";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const { inject } = require("postject") as {
  inject(
    executable: string,
    resourceName: string,
    resource: Buffer,
    options: { sentinelFuse: string; machoSegmentName?: string },
  ): Promise<void>;
};
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

export async function buildProductLauncher(): Promise<string> {
  const target = requireProductTarget();
  const outputDirectory = join(REPOSITORY_ROOT, "dist", "launcher", target);
  const workDirectory = join(outputDirectory, "work");
  const executable = join(outputDirectory, target === "windows-x64" ? "cinba.exe" : "cinba");
  const script = join(workDirectory, "launcher.cjs");
  const blob = join(workDirectory, "launcher.blob");
  const configuration = join(workDirectory, "sea-config.json");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(workDirectory, { recursive: true });

  await build({
    absWorkingDir: REPOSITORY_ROOT,
    entryPoints: ["scripts/product-launcher.ts"],
    outfile: script,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node24",
    define: {
      "import.meta.url": '"file:///cinba/launcher.cjs"',
      "import.meta.main": "false",
    },
    sourcemap: false,
    legalComments: "none",
  });
  await writeFile(
    configuration,
    `${JSON.stringify(
      {
        main: script,
        output: blob,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
      },
      null,
      2,
    )}\n`,
  );
  await execute(process.execPath, ["--experimental-sea-config", configuration], {
    cwd: workDirectory,
    windowsHide: true,
  });
  await copyFile(process.execPath, executable);

  if (target === "macos-arm64") {
    await execute("codesign", ["--remove-signature", executable]);
  }
  await inject(executable, "NODE_SEA_BLOB", await readFile(blob), {
    sentinelFuse: SEA_FUSE,
    ...(target === "macos-arm64" ? { machoSegmentName: "NODE_SEA" } : {}),
  });
  if (target === "macos-arm64") {
    await execute("codesign", ["--sign", "-", executable]);
  } else if (target === "linux-x64-gnu") {
    await chmod(executable, 0o755);
  }
  await rm(workDirectory, { recursive: true, force: true });
  return executable;
}

if (import.meta.main) {
  buildProductLauncher()
    .then((output) => console.log(`[launcher] Built ${output}`))
    .catch((error: unknown) => {
      console.error(`[launcher] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
