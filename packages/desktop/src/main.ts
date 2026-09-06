// 冒烟实验：验证 Electron 主进程能直接执行 .ts，并能解析本地 workspace 包。
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { startCore } from "@cinba/core-host";

console.log("[smoke] main.ts 被执行了");
console.log("[smoke] startCore 是", typeof startCore);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void win.loadFile(fileURLToPath(import.meta.resolve("./renderer/index.html")));
});

app.on("window-all-closed", () => app.quit());
