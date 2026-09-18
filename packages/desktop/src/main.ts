// Keep application bootstrap separate from the tray and window surfaces so
// either can evolve without turning the Electron entry point into a controller.

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type IpcMainInvokeEvent, app, dialog, ipcMain } from "electron";
import {
  createDevelopmentCoreConfig,
  createProductCoreConfig,
  readProductRelease,
  resolveProductPaths,
} from "@cinba/product-runtime";
import type { ProfileInput } from "./desktop-api.ts";
import { authorizeDesktopIpcEvent } from "./desktop-ipc.ts";
import { resolveDesktopRuntime, startDesktopAutomaticUpdate } from "./desktop-runtime.ts";
import {
  checkDesktopUpdateReadiness,
  createDesktopInstallReadyUpdate,
  createDesktopReadinessPrompt,
  createDesktopUpdateConfirmation,
  launchDesktopUpdateHandoff,
} from "./desktop-update.ts";
import { createCoreProfileStore } from "./profile-store.ts";
import { type SystemTrayController, createSystemTrayController } from "./tray.ts";
import { type DesktopWindowController, createDesktopWindowController } from "./window.ts";

let tray: SystemTrayController | undefined;
let removeIpcHandlers: (() => void) | undefined;
let automaticUpdate: { abort(): void } | undefined;
const updateInstallAbort = new AbortController();
let openWhenReady = true;
const runtime = resolveDesktopRuntime({
  packaged: app.isPackaged,
  modulePath: fileURLToPath(import.meta.url),
  resourcesPath: process.resourcesPath,
  installedPayloadRoot: process.env.CINBA_PAYLOAD_ROOT,
});

const IPC_CHANNELS = [
  "desktop:get-state",
  "desktop:install-ready-update",
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

function registerDesktopIpc(
  window: DesktopWindowController,
  installReadyUpdate: () => Promise<void>,
): () => void {
  function authorize(event: IpcMainInvokeEvent): void {
    authorizeDesktopIpcEvent(event, window.ownsRendererFrame);
  }

  ipcMain.handle("desktop:get-state", (event) => {
    authorize(event);
    return window.getState();
  });
  ipcMain.handle("desktop:install-ready-update", async (event) => {
    authorize(event);
    await installReadyUpdate();
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
          ? createProductCoreConfig(runtime.payloadRoot, { release })
          : createDevelopmentCoreConfig(runtime.repositoryRoot);
      const profiles = createCoreProfileStore(join(localConfig.stateDirectory, "desktop.json"), {
        localLabel: process.platform === "darwin" ? "This Mac" : "This PC",
      });
      const window = createDesktopWindowController(profiles, localConfig, {
        productName: runtime.displayName,
        ...(release ? { expectedRevision: release.revision } : {}),
      });
      const platform = process.platform;
      if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
        throw new Error(`Cinba is not available on ${platform}`);
      }
      const paths = resolveProductPaths({
        platform,
        homeDirectory: homedir(),
        environment: process.env,
      });
      const startAutomaticUpdate = () => {
        if (runtime.identity !== "release" || !release) {
          return;
        }
        automaticUpdate = startDesktopAutomaticUpdate({
          runtime,
          release,
          paths,
          onUpdate: (update) => {
            window.setUpdate(update);
            tray?.setUpdate(update);
          },
        });
      };
      const installReadyUpdate = createDesktopInstallReadyUpdate({
        identity: runtime.identity,
        launcherPath: paths.launcherPath,
        processId: process.pid,
        signal: updateInstallAbort.signal,
        getUpdate: () => window.getState().update,
        confirm: async (version) => {
          const result = await dialog.showMessageBox(createDesktopUpdateConfirmation(version));
          return result.response === 0;
        },
        checkReadiness: (executable, version) =>
          checkDesktopUpdateReadiness(executable, version, {
            signal: updateInstallAbort.signal,
          }),
        promptReadiness: async (message, error) => {
          const result = await dialog.showMessageBox(createDesktopReadinessPrompt(message, error));
          return result.response === 0;
        },
        abortAutomaticUpdate: () => {
          automaticUpdate?.abort();
          automaticUpdate = undefined;
        },
        resumeAutomaticUpdate: startAutomaticUpdate,
        launch: (executable, arguments_) =>
          launchDesktopUpdateHandoff(executable, arguments_, {
            signal: updateInstallAbort.signal,
          }),
        quit: () => app.quit(),
        showError: async (message) => {
          await dialog.showMessageBox({
            type: "error",
            title: "Cinba Update Failed",
            message: "Cinba could not start the update.",
            detail: message,
          });
        },
      });
      removeIpcHandlers = registerDesktopIpc(window, installReadyUpdate);
      tray = await createSystemTrayController({
        openWindow: window.open,
        openManager: window.openManager,
        profiles,
        currentProfileId: () => window.getState().selectedProfileId,
        localConfig,
        productName: runtime.displayName,
        installReadyUpdate,
        ...(release ? { expectedRevision: release.revision } : {}),
      });
      if (runtime.identity === "release" && release) {
        startAutomaticUpdate();
      }
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
  updateInstallAbort.abort();
  automaticUpdate?.abort();
  removeIpcHandlers?.();
  tray?.dispose();
});
