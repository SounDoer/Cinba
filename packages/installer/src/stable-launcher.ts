import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type InstallationLayout, readCurrentRelease, releasePath } from "./installation-store.ts";
import { parsePayloadRelease } from "./payload-release.ts";
import type { ProductTarget } from "./platform.ts";

export type InstalledProductCommand = {
  releaseDirectory: string;
  executable: string;
  entry: string;
  arguments: string[];
};

async function requireRegularFile(path: string, description: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error(`${description} is not a regular file`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${description} is missing`, { cause: error });
    }
    throw error;
  }
}

export async function resolveInstalledProductCommand(options: {
  layout: InstallationLayout;
  target: ProductTarget;
  arguments: readonly string[];
}): Promise<InstalledProductCommand> {
  const current = await readCurrentRelease(options.layout);
  if (!current) {
    throw new Error("Cinba is not installed");
  }
  if (current.target !== options.target) {
    throw new Error(`installed ${current.target} release cannot run on ${options.target}`);
  }
  const releaseDirectory = releasePath(options.layout, current);
  const metadata = parsePayloadRelease(
    JSON.parse(await readFile(join(releaseDirectory, "release.json"), "utf8")) as unknown,
  );
  if (
    metadata.version !== current.version ||
    metadata.revision !== current.revision ||
    metadata.protocolVersion !== current.protocolVersion ||
    metadata.dataFormatVersion !== current.dataFormatVersion ||
    metadata.target !== current.target
  ) {
    throw new Error("active release metadata does not match the installation pointer");
  }
  const executable =
    options.target === "windows-x64"
      ? join(releaseDirectory, "runtime", "node.exe")
      : join(releaseDirectory, "runtime", "bin", "node");
  const entry = join(releaseDirectory, "lib", "cli.mjs");
  await Promise.all([
    requireRegularFile(executable, "active release runtime"),
    requireRegularFile(entry, "active release CLI"),
  ]);
  return {
    releaseDirectory,
    executable,
    entry,
    arguments: [entry, ...options.arguments],
  };
}

function childExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Cinba stopped by ${signal}`));
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

export async function runInstalledProductCommand(
  command: InstalledProductCommand,
  options: { workingDirectory?: string; environment?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  return await childExit(
    spawn(command.executable, command.arguments, {
      cwd: options.workingDirectory ?? process.cwd(),
      env: options.environment ?? process.env,
      stdio: "inherit",
      windowsHide: true,
    }),
  );
}
