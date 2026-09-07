// Electron 主进程。
//
// 3b-1 之后它只做一件事：开一个窗口，指向 core-server 提供的界面。
// 界面代码与浏览器版完全相同，连服务器也走同一条 WebSocket——
// 因此这里不再需要 preload、IPC，或任何对协议的了解。

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
