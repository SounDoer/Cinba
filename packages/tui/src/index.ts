// 冒烟实验：验证 pi-tui 能渲染、能收键盘、Ctrl+C 能干净退出。
// 这一版不接 Pi。

import { Container, Input, matchesKey, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

class Transcript implements Component {
  #lines: string[] = [];

  append(line: string): void {
    this.#lines.push(line);
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.#lines.map((line) => line.slice(0, width));
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

const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);

const transcript = new Transcript();
const promptInput = new PromptInput();

const root = new Container();
root.addChild(transcript);
root.addChild(promptInput);
tui.addChild(root);
tui.setFocus(promptInput.input);

transcript.append(`${BOLD}pi-tui 冒烟实验${RESET}`);
transcript.append(`${DIM}打字后回车会回显。Ctrl+C 退出。${RESET}`);
transcript.append("");

promptInput.input.onSubmit = (value: string) => {
  const text = value.trim();
  promptInput.input.setValue("");
  if (text !== "") transcript.append(`你说：${text}`);
  tui.requestRender();
};

// 终端处于 raw mode，Ctrl+C 不会变成 SIGINT，必须自己截。
tui.addInputListener((data: string) => {
  if (matchesKey(data, "ctrl+c")) {
    tui.stop();
    process.exit(0);
  }
  return undefined;
});

tui.start();
