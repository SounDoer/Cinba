// Cinba 终端客户端。
//
// 与 Electron GUI 共用 core-host 与 core-client，只有「画出来」这一层不同。
// 用法：node <仓库路径>/packages/tui/src/index.ts
//
// 工作目录 = 启动时所在目录。Pi 的会话按工作目录隔离，所以 cd 到哪就在哪开工。
// 不要用 npm --workspace 启动——那会把工作目录设成包所在目录。

import {
  Container,
  Input,
  matchesKey,
  ProcessTerminal,
  SelectList,
  truncateToWidth,
  TuiMainScreen,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, SelectListTheme, TUI } from "@earendil-works/pi-tui";
import { startCore } from "@cinba/core-host";
import { CoreClient, createEventFolder, StdioTransport } from "@cinba/core-client";
import type { ViewAction } from "@cinba/core-client";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

const SELECT_THEME: SelectListTheme = {
  selectedPrefix: (text) => `${MAGENTA}${text}${RESET}`,
  selectedText: (text) => `${MAGENTA}${text}${RESET}`,
  description: (text) => `${DIM}${text}${RESET}`,
  scrollInfo: (text) => `${DIM}${text}${RESET}`,
  noMatch: (text) => `${YELLOW}${text}${RESET}`,
};

/**
 * 输出区。追加式：画过的行不再改动。
 *
 * 为什么不做「原地更新」：TuiMainScreen 渲染主屏并与上一帧 diff，只有还在可视区域内的
 * 行能重画，滚上去的改不动。追加式在终端里也更自然——它本来就是一份日志。
 */
class Transcript implements Component {
  #lines: string[] = [];
  #max = 2000;

  append(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > this.#max) this.#lines = this.#lines.slice(-this.#max);
  }

  /** 接在最后一行末尾。流式文本靠这个一个字一个字长出来。 */
  appendInline(text: string): void {
    if (this.#lines.length === 0) this.#lines.push("");
    this.#lines[this.#lines.length - 1] += text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    // 不能用 line.slice(0, width)：那数的是「字符个数」，而终端在意的是「显示列数」。
    // 中文一个字占 2 列，ANSI 转义序列占 0 列，两者都会让字符数与列数对不上——
    // pi-tui 会因为渲染出的行超宽而直接抛错。
    // wrapTextWithAnsi 按列数折行，且对聊天记录来说折行也比截断更合适。
    const out: string[] = [];
    for (const line of this.#lines) {
      if (line === "") {
        out.push(""); // 空行是段落分隔，不能被折行函数吞掉
        continue;
      }
      out.push(...wrapTextWithAnsi(line, width));
    }
    return out;
  }
}

class PromptInput implements Component {
  readonly input = new Input();

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    return [`${GREEN}${BOLD}你：${RESET}`, ...this.input.render(width)];
  }
}

/** 底部一行：累计用量与当前可用的按键。 */
class StatusBar implements Component {
  totalTokens = 0;
  totalCost = 0;
  busy = false;

  invalidate(): void {}

  render(width: number): string[] {
    const usage = `${DIM}${this.totalTokens} tokens · $${this.totalCost.toFixed(4)}${RESET}`;
    // 忙的时候用高亮：这一行钉在飞速滚动的屏幕最底部，全暗灰的话等于隐形。
    const hint = this.busy
      ? `${YELLOW}${BOLD}⏳ 回答中——按 Esc 中止${RESET}`
      : `${DIM}Ctrl+C 退出${RESET}`;
    // 同样按显示列数截断，理由见 Transcript.render 里的说明。
    return [truncateToWidth(`${usage}    ${hint}`, width)];
  }
}

/** 权限确认。确认期间它临时顶替底部的输入框。 */
class ConfirmDialog implements Component {
  #list: SelectList;
  #title: string;
  onAnswer?: (confirmed: boolean) => void;

  constructor(title: string) {
    this.#title = title;
    this.#list = new SelectList(
      [
        { value: "yes", label: "允许执行" },
        { value: "no", label: "拒绝" },
      ],
      2,
      SELECT_THEME,
    );
    this.#list.onSelect = (item) => this.onAnswer?.(item.value === "yes");
    // Esc 取消等同于拒绝——默认从严。
    this.#list.onCancel = () => this.onAnswer?.(false);
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    return [
      ...wrapTextWithAnsi(`${YELLOW}${BOLD}${this.#title}${RESET}`, width),
      ...this.#list.render(width),
      `${DIM}↑↓ 选择，Enter 确认，Esc 拒绝${RESET}`,
    ];
  }
}

// ---- 组装 ----

const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);

const transcript = new Transcript();
const promptInput = new PromptInput();
const statusBar = new StatusBar();

const root = new Container();
root.addChild(transcript);
root.addChild(promptInput);
root.addChild(statusBar);
tui.addChild(root);
tui.setFocus(promptInput.input);

/** 底部要么是输入框，要么是确认对话框。切换时整个重组一次。 */
function setBottom(component: Component): void {
  root.clear();
  root.addChild(transcript);
  root.addChild(component);
  root.addChild(statusBar);
  tui.requestRender();
}

