import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArtifactInventory,
  requireProductTarget,
  verifyArtifactInventory,
} from "@cinba/installer";
import { readProductRelease, resolveProductPayloadLayout } from "@cinba/product-runtime";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not reserve a Core smoke-test port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function capture(executable: string, arguments_: string[], cwd: string): Promise<string> {
  const child = spawn(executable, arguments_, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) {
        reject(new Error(`payload command stopped by ${signal}`));
      } else {
        resolvePromise(exitCode ?? 0);
      }
    });
  });
  if (code !== 0) {
    throw new Error(`payload command exited with ${code}\n${stderr}`);
  }
  return stdout.trim();
}

async function stop(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }
  process.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => process.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
  }
}

async function waitForCore(
  process: ChildProcess,
  port: number,
  expectedRevision: string,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      throw new Error(`packaged Core exited before becoming healthy\n${diagnostics()}`);
    }
    try {
      const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as {
        status?: unknown;
        revision?: unknown;
        safeToRestart?: unknown;
      };
      if (
        health.status === "ok" &&
        health.revision === expectedRevision &&
        health.safeToRestart === true
      ) {
        const web = await fetch(`http://127.0.0.1:${port}/`);
        if (!web.ok || !(await web.text()).includes('<div id="root"></div>')) {
          throw new Error("packaged Core did not serve the packaged Web application");
        }
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("packaged Core")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`packaged Core did not become healthy within 15 seconds\n${diagnostics()}`);
}

export async function verifyProductPayload(): Promise<void> {
  const target = requireProductTarget();
  const payload = join(REPOSITORY_ROOT, "dist", "product", target);
  const layout = resolveProductPayloadLayout(payload);
  const inventory = parseArtifactInventory(
    JSON.parse(await readFile(join(payload, "inventory.json"), "utf8")),
  );
  const verification = await verifyArtifactInventory(payload, inventory);
  if (!verification.valid) {
    throw new Error(
      `payload inventory verification failed: ${JSON.stringify(verification.problems)}`,
    );
  }

  const release = await readProductRelease(payload);
  if (release.target !== target) {
    throw new Error(`payload target ${release.target} does not match current target ${target}`);
  }

  const temporary = await mkdtemp(join(tmpdir(), "cinba-payload-probe-"));
  const port = await unusedPort();
  const node = layout.nodeExecutable;
  const version = await capture(node, [layout.cliEntry, "--version"], temporary);
  if (version !== `Cinba ${release.version} (${release.revision})`) {
    throw new Error(`packaged CLI returned an unexpected identity: ${version}`);
  }
  let stdout = "";
  let stderr = "";
  const core = spawn(node, [layout.coreEntry], {
    cwd: payload,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CINBA_CORE_LIFETIME: "persistent",
      CINBA_EXTENSION_ROOT: layout.extensionRoot,
      CINBA_PORT: String(port),
      CINBA_REVISION: release.revision,
      CINBA_STATE_DIR: join(temporary, "data"),
      CINBA_WEB_ROOT: layout.webRoot,
      PI_CODING_AGENT_DIR: join(temporary, "pi-agent"),
    },
  });
  core.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  core.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  try {
    await waitForCore(core, port, release.revision, () => `${stdout}\n${stderr}`.trim());
  } finally {
    await stop(core);
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  verifyProductPayload()
    .then(() => console.log("[payload] Inventory, Core, and Web verification passed"))
    .catch((error: unknown) => {
      console.error(`[payload] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
