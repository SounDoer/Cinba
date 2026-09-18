import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { app, dialog } from "electron";
import { resolveInstalledDesktopEntry } from "./installed-desktop.ts";

async function launchInstalledDesktop(): Promise<void> {
  const installed = await resolveInstalledDesktopEntry({ homeDirectory: homedir() });
  process.env.CINBA_PAYLOAD_ROOT = installed.payloadRoot;
  await import(pathToFileURL(installed.entry).href);
}

if (import.meta.main) {
  launchInstalledDesktop().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Cinba could not start", message);
    app.quit();
  });
}
