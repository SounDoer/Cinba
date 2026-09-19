import {
  type LocalCoreConfig,
  type LocalCoreStatus,
  ensureLocalCore,
  normalizeLocalCoreLifetime,
  stopLocalCore,
} from "@cinba/core-manager";
import type { ProductUpdateViewModel } from "@cinba/product-runtime";
import { createDesktopUpdatePresentation } from "./desktop-api.ts";
import type { DesktopUninstallMode } from "./desktop-uninstall.ts";
import type { CoreProfile } from "./profiles.ts";
import type { CoreProfileStore } from "./profile-store.ts";

const STATUS_INTERVAL_MS = 2_000;
const STOPPED: LocalCoreStatus = { state: "stopped", running: false, managed: false };

export type TrayOperation = "starting" | "stopping";
export type TrayIconTone = "stopped" | "running" | "busy" | "error";

export type TrayViewModel = {
  tooltip: string;
  iconTone: TrayIconTone;
  statusLabel: string;
  detailLabels: string[];
  canStart: boolean;
  canStop: boolean;
  updateAction?: { label: string; enabled: boolean };
};

export type SystemTrayController = {
  openWindow(profileId?: string): Promise<void>;
  setUpdate(update: ProductUpdateViewModel): void;
  dispose(): void;
};

export type CoreMenuItem = { profileId: string; label: string; selected: boolean };

export function createTrayUpdateMenuItem(
  action: TrayViewModel["updateAction"],
  installReadyUpdate: () => void,
): { label: string; enabled: boolean; click: () => void } | undefined {
  if (!action) {
    return undefined;
  }
  return {
    ...action,
    click: () => {
      if (action.enabled) {
        installReadyUpdate();
      }
    },
  };
}

/** Only an installed Desktop can remove the product; purge stays a separate, explicit entry. */
export function createTrayUninstallMenuItem(
  uninstall: ((mode: DesktopUninstallMode) => void) | undefined,
): { label: string; submenu: { label: string; click: () => void }[] } | undefined {
  if (!uninstall) {
    return undefined;
  }
  return {
    label: "Uninstall",
    submenu: [
      { label: "Uninstall Cinba…", click: () => uninstall("normal") },
      { label: "Uninstall and Delete All Data…", click: () => uninstall("purge") },
    ],
  };
}

export function createCoreMenuItems(
  profiles: CoreProfile[],
  selectedProfileId: string,
): CoreMenuItem[] {
  return profiles.map((profile) => ({
    profileId: profile.id,
    label: profile.label,
    selected: profile.id === selectedProfileId,
  }));
}

const ICON_COLORS: Record<TrayIconTone, readonly [red: number, green: number, blue: number]> = {
  stopped: [125, 133, 144],
  running: [45, 164, 78],
  busy: [191, 135, 0],
  error: [207, 34, 46],
};

/** Build a Windows BGRA bitmap: a status-coloured disc with a white C. */
export function createTrayBitmap(tone: TrayIconTone, size = 16): Buffer {
  const bitmap = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const outerRadius = size * 0.47;
  const letterOuterRadius = size * 0.3;
  const letterInnerRadius = size * 0.18;
  const [red, green, blue] = ICON_COLORS[tone];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      if (distance > outerRadius) {
        continue;
      }

      const offset = (y * size + x) * 4;
      const isLetter =
        distance >= letterInnerRadius &&
        distance <= letterOuterRadius &&
        !(x + 0.5 > center && Math.abs(y + 0.5 - center) < size * 0.15);
      bitmap[offset] = isLetter ? 255 : blue;
      bitmap[offset + 1] = isLetter ? 255 : green;
      bitmap[offset + 2] = isLetter ? 255 : red;
      bitmap[offset + 3] = 255;
    }
  }

  return bitmap;
}

