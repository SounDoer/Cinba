// Keep application bootstrap separate from the tray and window surfaces so
// either can evolve without turning the Electron entry point into a controller.

import { join } from "node:path";
import { type IpcMainInvokeEvent, app, ipcMain } from "electron";
import { createLocalCoreConfig } from "@cinba/core-manager";
import type { ProfileInput } from "./desktop-api.ts";
import { createCoreProfileStore } from "./profile-store.ts";
import { createSyncProfileStore } from "./sync-profile-store.ts";
import { type SystemTrayController, createSystemTrayController } from "./tray.ts";
import { type DesktopWindowController, createDesktopWindowController } from "./window.ts";

let tray: SystemTrayController | undefined;
let removeIpcHandlers: (() => void) | undefined;
let openWhenReady = true;

const IPC_CHANNELS = [
  "desktop:get-state",
  "desktop:select-profile",
  "desktop:open-sync",
  "desktop:save-sync",
  "desktop:remove-sync",
  "desktop:open-sync-external",
  "desktop:retry",
  "desktop:open-manager",
  "desktop:add-profile",
  "desktop:update-profile",
  "desktop:remove-profile",
  "desktop:recover-profiles",
  "desktop:test-profile",
] as const;

function readProfileId(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("Invalid Core profile ID");
  }
  return value;
}

function readProfileInput(value: unknown): ProfileInput {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Core profile input");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.label !== "string" || typeof candidate.baseUrl !== "string") {
    throw new Error("Invalid Core profile input");
  }
  return { label: candidate.label, baseUrl: candidate.baseUrl };
}

function readSyncUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid Sync Server URL");
  }
  return value;
}

function registerDesktopIpc(window: DesktopWindowController): () => void {
  function authorize(event: IpcMainInvokeEvent): void {
    if (!window.ownsRenderer(event.sender.id)) {
      throw new Error("Untrusted Desktop IPC sender");
    }
  }

  ipcMain.handle("desktop:get-state", (event) => {
    authorize(event);
    return window.getState();
  });
  ipcMain.handle("desktop:select-profile", async (event, profileId: unknown) => {
    authorize(event);
    await window.open(readProfileId(profileId));
  });
  ipcMain.handle("desktop:open-sync", async (event) => {
    authorize(event);
    await window.openSync();
  });
  ipcMain.handle("desktop:save-sync", async (event, baseUrl: unknown) => {
    authorize(event);
    await window.saveSync(readSyncUrl(baseUrl));
  });
  ipcMain.handle("desktop:remove-sync", async (event) => {
    authorize(event);
    await window.removeSync();
  });
  ipcMain.handle("desktop:open-sync-external", async (event) => {
    authorize(event);
    await window.openSyncExternal();
  });
  ipcMain.handle("desktop:retry", async (event) => {
    authorize(event);
    await window.retry();
  });
  ipcMain.handle("desktop:open-manager", async (event) => {
    authorize(event);
    await window.openManager();
  });
  ipcMain.handle("desktop:add-profile", async (event, input: unknown) => {
    authorize(event);
    await window.addProfile(readProfileInput(input));
  });
  ipcMain.handle("desktop:update-profile", async (event, profileId: unknown, input: unknown) => {
    authorize(event);
    await window.updateProfile(readProfileId(profileId), readProfileInput(input));
  });
  ipcMain.handle("desktop:remove-profile", async (event, profileId: unknown) => {
    authorize(event);
    await window.removeProfile(readProfileId(profileId));
  });
  ipcMain.handle("desktop:recover-profiles", async (event) => {
    authorize(event);
    return await window.recoverProfiles();
  });
  ipcMain.handle("desktop:test-profile", async (event, input: unknown) => {
    authorize(event);
    return await window.testProfile(readProfileInput(input));
  });
  return () => {
    for (const channel of IPC_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
  };
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    openWhenReady = true;
    void tray?.openWindow();
  });

  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("Cinba");
      app.dock?.hide();
      const localConfig = createLocalCoreConfig();
      const profiles = createCoreProfileStore(join(localConfig.stateDirectory, "desktop.json"), {
        localLabel: process.platform === "darwin" ? "This Mac" : "This PC",
      });
      const syncProfile = createSyncProfileStore(
        join(localConfig.stateDirectory, "desktop-sync.json"),
      );
      const window = createDesktopWindowController(profiles, syncProfile);
      removeIpcHandlers = registerDesktopIpc(window);
      tray = await createSystemTrayController({
        openWindow: window.open,
        openManager: window.openManager,
        profiles,
        currentProfileId: () => window.getState().selectedProfileId,
      });
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
app.on("will-quit", () => {
  removeIpcHandlers?.();
  tray?.dispose();
});
