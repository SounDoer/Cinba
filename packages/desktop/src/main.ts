// Electron 主进程。
//
// 唯一真相住在这里：Pi 子进程、协议客户端、会话账本。
// 渲染层只是一份可随时由快照重建的副本，因此刷新界面不会丢对话。

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCore } from "@cinba/core-host";
import {
  CoreClient,
  createEventFolder,
  createSession,
  foldUiRequest,
  StdioTransport,
} from "@cinba/core-client";
import type { Session, ViewAction } from "@cinba/core-client";

/** 文字增量逐 token 到达，攒一批再发，避免每个字一次 IPC 往返加一次重绘。 */
const FLUSH_INTERVAL_MS = 30;

let window: BrowserWindow | undefined;
let client: CoreClient | undefined;
let session: Session = createSession();

// 「当前是哪个项目」。用 process.cwd() 当默认值是错的——那只是启动命令碰巧所在的
// 目录（用 npm --workspace 启动时会是 packages/desktop），与用户的项目无关。
let cwd = homedir();

function configPath(): string {
  return join(app.getPath("userData"), "config.json");
}

/** 上次选过的项目。读不出来、或那个目录已经没了，就退回主目录。 */
function loadCwd(): string {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as { cwd?: unknown };
    if (typeof parsed.cwd === "string" && existsSync(parsed.cwd)) return parsed.cwd;
  } catch {
    // 首次启动没有这个文件，属正常情况。
  }
  return homedir();
}

function saveCwd(next: string): void {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ cwd: next }, null, 2), "utf8");
  } catch {
    // 记不住不影响这一次使用，不值得打断用户。
  }
}

/** 待回应的权限确认：requestId → 把答案交回给 CoreClient 的那个函数。 */
const pendingConfirms = new Map<string, (confirmed: boolean) => void>();

let outbox: ViewAction[] = [];
let flushTimer: NodeJS.Timeout | undefined;

/** 记进账本，并排队发给窗口。 */
function emit(actions: ViewAction[]): void {
  for (const action of actions) session.apply(action);
  outbox.push(...actions);

  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    const batch = outbox;
    outbox = [];
    if (batch.length > 0) window?.webContents.send("cinba:actions", batch);
  }, FLUSH_INTERVAL_MS);
}

/** 起一个新的 Pi 进程，并把账本清空。切换工作目录时也走这里。 */
function startSession(): void {
  void client?.close();
  pendingConfirms.clear();
  outbox = [];
  session = createSession();

  const fold = createEventFolder();
  const child = startCore({ cwd });

  // Pi 的报错必须有个去处，否则它出问题时我们一无所知。
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => console.error("[pi]", chunk.trimEnd()));

  const next = new CoreClient(new StdioTransport(child));

  next.onEvent((event) => emit(fold(event)));

  next.onUiRequest(async (request) => {
    const action = foldUiRequest(request);
    if (!action) return { cancelled: true };

    emit([action]);

    // 一直挂着，直到窗口把用户的选择送回来。
    // 核心此刻正阻塞等待，这正是权限门起作用的地方。
    const confirmed = await new Promise<boolean>((resolve) => {
      pendingConfirms.set(request.id, resolve);
    });
    return { confirmed };
  });

  client = next;
}

app.whenReady().then(() => {
  cwd = loadCwd();
  startSession();

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

// 窗口关了就把 Pi 子进程一起收走，否则会留下孤儿进程。
app.on("window-all-closed", () => {
  void client?.close();
  app.quit();
});

// ---- 窗口来的请求 ----
// 渲染层的输入一律当作不可信处理：校验类型，不信任取值。

ipcMain.handle("cinba:getSnapshot", () => session.snapshot());

ipcMain.handle("cinba:prompt", (_event: IpcMainInvokeEvent, text: unknown) => {
  if (typeof text !== "string" || text.trim() === "") return;
  emit([{ type: "busy_changed", busy: true }]);
  void client?.prompt(text);
});

ipcMain.handle("cinba:abort", () => {
  void client?.abort();
});

ipcMain.handle(
  "cinba:respondConfirm",
  (_event: IpcMainInvokeEvent, requestId: unknown, confirmed: unknown) => {
    if (typeof requestId !== "string" || typeof confirmed !== "boolean") return;
    const resolve = pendingConfirms.get(requestId);
    if (!resolve) return;
    pendingConfirms.delete(requestId);

    // 用户点了允许：卡片进入「执行中」。这是 running 状态的唯一来源——
    // Pi 在确认与执行完成之间不发任何事件。
    if (confirmed) {
      const pending = session
        .snapshot()
        .entries.find(
          (entry) => entry.kind === "tool" && entry.confirmRequestId === requestId,
        );
      if (pending && pending.kind === "tool") {
        emit([
          {
            type: "tool_changed",
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            status: "running",
          },
        ]);
      }
    }

    resolve(confirmed);
  },
);

ipcMain.handle("cinba:chooseProject", async () => {
  if (!window) return cwd;
  const result = await dialog.showOpenDialog(window, {
    title: "选择项目目录",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return cwd;

  cwd = result.filePaths[0]!;
  saveCwd(cwd);
  startSession();
  window.webContents.send("cinba:reset", cwd);
  return cwd;
});

ipcMain.handle("cinba:getProject", () => cwd);
