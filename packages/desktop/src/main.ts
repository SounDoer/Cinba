// The Electron main process owns only native desktop surfaces. Core lifecycle
// operations remain in core-manager, while the BrowserWindow loads the same UI
// that browsers use.

import { BrowserWindow, Menu, Tray, app, nativeImage, shell } from "electron";
import {
  type LocalCoreStatus,
  createLocalCoreConfig,
  ensureLocalCore,
  inspectLocalCore,
  stopLocalCore,
} from "@cinba/core-manager";
import { type TrayIconTone, type TrayOperation, createTrayViewModel } from "./tray-state.ts";

const UI_URL = "http://127.0.0.1:4517/";
const STATUS_INTERVAL_MS = 2_000;
const STOPPED: LocalCoreStatus = { state: "stopped", running: false, managed: false };

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let status = STOPPED;
let operation: TrayOperation | undefined;
let recentError: string | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let refreshInFlight = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function renderTray(): void {
  if (!tray) {
    return;
  }
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
    renderTray();
  }
}

async function runOperation(
  action: TrayOperation,
  execute: () => Promise<LocalCoreStatus>,
): Promise<boolean> {
  if (operation) {
    return false;
  }
  operation = action;
  recentError = undefined;
  renderTray();
  try {
    status = await execute();
    return true;
  } catch (error) {
    recentError = errorMessage(error);
    return false;
  } finally {
    operation = undefined;
    renderTray();
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
      renderTray();
    }
  } catch (error) {
    recentError = errorMessage(error);
    renderTray();
  }
}

async function openWindow(): Promise<void> {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    return;
  }

  const ready = await runOperation("starting", ensureLocalCore);
  if (!ready || !status.running) {
    return;
  }
  window = new BrowserWindow({
    width: 980,
    height: 760,
    title: "Cinba",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.once("closed", () => {
    window = undefined;
    void refreshStatus();
  });
  void window.loadURL(UI_URL).catch((error: unknown) => {
    recentError = errorMessage(error);
    renderTray();
  });
}

function createTray(): void {
  tray = new Tray(createTrayIcon("stopped"));
  tray.on("click", () => void openWindow());
  renderTray();
  void refreshStatus();
  refreshTimer = setInterval(() => void refreshStatus(), STATUS_INTERVAL_MS);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, arguments_) => {
    if (!arguments_.includes("--tray-only")) {
      void openWindow();
    }
  });

  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("Cinba");
      createTray();
      if (!process.argv.includes("--tray-only")) {
        await openWindow();
      }
    })
    .catch((error: unknown) => {
      console.error(`[desktop] ${errorMessage(error)}`);
      app.quit();
    });
}

app.on("window-all-closed", () => {});
app.on("will-quit", () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
});