export function createTrayViewModel(
  status: LocalCoreStatus,
  operation?: TrayOperation,
  error?: string,
  productName: "Cinba" | "Cinba Dev" = "Cinba Dev",
  update?: ProductUpdateViewModel,
): TrayViewModel {
  const detailLabels: string[] = [];
  const updatePresentation = createDesktopUpdatePresentation(productName, update);
  const updateView = updatePresentation.hidden
    ? {}
    : {
        updateAction: {
          label:
            update?.phase === "ready"
              ? `Install Cinba ${update.candidateVersion} and Restart…`
              : updatePresentation.label,
          enabled: updatePresentation.actionable,
        },
      };
  if (status.pid !== undefined) {
    detailLabels.push(`PID: ${status.pid}`);
  }
  if (status.clientCount !== undefined) {
    detailLabels.push(`Clients: ${status.clientCount}`);
  }
  if (status.managed && status.lifetime) {
    detailLabels.push(
      status.lifetime === "persistent"
        ? "Availability: legacy persistent mode"
        : "Availability: stops after 10 idle minutes",
    );
  }
  if (status.running && status.safeToStop === false) {
    detailLabels.push("Core is busy; stopping will drain current work");
  }
  if (error) {
    detailLabels.push(`Error: ${error}`);
  }

  if (operation) {
    const action = operation === "starting" ? "starting" : "stopping";
    return {
      tooltip: `${productName} Local Core: ${action}`,
      iconTone: error ? "error" : "busy",
      statusLabel: `Local Core: ${action}`,
      detailLabels,
      canStart: false,
      canStop: false,
      ...updateView,
    };
  }

  if (!status.running) {
    return {
      tooltip: error
        ? `${productName} Local Core: status error`
        : `${productName} Local Core: stopped`,
      iconTone: error ? "error" : "stopped",
      statusLabel: "Local Core: stopped",
      detailLabels,
      canStart: true,
      canStop: false,
      ...updateView,
    };
  }

  const external = !status.managed;
  let state = "running";
  let iconTone: TrayIconTone = "running";
  if (status.state === "draining") {
    state = "draining";
    iconTone = "busy";
  } else if (external) {
    state = "external";
  }
  if (error) {
    iconTone = "error";
  }
  return {
    tooltip: error
      ? `${productName} Local Core: status error`
      : `${productName} Local Core: ${state}`,
    iconTone,
    statusLabel: `Local Core: ${state}`,
    detailLabels,
    canStart: false,
    canStop: status.managed && status.state !== "draining",
    ...updateView,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Create the platform tray/menu-bar entry lazily so state mapping stays Node-testable. */
export async function createSystemTrayController(options: {
  openWindow: (profileId?: string) => Promise<void>;
  openManager: () => Promise<void>;
  profiles: CoreProfileStore;
  currentProfileId: () => string;
  localConfig: LocalCoreConfig;
  expectedRevision?: string;
  productName?: "Cinba" | "Cinba Dev";
  installReadyUpdate: () => Promise<void>;
  uninstall?: (mode: DesktopUninstallMode) => Promise<void>;
}): Promise<SystemTrayController> {
  const { Menu, Tray, app, nativeImage, shell } = await import("electron");
  let status = STOPPED;
  let operation: TrayOperation | undefined;
  let recentError: string | undefined;
  let refreshInFlight = false;
  let update: ProductUpdateViewModel | undefined;

  function createTrayIcon(tone: TrayIconTone) {
    const icon = nativeImage.createFromBitmap(createTrayBitmap(tone), {
      width: 16,
      height: 16,
      scaleFactor: 1,
    });
    if (icon.isEmpty()) {
      throw new Error("Failed to create the Cinba tray icon bitmap");
    }
    if (process.platform === "darwin") {
      icon.setTemplateImage(true);
    }
    return icon;
  }

  const tray = new Tray(createTrayIcon("stopped"));

  function render(): void {
    const productName = options.productName ?? "Cinba Dev";
    const view = createTrayViewModel(status, operation, recentError, productName, update);
    tray.setImage(createTrayIcon(view.iconTone));
    tray.setToolTip(view.tooltip);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${productName}`, enabled: !operation, click: () => void openWindow() },
        {
          label: "Open Core",
          submenu: createCoreMenuItems(options.profiles.list(), options.currentProfileId()).map(
            (item) => ({
              label: item.label,
              type: "radio" as const,
              checked: item.selected,
              click: () => void openWindow(item.profileId),
            }),
          ),
        },
        { label: "Manage Cores…", click: () => void options.openManager() },
        { type: "separator" },
        ...[
          createTrayUpdateMenuItem(view.updateAction, () => void options.installReadyUpdate()),
        ].filter((item) => item !== undefined),
        { label: view.statusLabel, enabled: false },
        ...view.detailLabels.map((label) => ({ label, enabled: false }) as const),
        { type: "separator" },
        { label: "Start Local Core", enabled: view.canStart, click: () => void startCore() },
        {
          label: "Stop Local Core Gracefully",
          enabled: view.canStop,
          click: () => void stopCore(),
        },
        {
          label: "Refresh Local Core Status",
          enabled: !operation,
          click: () => void refreshStatus(),
        },
        { label: "Open Local Core Log", click: () => void openCoreLog() },
        ...[
          createTrayUninstallMenuItem(
            options.uninstall && ((mode) => void options.uninstall?.(mode)),
          ),
        ].filter((item) => item !== undefined),
        { label: `Quit ${productName}`, click: () => app.quit() },
      ]),
    );
  }

  async function refreshStatus(): Promise<void> {
    if (refreshInFlight || operation) {
      return;
    }
    refreshInFlight = true;
    try {
      status = await normalizeLocalCoreLifetime({ config: options.localConfig });
      recentError = undefined;
    } catch (error) {
      recentError = errorMessage(error);
    } finally {
      refreshInFlight = false;
      render();
    }
  }

  async function runOperation(
    action: TrayOperation,
    execute: () => Promise<LocalCoreStatus>,
  ): Promise<void> {
    if (operation) {
      return;
    }
    operation = action;
    recentError = undefined;
    render();
    try {
      status = await execute();
    } catch (error) {
      recentError = errorMessage(error);
    } finally {
      operation = undefined;
      render();
    }
  }

  async function startCore(): Promise<void> {
    await runOperation("starting", () =>
      ensureLocalCore({
        config: options.localConfig,
        ...(options.expectedRevision ? { expectedRevision: options.expectedRevision } : {}),
      }),
    );
  }

  async function stopCore(): Promise<void> {
    await runOperation("stopping", () => stopLocalCore({ config: options.localConfig }));
  }

  async function openCoreLog(): Promise<void> {
    try {
      const result = await shell.openPath(options.localConfig.logPath);
      if (result) {
        recentError = result;
        render();
      }
    } catch (error) {
      recentError = errorMessage(error);
      render();
    }
  }

  async function openWindow(profileId?: string): Promise<void> {
    await options.openWindow(profileId);
  }

  tray.on("click", () => void openWindow());
  render();
  void refreshStatus();
  const refreshTimer = setInterval(() => void refreshStatus(), STATUS_INTERVAL_MS);
  const unsubscribeProfiles = options.profiles.subscribe(() => render());

  return {
    openWindow,
    setUpdate: (nextUpdate) => {
      update = nextUpdate;
      render();
    },
    dispose: () => {
      clearInterval(refreshTimer);
      unsubscribeProfiles();
      tray.destroy();
    },
  };
}
