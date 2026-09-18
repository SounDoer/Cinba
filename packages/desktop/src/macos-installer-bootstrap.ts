import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, dialog } from "electron";

const PARENT_PROCESS_ID = "CINBA_MACOS_INSTALL_PARENT_PID";

async function startInstallation(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("the Cinba macOS installer can run only on macOS");
  }
  await app.whenReady();
  const result = await dialog.showMessageBox({
    type: "info",
    title: "Install Cinba",
    message: "Install Cinba for this user?",
    detail: "Cinba will be installed to ~/Applications/Cinba.app and then opened.",
    buttons: ["Install", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response !== 0) {
    app.quit();
    return;
  }

  const bundle = join(process.resourcesPath, "cinba-bundle");
  const launcher = join(bundle, "launcher", "cinba");
  const logDirectory = join(homedir(), "Library", "Logs", "com.soundoer.cinba");
  mkdirSync(logDirectory, { recursive: true });
  const log = openSync(join(logDirectory, "install.log"), "a", 0o600);
  try {
    const child = spawn(launcher, ["install"], {
      cwd: homedir(),
      detached: true,
      env: { ...process.env, [PARENT_PROCESS_ID]: String(process.pid) },
      stdio: ["ignore", log, log],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
  app.quit();
}

if (import.meta.main) {
  startInstallation().catch((error: unknown) => {
    dialog.showErrorBox(
      "Cinba installation failed",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  });
}
