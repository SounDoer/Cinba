// Electron 主进程。
//
// 3a 之后它只是个中继：连上 core-server，把收到的动作经原有的 IPC 通道转给渲染层。
// Pi 与账本都不在这里了，唯一真相在 core-server。
//
// 渲染层与 preload 完全不动——IPC 契约保持原样，所以界面无感。
// 等 3b 做共用界面时，渲染层会直接连服务器，这一层中继随之消失。

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { fileURLToPath } from "node:url";
import { createSession, RemoteSession } from "@cinba/core-client";
import type { Session } from "@cinba/core-client";

const SERVER_URL = "ws://127.0.0.1:4517";

let window: BrowserWindow | undefined;
let remote: RemoteSession | undefined;

/**
 * 镜像账本。服务器才是唯一真相，这里只是一份副本——
 * 渲染层按 Ctrl+R 刷新时会来要快照，那时必须给出当前的，而不是连接那一刻的。
 */
let mirror: Session = createSession();

let cwd = "";

/** 首份快照到达之前，getSnapshot 之类的请求先挂着。 */
let ready: Promise<void> = new Promise(() => {});
let markReady: () => void = () => {};

function connect(): void {
  ready = new Promise((resolve) => {
    markReady = resolve;
  });

  const socket = new WebSocket(SERVER_URL);

  socket.addEventListener("error", () => {
    dialog.showErrorBox(
      "连不上 Cinba 服务",
      "请先启动核心服务：\n\nnode <仓库路径>/packages/core-server/src/index.ts\n\n然后重新打开本程序。",
    );
  });

  remote = new RemoteSession(socket, {
    onSnapshot: (snapshot, nextCwd) => {
      mirror = createSession(snapshot);
      cwd = nextCwd;
      markReady();
    },
    onActions: (actions) => {
      for (const action of actions) mirror.apply(action);
      window?.webContents.send("cinba:actions", actions);
    },
    onReset: (nextCwd) => {
      cwd = nextCwd;
      window?.webContents.send("cinba:reset", nextCwd);
    },
  });
}

app.whenReady().then(() => {
  connect();

  window = new BrowserWindow({
    width: 980,
    height: 760,
    title: "Cinba",
    webPreferences: {
      preload: fileURLToPath(import.meta.resolve("./preload.js")),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void window.loadFile(fileURLToPath(import.meta.resolve("./renderer/index.html")));
});

// 关窗口只关窗口。core-server 是独立进程，继续跑着——这正是 3a 想要的。
app.on("window-all-closed", () => app.quit());

// ---- 渲染层来的请求 ----
// IPC 契约与阶段 1b 完全一致，只是实现从「自己干」变成了「转给服务器」。

ipcMain.handle("cinba:getSnapshot", async () => {
  await ready;
  return mirror.snapshot();
});

ipcMain.handle("cinba:getProject", async () => {
  await ready;
  return cwd;
});

ipcMain.handle("cinba:prompt", (_event: IpcMainInvokeEvent, text: unknown) => {
  if (typeof text !== "string" || text.trim() === "") return;
  remote?.prompt(text);
});

ipcMain.handle("cinba:abort", () => {
  remote?.abort();
});

ipcMain.handle(
  "cinba:respondConfirm",
  (_event: IpcMainInvokeEvent, requestId: unknown, confirmed: unknown) => {
    if (typeof requestId !== "string" || typeof confirmed !== "boolean") return;
    remote?.respondConfirm(requestId, confirmed);
  },
);

ipcMain.handle("cinba:chooseProject", async () => {
  if (!window) return cwd;
  // 文件夹选择器是 GUI 的能力，留在这一侧；选完把路径告诉服务器。
  // 注意：这依然假设了服务器与界面在同一台机器上。3b 做远程时必须重做——
  // 主设计文档第 8 节把这条记为「必须重做，不是可选优化」。
  const result = await dialog.showOpenDialog(window, {
    title: "选择项目目录",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return cwd;

  remote?.setProject(result.filePaths[0]!);
  return result.filePaths[0]!;
});
