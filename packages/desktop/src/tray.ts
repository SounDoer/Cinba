import {
  type LocalCoreStatus,
  createLocalCoreConfig,
  ensureLocalCore,
  inspectLocalCore,
  stopLocalCore,
} from "@cinba/core-manager";

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
};

export type SystemTrayController = {
  openWindow(): Promise<void>;
  dispose(): void;
};

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
): TrayViewModel {
  const detailLabels: string[] = [];
  if (status.pid !== undefined) {
    detailLabels.push(`PID: ${status.pid}`);
  }
  if (status.clientCount !== undefined) {
    detailLabels.push(`Clients: ${status.clientCount}`);
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
      tooltip: `Cinba Core: ${action}`,
      iconTone: error ? "error" : "busy",
      statusLabel: `Core: ${action}`,
      detailLabels,
      canStart: false,
      canStop: false,
    };
  }

  if (!status.running) {
    return {
      tooltip: error ? "Cinba Core: status error" : "Cinba Core: stopped",
      iconTone: error ? "error" : "stopped",
      statusLabel: "Core: stopped",
      detailLabels,
      canStart: true,
      canStop: false,
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
    tooltip: error ? "Cinba Core: status error" : `Cinba Core: ${state}`,
    iconTone,
    statusLabel: `Core: ${state}`,
    detailLabels,
    canStart: false,
    canStop: status.managed && status.state !== "draining",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Create the tray lazily so this module's pure state mapping stays Node-testable. */
export async function createSystemTrayController(options: {
  openWindow: () => Promise<LocalCoreStatus>;
}): Promise<SystemTrayController> {
  const { Menu, Tray, app, nativeImage, shell } = await import("electron");
  let status = STOPPED;
  let operation: TrayOperation | undefined;
  let recentError: string | undefined;
  let refreshInFlight = false;

  function createTrayIcon(tone: TrayIconTone) {
    const icon = nativeImage.createFromBitmap(createTrayBitmap(tone), {
      width: 16,
      height: 16,
      scaleFactor: 1,
    });
    if (icon.isEmpty()) {
      throw new Error("Failed to create the Cinba tray icon bitmap");
    }
    return icon;
  }

  const tray = new Tray(createTrayIcon("stopped"));

  function render(): void {
    const view = createTrayViewModel(status, operation, recentError);
    tray.setImage(createTrayIcon(view.iconTone));
    tray.setToolTip(view.tooltip);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Cinba", enabled: !operation, click: () => void openWindow() },
        { type: "separator" },
        { label: view.statusLabel, enabled: false },
        ...view.detailLabels.map((label) => ({ label, enabled: false }) as const),
        { type: "separator" },
        { label: "Start Core", enabled: view.canStart, click: () => void startCore() },
        {
          label: "Stop Core Gracefully",
          enabled: view.canStop,
          click: () => void stopCore(),
        },
        { label: "Refresh Status", enabled: !operation, click: () => void refreshStatus() },
        { label: "Open Core Log", click: () => void openCoreLog() },
        { type: "separator" },
        { label: "Quit Tray", click: () => app.quit() },
      ]),
    );
  }

  async function refreshStatus(): Promise<void> {
    if (refreshInFlight || operation) {
      return;
    }
    refreshInFlight = true;
    try {
      status = await inspectLocalCore();
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
    await runOperation("starting", ensureLocalCore);
  }

  async function stopCore(): Promise<void> {
    await runOperation("stopping", stopLocalCore);
  }

  async function openCoreLog(): Promise<void> {
    try {
      const result = await shell.openPath(createLocalCoreConfig().logPath);
      if (result) {
        recentError = result;
        render();
      }
    } catch (error) {
      recentError = errorMessage(error);
      render();
    }
  }

  async function openWindow(): Promise<void> {
    await runOperation("starting", options.openWindow);
  }

  tray.on("click", () => void openWindow());
  render();
  void refreshStatus();
  const refreshTimer = setInterval(() => void refreshStatus(), STATUS_INTERVAL_MS);

  return {
    openWindow,
    dispose: () => {
      clearInterval(refreshTimer);
      tray.destroy();
    },
  };
}
