// Own the process orchestration shared by Cinba's product CLI and npm commands.
//
// Usage:
//   node scripts/launch.ts start
//   node scripts/launch.ts dev
//   node scripts/launch.ts tui [working-directory]
//   node scripts/launch.ts desktop

import { type ChildProcess, spawn } from "node:child_process";
import { connect } from "node:net";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLocalCore } from "@cinba/core-manager";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CORE_ENTRY = join(REPOSITORY_ROOT, "packages", "server", "src", "index.ts");
const TUI_ENTRY = join(REPOSITORY_ROOT, "packages", "tui", "src", "index.ts");
const WEB_ROOT = join(REPOSITORY_ROOT, "packages", "web");
const DESKTOP_ROOT = join(REPOSITORY_ROOT, "packages", "desktop");
const VITE_ENTRY = join(REPOSITORY_ROOT, "node_modules", "vite", "bin", "vite.js");
const ELECTRON_CLI = join(REPOSITORY_ROOT, "node_modules", "electron", "cli.js");

const STABLE_CORE_PORT = 4517;
const DEV_CORE_PORT = 4518;
const WEB_PORT = 5173;
const STABLE_CORE_URL = `http://127.0.0.1:${STABLE_CORE_PORT}/`;
const DEV_CORE_URL = `http://127.0.0.1:${DEV_CORE_PORT}/`;
const DEV_URL = `http://127.0.0.1:${WEB_PORT}/`;
const READY_TIMEOUT_MS = 30_000;

type Mode = "start" | "desktop" | "dev" | "tui";

const children = new Set<ChildProcess>();
let stopping = false;

function run(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; managed?: boolean } = {},
): ChildProcess {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: options.env,
    stdio: "inherit",
    windowsHide: true,
  });

  if (options.managed !== false) {
    children.add(child);
    child.once("exit", () => children.delete(child));
  }

  return child;
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    if (child.signalCode !== null) {
      if (stopping) {
        resolve(0);
      } else {
        reject(new Error(`process stopped by ${child.signalCode}`));
      }
      return;
    }

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal && !stopping) {
        reject(new Error(`process stopped by ${signal}`));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

async function runToCompletion(args: string[], cwd = REPOSITORY_ROOT): Promise<void> {
  const code = await waitForExit(run(args, { cwd }));
  if (code !== 0) {
    throw new Error(`process exited with code ${code}`);
  }
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function requireFreePort(port: number, purpose: string): Promise<void> {
  if (await isPortOpen(port)) {
    throw new Error(`port ${port} is already in use; stop the existing ${purpose} first`);
  }
}

async function waitUntilReachable(url: string, processName: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error(`${processName} did not become reachable within 30 seconds`);
}

export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function createDevelopmentEnvironment(
  homeDirectory = homedir(),
  machineName = hostname(),
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const stateDirectory = join(homeDirectory, ".cinba", "dev");
  return {
    ...environment,
    CINBA_CORE_LIFETIME: "persistent",
    CINBA_DEFAULT_CORE_NAME: `${machineName} Dev`,
    CINBA_PORT: String(DEV_CORE_PORT),
    CINBA_STATE_DIR: stateDirectory,
    PI_CODING_AGENT_DIR: join(stateDirectory, "pi-agent"),
  };
}

async function openBrowser(url: string): Promise<void> {
  if (process.env.CINBA_NO_BROWSER === "1") {
    return;
  }

  const plan = browserOpenCommand(url);
  await new Promise<void>((resolve, reject) => {
    const opener = spawn(plan.command, plan.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    opener.once("error", reject);
    opener.once("spawn", () => {
      opener.unref();
      resolve();
    });
  });
}

async function stopChildren(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;

  const exits = [...children].map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  );

  await Promise.race([Promise.all(exits), new Promise((resolve) => setTimeout(resolve, 3_000))]);
}

function installSignalHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopChildren().finally(() => process.exit(0));
    });
  }
}

async function withLaunchLifecycle(operation: () => Promise<void>): Promise<void> {
  installSignalHandlers();
  try {
    await operation();
  } catch (error) {
    await stopChildren();
    throw error;
  }
}

export async function launchWeb(): Promise<void> {
  await withLaunchLifecycle(async () => {
    console.log("[launcher] Building the web application...");
    await runToCompletion([VITE_ENTRY, "build"], WEB_ROOT);

    console.log("[launcher] Ensuring the shared local Core is running...");
    await ensureLocalCore();
    await openBrowser(STABLE_CORE_URL);
    console.log(`[launcher] Cinba is ready at ${STABLE_CORE_URL}`);
  });
}

export async function launchDevelopment(): Promise<void> {
  await withLaunchLifecycle(async () => {
    await requireFreePort(DEV_CORE_PORT, "Cinba development core service");
    await requireFreePort(WEB_PORT, "Vite development server");

    console.log("[launcher] Starting isolated Dev Core watch mode and Vite hot reload...");
    const environment = createDevelopmentEnvironment();
    const core = run(["--watch", CORE_ENTRY], { env: environment });
    const web = run([VITE_ENTRY, "--host", "127.0.0.1"], {
      cwd: WEB_ROOT,
      env: environment,
    });

    await Promise.all([
      waitUntilReachable(DEV_CORE_URL, "Cinba development core service"),
      waitUntilReachable(DEV_URL, "Vite development server"),
    ]);
    await openBrowser(DEV_URL);
    console.log(`[launcher] Development mode is ready at ${DEV_URL}`);
    console.log("[launcher] Press Ctrl+C once to stop Core and Vite.");

    const first = await Promise.race([
      waitForExit(core).then((code) => ({ name: "Core", code })),
      waitForExit(web).then((code) => ({ name: "Vite", code })),
    ]);
    if (!stopping) {
      throw new Error(`${first.name} exited with code ${first.code}; stopping development mode`);
    }
  });
}

export async function launchTui(workingDirectory: string | undefined): Promise<void> {
  await withLaunchLifecycle(async () => {
    if (!process.env.CINBA_SERVER) {
      console.log("[launcher] Ensuring the shared local Core is running...");
      await ensureLocalCore();
    }

    const cwd = workingDirectory ? join(workingDirectory) : process.cwd();
    console.log(`[launcher] Cinba terminal, working in: ${cwd}`);
    const code = await waitForExit(run([TUI_ENTRY], { cwd, managed: false }));
    if (code !== 0) {
      throw new Error(`Cinba terminal exited with code ${code}`);
    }
  });
}

export async function launchDesktop(): Promise<void> {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error("Cinba Desktop is available only on Windows and macOS");
  }
  await withLaunchLifecycle(async () => {
    console.log("[launcher] Building the web application...");
    await runToCompletion([VITE_ENTRY, "build"], WEB_ROOT);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [ELECTRON_CLI, DESKTOP_ROOT], {
        cwd: REPOSITORY_ROOT,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  });
}

function readMode(value: string | undefined): Mode {
  if (value === "start" || value === "desktop" || value === "dev" || value === "tui") {
    return value;
  }
  throw new Error("usage: node scripts/launch.ts <start|desktop|dev|tui> [working-directory]");
}

async function main(): Promise<void> {
  const mode = readMode(process.argv[2]);

  if (mode === "start") {
    await launchWeb();
  }
  if (mode === "desktop") {
    await launchDesktop();
  }
  if (mode === "dev") {
    await launchDevelopment();
  }
  if (mode === "tui") {
    await launchTui(process.argv[3]);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[launcher] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
