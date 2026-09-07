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
  TuiMainScreen,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { startCore } from "@cinba/core-host";
import { CoreClient, createEventFolder, StdioTransport } from "@cinba/core-client";
import type { ViewAction } from "@cinba/core-client";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

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

// ---- 组装 ----

const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);

const transcript = new Transcript();
const promptInput = new PromptInput();

const root = new Container();
root.addChild(transcript);
root.addChild(promptInput);
tui.addChild(root);
tui.setFocus(promptInput.input);

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

    case "busy_changed":
      busy = action.busy;
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

// 本阶段还没接权限确认，先一律拒绝，免得工具在无人看管下执行。
client.onUiRequest(async () => ({ confirmed: false }));

// ---- 交互 ----

promptInput.input.onSubmit = (value: string) => {
  // 回答期间不接受新输入，而且**不清空**——用户在流式输出期间打的字必须留着，
  // 否则「边看输出边打字」这个能力就废了一半。
  if (busy) return;
  const text = value.trim();
  if (text === "") return;
  promptInput.input.setValue("");
  void client.prompt(text);
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