function showPrompt(): void {
  setBottom(promptInput);
  tui.setFocus(promptInput.input);
}

/** 弹出确认，等用户选完再 resolve。核心此刻正阻塞等着这个答案。 */
function ask(title: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = new ConfirmDialog(title);
    dialog.onAnswer = (confirmed) => {
      transcript.append(confirmed ? `${DIM}   → 已允许${RESET}` : `${DIM}   → 已拒绝${RESET}`);
      showPrompt();
      resolve(confirmed);
    };
    setBottom(dialog);
    tui.setFocus(dialog);
  });
}

// ---- 起核心 ----

const child = startCore();

// TUI 占着屏幕，不能用 console.error，否则画面会被冲花。Pi 的报错写进输出区。
child.stderr?.setEncoding("utf8");
child.stderr?.on("data", (chunk: string) => {
  for (const line of chunk.trimEnd().split("\n")) {
    transcript.append(`${RED}[pi] ${line}${RESET}`);
  }
  tui.requestRender();
});

const client = new CoreClient(new StdioTransport(child));
const fold = createEventFolder();

let busy = false;

function applyAction(action: ViewAction): void {
  switch (action.type) {
    case "message_added":
      transcript.append("");
      transcript.append(
        action.role === "user" ? `${GREEN}${BOLD}你：${RESET}` : `${BLUE}${BOLD}助手：${RESET}`,
      );
      transcript.append(""); // 正文起始行，供 appendInline 往上接
      break;

    case "text_appended": {
      // 增量里可能带换行，得拆开：第一段接在当前行，其余各起一行。
      const parts = action.text.split("\n");
      transcript.appendInline(parts[0] ?? "");
      for (const part of parts.slice(1)) transcript.append(part);
      break;
    }

    case "tool_changed": {
      if (action.status === "pending") {
        transcript.append("");
        transcript.append(`${YELLOW}🔧 ${action.toolName}${RESET} ${DIM}待批准${RESET}`);
        if (action.args !== undefined) {
          for (const line of JSON.stringify(action.args, null, 2).split("\n")) {
            transcript.append(`${DIM}   ${line}${RESET}`);
          }
        }
      } else if (action.status === "done" || action.status === "error") {
        transcript.append(
          action.status === "done"
            ? `   ${GREEN}✅ 完成${RESET}`
            : `   ${RED}❌ 被拒绝或出错${RESET}`,
        );
        // 工具输出可能很长，截前 20 行——终端里刷屏比信息少更难受。
        for (const line of (action.result ?? "").split("\n").slice(0, 20)) {
          transcript.append(`${DIM}   ${line}${RESET}`);
        }
      }
      // running 不画：确认框消失本身就是「开始执行了」的信号。
      break;
    }

    case "usage_changed":
      statusBar.totalTokens = action.totalTokens;
      statusBar.totalCost = action.totalCost;
      break;

    case "busy_changed":
      busy = action.busy;
      statusBar.busy = action.busy;
      break;

    // thinking 本阶段不显示；工具与费用在后续 task 接上。
    default:
      break;
  }
  tui.requestRender();
}

client.onEvent((event) => {
  for (const action of fold(event)) applyAction(action);
});

client.onUiRequest(async (request) => {
  // 只有 confirm 需要回话；notify 之类是广播式的，本阶段不显示。
  //
  // 注意这里没有用 foldUiRequest：那个函数的用处是把 UI 请求变成一个能跨边界传输的
  // 动作（GUI 里要过 IPC）。TUI 是单进程，直接拿 request 用即可——与不使用
  // session.ts 是同一个理由。
  if (request.method !== "confirm") return { cancelled: true };
  const confirmed = await ask(String(request.title ?? "允许执行这个工具？"));
  return { confirmed };
});

// ---- 交互 ----

promptInput.input.onSubmit = (value: string) => {
  // 回答期间不接受新输入，而且**不清空**——用户在流式输出期间打的字必须留着，
  // 否则「边看输出边打字」这个能力就废了一半。
  if (busy) return;
  const text = value.trim();
  if (text === "") return;
  promptInput.input.setValue("");

  // 立刻置忙，不等 agent_start 从管道那头回来。事件流本身也会发这个信号
  // （见 events.ts 的 agent_start），这里只是为了输入框马上锁住。
  applyAction({ type: "busy_changed", busy: true });

  void client.prompt(text);
};

// Esc 中止进行中的回答。不忙的时候按它没有副作用——退出用 Ctrl+C，
// 免得手滑一下就把会话关了。
promptInput.input.onEscape = () => {
  if (!busy) return;
  void client.abort();
  transcript.append(`${YELLOW}[已中止]${RESET}`);
  tui.requestRender();
};

function exit(): void {
  tui.stop();
  void client.close();
  process.exit(0);
}

tui.addInputListener((data: string) => {
  if (matchesKey(data, "ctrl+c")) exit();
  return undefined;
});

transcript.append(`${BOLD}Cinba${RESET} ${DIM}${process.cwd()}${RESET}`);
transcript.append(`${DIM}输入后回车发送，Ctrl+C 退出。${RESET}`);

tui.start();
