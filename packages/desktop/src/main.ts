// Keep application bootstrap separate from the tray and window surfaces so
// either can evolve without turning the Electron entry point into a controller.

import { app } from "electron";
import { type SystemTrayController, createSystemTrayController } from "./tray.ts";
import { createDesktopWindowController } from "./window.ts";

let tray: SystemTrayController | undefined;
let openWhenReady = !process.argv.includes("--tray-only");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, arguments_) => {
    if (arguments_.includes("--tray-only")) {
      return;
    }
    openWhenReady = true;
    void tray?.openWindow();
  });

  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("Cinba");
      app.dock?.hide();
      const window = createDesktopWindowController();
      tray = await createSystemTrayController({ openWindow: window.open });
      if (openWhenReady) {
        await tray.openWindow();
      }
    })
    .catch((error: unknown) => {
      console.error(`[desktop] ${error instanceof Error ? error.message : String(error)}`);
      app.quit();
    });
}

app.on("window-all-closed", () => {});
app.on("will-quit", () => tray?.dispose());
