// Keep application bootstrap separate from the tray and window surfaces so
// either can evolve without turning the Electron entry point into a controller.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type IpcMainInvokeEvent, app, ipcMain } from "electron";
import {
  createDevelopmentCoreConfig,
  createProductCoreConfig,
  readProductRelease,
} from "@cinba/product-runtime";
import type { ProfileInput } from "./desktop-api.ts";
import { resolveDesktopRuntime } from "./desktop-runtime.ts";
import { createCoreProfileStore } from "./profile-store.ts";
import { type SystemTrayController, createSystemTrayController } from "./tray.ts";
import { type DesktopWindowController, createDesktopWindowController } from "./window.ts";

let tray: SystemTrayController | undefined;
let removeIpcHandlers: (() => void) | undefined;
let openWhenReady = true;
const runtime = resolveDesktopRuntime({
  packaged: app.isPackaged,
  modulePath: fileURLToPath(import.meta.url),
  resourcesPath: process.resourcesPath,
  installedPayloadRoot: process.env.CINBA_PAYLOAD_ROOT,
});

const IPC_CHANNELS = [
  "desktop:get-state",
  "desktop:select-profile",
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
app.setName(runtime.displayName);
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
      app.setAppUserModelId(runtime.applicationId);
      app.dock?.hide();
      const release =
        runtime.identity === "release" ? await readProductRelease(runtime.payloadRoot) : undefined;
      const localConfig =
        runtime.identity === "release"
          ? createProductCoreConfig(runtime.payloadRoot)
          : createDevelopmentCoreConfig(runtime.repositoryRoot);
      const profiles = createCoreProfileStore(join(localConfig.stateDirectory, "desktop.json"), {
        localLabel: process.platform === "darwin" ? "This Mac" : "This PC",
      });
      const window = createDesktopWindowController(profiles, localConfig, {
        productName: runtime.displayName,
        ...(release ? { expectedRevision: release.revision } : {}),
      });
      removeIpcHandlers = registerDesktopIpc(window);
      tray = await createSystemTrayController({
        openWindow: window.open,
        openManager: window.openManager,
        profiles,
        currentProfileId: () => window.getState().selectedProfileId,
        localConfig,
        productName: runtime.displayName,
        ...(release ? { expectedRevision: release.revision } : {}),
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
