// The Electron main process.
//
// Since 3b-1 it does one thing: open a window pointing at the UI that
// core-server serves. That UI is the same code the browser gets, reaching the
// server over the same WebSocket, so nothing here needs a preload script, IPC,
// or any knowledge of the protocol.

import { app, BrowserWindow } from "electron";

const UI_URL = "http://127.0.0.1:4517/";

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 980,
    height: 760,
    title: "Cinba",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  void window.loadURL(UI_URL);
});

app.on("window-all-closed", () => app.quit());
