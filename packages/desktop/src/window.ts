import { BrowserWindow } from "electron";
import { type LocalCoreStatus, ensureLocalCore } from "@cinba/core-manager";

const UI_URL = "http://127.0.0.1:4517/";

export type DesktopWindowController = {
  open(): Promise<LocalCoreStatus>;
};

/** Own the native window without keeping it alive after the user closes it. */
export function createDesktopWindowController(): DesktopWindowController {
  let window: BrowserWindow | undefined;

  async function open(): Promise<LocalCoreStatus> {
    const status = await ensureLocalCore({ lifetime: "persistent" });
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.show();
      window.focus();
      return status;
    }

    window = new BrowserWindow({
      width: 980,
      height: 760,
      title: "Cinba",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.once("closed", () => {
      window = undefined;
    });
    try {
      await window.loadURL(UI_URL);
    } catch (error) {
      window.destroy();
      window = undefined;
      throw error;
    }
    return status;
  }

  return { open };
}
