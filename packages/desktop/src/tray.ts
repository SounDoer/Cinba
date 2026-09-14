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
    const colors: Record<TrayIconTone, string> = {
      stopped: "#7d8590",
      running: "#2da44e",
      busy: "#bf8700",
      error: "#cf222e",
    };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="8" fill="${colors[tone]}"/><path d="M11.9 5.7a4.4 4.4 0 1 0 0 6.6" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
    return nativeImage.createFromDataURL(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    );
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
