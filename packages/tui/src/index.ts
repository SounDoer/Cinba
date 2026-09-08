// Cinba's terminal client.
//
// It shares core-host and core-client with the Electron GUI; only the drawing
// layer differs.
// Usage: node <repo>/packages/tui/src/index.ts
//
// Working directory = wherever it was started. Pi isolates sessions by working
// directory, so whichever directory you cd into is the one you work in. Do not
// start it through npm --workspace: that sets the working directory to the
// package's own directory.

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
 * The output area. Append-only: a line, once drawn, is never changed.
 *
 * Why not update in place: TuiMainScreen renders the main screen and diffs it
 * against the previous frame, so only lines still on screen can be redrawn and
 * anything scrolled past is out of reach. Append-only also suits a terminal
 * better, where this is a log to begin with.
 */
class Transcript implements Component {
  #lines: string[] = [];
  #max = 2000;

  append(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > this.#max) this.#lines = this.#lines.slice(-this.#max);
  }

  /** Append to the end of the last line. This is how streaming text grows character by character. */
  appendInline(text: string): void {
    if (this.#lines.length === 0) this.#lines.push("");
    this.#lines[this.#lines.length - 1] += text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    // line.slice(0, width) will not do: it counts characters, while a terminal
    // cares about display columns. A CJK character takes 2 columns and an ANSI
    // escape takes 0, so either one puts the counts out of step -- and pi-tui
    // throws outright when a rendered line comes out too wide.
    // wrapTextWithAnsi wraps by column count, and wrapping suits a transcript
    // better than truncation anyway.
    const out: string[] = [];
    for (const line of this.#lines) {
      if (line === "") {
        out.push(""); // A blank line separates paragraphs and must not be swallowed by the wrapper
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
    return [`${GREEN}${BOLD}You:${RESET}`, ...this.input.render(width)];
  }
}

/** The bottom line: cumulative usage and the keys available right now. */
class StatusBar implements Component {
  totalTokens = 0;
  totalCost = 0;
  busy = false;

  invalidate(): void {}

  render(width: number): string[] {
    const usage = `${DIM}${this.totalTokens} tokens · $${this.totalCost.toFixed(4)}${RESET}`;
    // Highlight while busy: this line sits pinned at the bottom of a fast-scrolling screen, and all-dim means invisible.
    const hint = this.busy
      ? `${YELLOW}${BOLD}⏳ answering - press Esc to stop${RESET}`
      : `${DIM}Ctrl+C to exit${RESET}`;
    // Truncated by display columns as well; see the note in Transcript.render.
    return [truncateToWidth(`${usage}    ${hint}`, width)];
  }
}

/** The permission confirmation. While it is up, it stands in for the input at the bottom. */
class ConfirmDialog implements Component {
  #list: SelectList;
  #title: string;
  onAnswer?: (confirmed: boolean) => void;

  constructor(title: string) {
    this.#title = title;
    this.#list = new SelectList(
      [
        { value: "yes", label: "Allow" },
        { value: "no", label: "Deny" },
      ],
      2,
      SELECT_THEME,
    );
    this.#list.onSelect = (item) => this.onAnswer?.(item.value === "yes");
    // Cancelling with Esc counts as a refusal: the strict default.
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
      `${DIM}↑↓ to choose, Enter to confirm, Esc to deny${RESET}`,
    ];
  }
}

// ---- Assembly ----

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

/** The bottom holds either the input or the confirmation dialog; switching reassembles the whole thing. */
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

/** Raise a confirmation and resolve once the user has chosen. The core is blocked waiting for this answer. */
function ask(title: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = new ConfirmDialog(title);
    dialog.onAnswer = (confirmed) => {
      transcript.append(confirmed ? `${DIM}   → allowed${RESET}` : `${DIM}   → denied${RESET}`);
      showPrompt();
      resolve(confirmed);
    };
    setBottom(dialog);
    tui.setFocus(dialog);
  });
}

// ---- Starting the core ----

const child = startCore();

// The TUI owns the screen, so console.error would scribble over it. Pi's errors go into the output area instead.
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
        action.role === "user" ? `${GREEN}${BOLD}You:${RESET}` : `${BLUE}${BOLD}Assistant:${RESET}`,
      );
      transcript.append(""); // The first line of the body, for appendInline to build on
      break;

    case "text_appended": {
      // A delta may contain newlines, so split it: the first part joins the current line, the rest start their own.
      const parts = action.text.split("\n");
      transcript.appendInline(parts[0] ?? "");
      for (const part of parts.slice(1)) transcript.append(part);
      break;
    }

    case "tool_changed": {
      if (action.status === "pending") {
        transcript.append("");
        transcript.append(`${YELLOW}🔧 ${action.toolName}${RESET} ${DIM}awaiting approval${RESET}`);
        if (action.args !== undefined) {
          for (const line of JSON.stringify(action.args, null, 2).split("\n")) {
            transcript.append(`${DIM}   ${line}${RESET}`);
          }
        }
      } else if (action.status === "done" || action.status === "error") {
        transcript.append(
          action.status === "done"
            ? `   ${GREEN}✅ done${RESET}`
            : `   ${RED}❌ denied or failed${RESET}`,
        );
        // Tool output can be long, so take the first 20 lines: flooding a terminal is worse than showing less.
        for (const line of (action.result ?? "").split("\n").slice(0, 20)) {
          transcript.append(`${DIM}   ${line}${RESET}`);
        }
      }
      // running is not drawn: the dialog disappearing is itself the signal that execution began.
      break;
    }

    case "notice":
      transcript.append(`${YELLOW}[${action.text}]${RESET}`);
      break;

    case "usage_changed":
      statusBar.totalTokens = action.totalTokens;
      statusBar.totalCost = action.totalCost;
      break;

    case "busy_changed":
      busy = action.busy;
      statusBar.busy = action.busy;
      break;

    // thinking is not shown in this phase; tools and cost arrive in later tasks.
    default:
      break;
  }
  tui.requestRender();
}

client.onEvent((event) => {
  for (const action of fold(event)) applyAction(action);
});

client.onUiRequest(async (request) => {
  // Only confirm needs an answer; notify and friends are broadcasts and are not
  // shown in this phase.
  //
  // Note that foldUiRequest is not used here. That function exists to turn a UI
  // request into an action that can cross a boundary, which the GUI needs for
  // IPC. The TUI is a single process and can use the request directly, for the
  // same reason it does not use session.ts.
  if (request.method !== "confirm") return { cancelled: true };
  const confirmed = await ask(String(request.title ?? "Allow this tool?"));
  return { confirmed };
});

// ---- Interaction ----

promptInput.input.onSubmit = (value: string) => {
  // No new input while answering, and the box is deliberately NOT cleared:
  // whatever the user typed during streaming has to survive, or half the point
  // of typing while watching output is gone.
  if (busy) return;
  const text = value.trim();
  if (text === "") return;
  promptInput.input.setValue("");

  // Go busy immediately instead of waiting for agent_start to come back down
  // the pipe. The event stream sends the same signal (see agent_start in
  // events.ts); this is only so the input locks at once.
  applyAction({ type: "busy_changed", busy: true });

  void client.prompt(text);
};

// Esc stops an answer in progress. Pressing it while idle does nothing: exiting
// is Ctrl+C, so a slip of the hand cannot close the session.
promptInput.input.onEscape = () => {
  if (!busy) return;
  void client.abort();
  applyAction({ type: "notice", text: "aborted" });
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
transcript.append(`${DIM}Type and press Enter to send. Ctrl+C to exit.${RESET}`);

tui.start();
