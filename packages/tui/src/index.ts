// Cinba's terminal client.
//
// It is a client of core-server, exactly like the browser and the Electron
// window: same protocol, same ledger, same conversations. Only the drawing
// layer differs. It used to start a Pi of its own, which made it a second core
// host and left it quietly out of step with the GUI — a model switched there
// was invisible here.
//
// What it gains by connecting instead: the same conversation as the GUI, a
// transcript that survives closing the terminal, and one set of settings.
//
// Usage: cd <your project> && node <repo>/packages/tui/src/index.ts
//
// Working directory = wherever it was started, and that still decides which
// project you land in: on connecting it looks for conversations in this
// directory and opens the most recent, or starts one. Do not launch it through
// npm --workspace, which would set the directory to the package's own.

import {
  Container,
  Input,
  matchesKey,
  Markdown,
  ProcessTerminal,
  SelectList,
  truncateToWidth,
  TuiMainScreen,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  Component,
  Focusable,
  MarkdownTheme,
  SelectListTheme,
  TUI,
} from "@earendil-works/pi-tui";
import {
  COMMANDS,
  commandArgument,
  createSession,
  isCommand,
  matchCommands,
  RemoteSession,
  sessionSubtitle,
  sessionTitle,
} from "@cinba/core-client";
import type {
  Command,
  Entry,
  Session,
  SessionSummary,
  Snapshot,
  Socket,
  ViewAction,
} from "@cinba/core-client";

/** Same address the browser uses. Nothing here starts a core: the service has to be running. */
const SERVER_URL = "ws://127.0.0.1:4517/ws";

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
 * Markdown styling for the terminal, in the colours already used here.
 *
 * Written out rather than borrowed from pi-coding-agent's getMarkdownTheme:
 * this package must not depend on Pi, which is the dependency rule the whole
 * design rests on.
 */
const MARKDOWN_THEME: MarkdownTheme = {
  heading: (text) => `${BOLD}${BLUE}${text}${RESET}`,
  link: (text) => `${BLUE}${text}${RESET}`,
  linkUrl: (text) => `${DIM}${text}${RESET}`,
  code: (text) => `${YELLOW}${text}${RESET}`,
  codeBlock: (text) => `${YELLOW}${text}${RESET}`,
  codeBlockBorder: (text) => `${DIM}${text}${RESET}`,
  quote: (text) => `${DIM}${text}${RESET}`,
  quoteBorder: (text) => `${DIM}${text}${RESET}`,
  hr: (text) => `${DIM}${text}${RESET}`,
  listBullet: (text) => `${MAGENTA}${text}${RESET}`,
  bold: (text) => `${BOLD}${text}${RESET}`,
  italic: (text) => `${DIM}${text}${RESET}`,
  strikethrough: (text) => `${DIM}${text}${RESET}`,
  underline: (text) => `${BOLD}${text}${RESET}`,
};

/**
 * The output area.
 *
 * It holds blocks rather than bare lines. Most blocks are plain lines, but a
 * finished message is kept as its Markdown source and rendered at draw time,
 * because Markdown only makes sense once the width is known and once the text
 * has stopped growing. While an answer streams it is plain lines; the redraw at
 * the end of the turn turns it into Markdown.
 *
 * Still append-only in spirit: TuiMainScreen diffs against the previous frame,
 * so only what is still on screen can change. A whole conversation arriving at
 * once is handled by clearing and drawing again, not by editing in place.
 */
type Block = { kind: "lines"; lines: string[] } | { kind: "markdown"; source: Markdown };

class Transcript implements Component {
  #blocks: Block[] = [];
  #max = 400;

  #tail(): string[] {
    const last = this.#blocks.at(-1);
    if (last?.kind === "lines") return last.lines;
    const lines: string[] = [];
    this.#blocks.push({ kind: "lines", lines });
    this.#trim();
    return lines;
  }

  #trim(): void {
    if (this.#blocks.length > this.#max) this.#blocks = this.#blocks.slice(-this.#max);
  }

  append(line: string): void {
    this.#tail().push(line);
  }

  /** Append to the end of the last line. This is how streaming text grows character by character. */
  appendInline(text: string): void {
    const lines = this.#tail();
    if (lines.length === 0) lines.push("");
    lines[lines.length - 1] += text;
  }

  /** Add a block of Markdown, rendered when the width is known. */
  appendMarkdown(text: string): void {
    this.#blocks.push({
      kind: "markdown",
      source: new Markdown(text, 0, 0, MARKDOWN_THEME),
    });
    this.#trim();
  }

  /** Start over. A whole conversation arrives at once when one is opened, and when the server corrects the transcript. */
  clear(): void {
    this.#blocks = [];
  }

  invalidate(): void {}

  render(width: number): string[] {
    const out: string[] = [];
    for (const block of this.#blocks) {
      if (block.kind === "markdown") {
        out.push(...block.source.render(width));
        continue;
      }
      for (const line of block.lines) {
        if (line === "") {
          out.push(""); // A blank line separates paragraphs and must not be swallowed by the wrapper
          continue;
        }
        // line.slice(0, width) will not do: it counts characters, while a
        // terminal cares about display columns. A CJK character takes 2 columns
        // and an ANSI escape takes 0, so either one puts the counts out of step
        // -- and pi-tui throws outright when a rendered line comes out too wide.
        out.push(...wrapTextWithAnsi(line, width));
      }
    }
    return out;
  }
}

/**
 * The input line, plus the command menu above it.
 *
 * Input has no hook for "the text changed", so the menu is refreshed here,
 * where keystrokes already pass through on their way in. That is cheaper than
 * swapping in Editor, which does support completion providers but brings a lot
 * else with it.
 *
 * While the menu is up it takes the arrow keys and Tab for itself: it looks
 * like a list to choose from, so it has to behave like one. Everything else
 * still reaches the input, so typing keeps narrowing the list.
 */
class PromptInput implements Component, Focusable {
  readonly input = new Input();
  #hints: Command[] = [];
  #selected = 0;
  #focused = false;

  /**
   * Focus has to land on this wrapper, not on the Input inside it, or
   * handleInput below never runs and the menu never appears. The flag is passed
   * through so the Input still draws the cursor: TUI sets it on whatever it
   * focused, and only the Input knows where the cursor goes.
   */
  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (this.#hints.length > 0) {
      if (matchesKey(data, "up")) {
        // Wrapping, so a list of four is never more than two presses away.
        this.#selected = (this.#selected + this.#hints.length - 1) % this.#hints.length;
        return;
      }
      if (matchesKey(data, "down") || matchesKey(data, "tab")) {
        this.#selected = (this.#selected + 1) % this.#hints.length;
        return;
      }
    }

    this.input.handleInput(data);

    // Typing a slash opens the menu; typing on narrows it; deleting the slash closes it.
    const before = this.#hints[this.#selected]?.id;
    this.#hints = matchCommands(this.input.getValue());

    // Keep the highlight on the same command if it survived the narrowing,
    // otherwise start again at the top rather than pointing somewhere arbitrary.
    const stillThere = this.#hints.findIndex((command) => command.id === before);
    this.#selected = stillThere >= 0 ? stillThere : 0;
  }

  /** The command Enter would run, if any. */
  pending(): Command | undefined {
    return this.#hints[this.#selected];
  }

  clearHints(): void {
    this.#hints = [];
    this.#selected = 0;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const menu: string[] = [];
    for (const [index, command] of this.#hints.entries()) {
      const chosen = index === this.#selected;
      const line = chosen
        ? `${MAGENTA}> /${command.name}${RESET}  ${DIM}${command.summary}${RESET}`
        : `${DIM}  /${command.name}  ${command.summary}${RESET}`;
      menu.push(...wrapTextWithAnsi(line, width));
    }

    if (menu.length > 0) {
      menu.push(`${DIM}  up/down to choose, Enter to run${RESET}`);
    }

    return [...menu, `${GREEN}${BOLD}You:${RESET}`, ...this.input.render(width)];
  }
}

/** The bottom line: cumulative usage and the keys available right now. */
class StatusBar implements Component {
  totalTokens = 0;
  totalCost = 0;
  busy = false;
  model = "";

  invalidate(): void {}

  render(width: number): string[] {
    const usage = `${DIM}${this.totalTokens} tokens · $${this.totalCost.toFixed(4)}${RESET}`;
    // Highlight while busy: this line sits pinned at the bottom of a fast-scrolling screen, and all-dim means invisible.
    const hint = this.busy
      ? `${YELLOW}${BOLD}⏳ answering - press Esc to stop${RESET}`
      : `${DIM}/ for commands · ^C exit${RESET}`;
    const model = this.model ? `${DIM} · ${this.model}${RESET}` : "";
    // Truncated by display columns as well; see the note in Transcript.render.
    return [truncateToWidth(`${usage}${model}    ${hint}`, width)];
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

/**
 * A list to choose from, standing in for the input at the bottom.
 *
 * The same shape as the confirmation dialog, which is the only other thing that
 * takes over the bottom of the screen.
 */
class ChoiceDialog implements Component {
  #list: SelectList;
  #title: string;

  constructor(title: string, items: { value: string; label: string; description?: string }[]) {
    this.#title = title;
    this.#list = new SelectList(items, 10, SELECT_THEME);
    this.#list.onSelect = (item) => this.onAnswer?.(item.value);
    this.#list.onCancel = () => this.onAnswer?.(undefined);
  }

  onAnswer?: (value: string | undefined) => void;

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
      `${DIM}up/down to choose, Enter to confirm, Esc to cancel${RESET}`,
    ];
  }
}

/** Put a chooser at the bottom and hand the answer back. */
function choose(
  title: string,
  items: { value: string; label: string; description?: string }[],
  onAnswer: (value: string | undefined) => void,
): void {
  const dialog = new ChoiceDialog(title, items);
  dialog.onAnswer = (value) => {
    showPrompt();
    onAnswer(value);
  };
  setBottom(dialog);
  tui.setFocus(dialog);
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
tui.setFocus(promptInput);

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
  tui.setFocus(promptInput);
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

// ---- Talking to the core ----

const socket = new WebSocket(SERVER_URL);

/** The mirror ledger, the same one the web UI keeps. The server owns the real one. */
let mirror: Session = createSession();
let busy = false;
let sessionId = "";
let statusModel = "";

/**
 * Redraw the whole transcript from the mirror, once the current burst of
 * actions has been applied. Deferred by a tick because a batch arrives as
 * several actions and redrawing on the first would draw a half-applied state.
 */
let redrawQueued = false;
function queueRedraw(): void {
  if (redrawQueued) return;
  redrawQueued = true;
  setTimeout(() => {
    redrawQueued = false;
    drawSnapshot(mirror.snapshot());
  }, 0);
}

/** Set while a confirmation dialog is up, so Enter in the input cannot jump the queue. */
let confirming = false;

function roleHeading(role: "user" | "assistant"): string {
  return role === "user" ? `${GREEN}${BOLD}You:${RESET}` : `${BLUE}${BOLD}Assistant:${RESET}`;
}

function applyAction(action: ViewAction): void {
  switch (action.type) {
    case "message_added":
      transcript.append("");
      transcript.append(roleHeading(action.role));
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
        transcript.append(`${YELLOW}[tool] ${action.toolName}${RESET} ${DIM}awaiting approval${RESET}`);
        if (action.args !== undefined) {
          for (const line of JSON.stringify(action.args, null, 2).split("\n")) {
            transcript.append(`${DIM}   ${line}${RESET}`);
          }
        }
      } else if (action.status === "done" || action.status === "error") {
        transcript.append(
          action.status === "done"
            ? `   ${GREEN}done${RESET}`
            : `   ${RED}denied or failed${RESET}`,
        );
        // Tool output can be long, so take the first 20 lines: flooding a terminal is worse than showing less.
        for (const line of (action.result ?? "").split("\n").slice(0, 20)) {
          transcript.append(`${DIM}   ${line}${RESET}`);
        }
      }
      // running is not drawn: the dialog disappearing is itself the signal that execution began.
      break;
    }

    case "confirm_requested":
      raiseConfirm(action.requestId);
      break;

    case "model_in_use":
      transcript.append(`${MAGENTA}-- ${action.provider}/${action.modelId} --${RESET}`);
      break;

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
      // A finished turn is the moment the text stops growing, so this is when
      // it can be laid out as Markdown. Redrawing from the mirror also brings
      // the terminal back in step after the server corrects anything.
      if (!action.busy) queueRedraw();
      break;

    // thinking stays hidden in the terminal: it is long and rarely what you came for.
    default:
      break;
  }
  tui.requestRender();
}

/** Draw a whole conversation from scratch: on opening one, and after the server corrects the transcript. */
function drawSnapshot(snapshot: Snapshot): void {
  transcript.clear();
  transcript.append(`${BOLD}Cinba${RESET} ${DIM}${process.cwd()}${RESET}`);
  transcript.append(`${DIM}Type and press Enter to send. Ctrl+C to exit.${RESET}`);
  for (const entry of snapshot.entries) drawEntry(entry);

  statusBar.totalTokens = snapshot.totalTokens;
  statusBar.totalCost = snapshot.totalCost;
  statusBar.model = statusModel;
  busy = snapshot.busy;
  statusBar.busy = snapshot.busy;
  tui.requestRender();
}

function drawEntry(entry: Entry): void {
  switch (entry.kind) {
    case "message":
      transcript.append("");
      transcript.append(roleHeading(entry.role));
      // Markdown, not raw lines: the text has stopped growing, so it can be
      // laid out. While it was streaming it was drawn as it arrived.
      transcript.appendMarkdown(entry.text);
      break;

    case "tool": {
      transcript.append("");
      const outcome =
        entry.status === "done"
          ? `${GREEN}done${RESET}`
          : entry.status === "error"
            ? `${RED}denied or failed${RESET}`
            : `${DIM}${entry.status}${RESET}`;
      transcript.append(`${YELLOW}[tool] ${entry.toolName}${RESET} ${outcome}`);
      for (const line of (entry.result ?? "").split("\n").slice(0, 20)) {
        if (line !== "") transcript.append(`${DIM}   ${line}${RESET}`);
      }
      break;
    }

    case "model":
      transcript.append(`${MAGENTA}-- ${entry.provider}/${entry.modelId} --${RESET}`);
      break;

    case "notice":
      transcript.append(`${YELLOW}[${entry.text}]${RESET}`);
      break;
  }
}

/**
 * Raise the allow/deny dialog.
 *
 * The request carries no tool name, so it comes from the card the ledger is
 * holding at pending — the same heuristic the GUI uses, and sound for the same
 * reason: that conversation's Pi is blocked, so at most one is outstanding.
 */
function raiseConfirm(requestId: string): void {
  const waiting = mirror
    .snapshot()
    .entries.filter((entry) => entry.kind === "tool" && entry.status === "pending")
    .at(-1);
  const toolName = waiting && waiting.kind === "tool" ? waiting.toolName : "this tool";

  confirming = true;
  const dialog = new ConfirmDialog(`Allow ${toolName}?`);
  dialog.onAnswer = (confirmed) => {
    confirming = false;
    transcript.append(confirmed ? `${DIM}   -> allowed${RESET}` : `${DIM}   -> denied${RESET}`);
    showPrompt();
    remote.respondConfirm(requestId, confirmed);
  };
  setBottom(dialog);
  tui.setFocus(dialog);
}

const remote = new RemoteSession(socket as unknown as Socket, {
  onSnapshot: (state) => {
    mirror = createSession(state.snapshot);
    sessionId = state.sessionId;
    statusModel = state.model?.id ?? "";
    drawSnapshot(state.snapshot);
  },
  onActions: (actions) => {
    for (const action of actions) {
      mirror.apply(action);
      applyAction(action);
    }
  },
  onSessionListing: (sessions) => {
    if (!landed) {
      land(sessions);
      return;
    }
    choose(
      "Open which conversation?",
      sessions.map((session) => ({
        value: session.id,
        // The dot marks the one you are in, the same as the browser's list.
        label: `${session.id === sessionId ? "● " : "  "}${sessionTitle(session)}`,
        description: sessionSubtitle(session),
      })),
      (id) => {
        if (id) remote.openSession(id);
      },
    );
  },
  onModelListing: (models) => {
    choose(
      "Switch to which model?",
      models.map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: `${model.provider} / ${model.id}`,
      })),
      (picked) => {
        if (!picked) return;
        const [provider, ...rest] = picked.split("/");
        remote.setModel(provider ?? "", rest.join("/"));
      },
    );
  },
  onModelChanged: (model) => {
    statusModel = `${model.id}`;
    tui.requestRender();
  },
});

// ---- Landing in the right conversation ----

/**
 * The server points a fresh connection at whichever conversation was last used,
 * which may belong to another project. The terminal's rule is different and
 * older than that: you are in the directory you started in. So it asks for that
 * directory's conversations and picks from those — once, on connecting.
 */
let landed = false;

function land(sessions: SessionSummary[]): void {
  if (landed) return;
  landed = true;

  const here = sessions.filter((session) => session.cwd === process.cwd());
  const recent = here[0];

  if (!recent) {
    remote.createSession(process.cwd());
    return;
  }
  if (recent.id !== sessionId) remote.openSession(recent.id);
}

socket.addEventListener("open", () => {
  remote.listSessions(process.cwd());
});

socket.addEventListener("error", () => {
  // Nothing is started here on purpose. Whoever owns that process should own
  // its lifetime and its log, and a core quietly outliving this terminal --
  // still able to run any command -- would be worse than an error message.
  tui.stop();
  console.error(`Cannot reach the Cinba service at ${SERVER_URL}.`);
  console.error("Start it first: double-click cinba.cmd in the repository root.");
  process.exit(1);
});

socket.addEventListener("close", () => {
  // Exit rather than wait and reconnect. Reconnecting was considered on
  // 2026-09-08 and deferred: it would want backoff, a re-landing on the same
  // conversation, and a locked input meanwhile — worth it only once restarting
  // the service under a running terminal becomes a habit rather than a one-off.
  //
  // Note this fires the moment Ctrl+C is pressed in the service's window, not
  // when its "Terminate batch job (Y/N)?" is answered: the console delivers
  // Ctrl+C to every process in the group, so the service is already gone while
  // cmd.exe is still asking about its own script.
  tui.stop();
  console.error("The Cinba service went away.");
  process.exit(1);
});

// ---- Interaction ----

/** Carry out one of Cinba's own commands. What it means here; the catalogue says which exist. */
function runCommand(command: Command, line: string): void {
  switch (command.id) {
    case "name": {
      const name = commandArgument(line);
      if (name === "") {
        applyAction({ type: "notice", text: "give it a name, e.g. /name parser work" });
        return;
      }
      remote.renameSession(name);
      return;
    }

    case "sessions":
      remote.listSessions();
      return;
    case "model":
      remote.listModels();
      return;
    case "new":
      // The terminal's rule throughout: you are in the directory you started in.
      remote.createSession(process.cwd());
      return;
    case "help":
      transcript.append("");
      for (const entry of COMMANDS) {
        transcript.append(`${MAGENTA}/${entry.name}${RESET}  ${DIM}${entry.summary}${RESET}`);
      }
      tui.requestRender();
      return;
  }
}

promptInput.input.onSubmit = (value: string) => {
  // No new input while answering, and the box is deliberately NOT cleared:
  // whatever the user typed during streaming has to survive, or half the point
  // of typing while watching output is gone.
  if (busy || confirming) return;
  const text = value.trim();
  if (text === "") return;

  if (isCommand(text)) {
    // What the menu is pointing at, which is not the first match once the
    // arrows have been used.
    const command = promptInput.pending();
    promptInput.input.setValue("");
    promptInput.clearHints();
    if (command) {
      runCommand(command, text);
    } else {
      // Say so rather than sending it to the model: a mistyped command is not a question.
      applyAction({ type: "notice", text: `no such command: ${text}` });
    }
    return;
  }

  promptInput.input.setValue("");

  // Go busy immediately rather than waiting for the signal to come back over
  // the socket. The server sends the same thing; this only locks the input at once.
  applyAction({ type: "busy_changed", busy: true });

  remote.prompt(text);
};

// Esc stops an answer in progress. Pressing it while idle does nothing: exiting
// is Ctrl+C, so a slip of the hand cannot close the conversation.
promptInput.input.onEscape = () => {
  if (!busy) return;
  remote.abort();
};

function exit(): void {
  tui.stop();
  socket.close();
  process.exit(0);
}

tui.addInputListener((data: string) => {
  if (matchesKey(data, "ctrl+c")) exit();

  // Accelerators for two of the commands. The slash menu is the discoverable
  // way in; these stay for the hands that already know them. Not available
  // mid-answer, for the same reason the GUI disables its header buttons.
  if (matchesKey(data, "ctrl+o") && !busy && !confirming) {
    remote.listSessions();
    return true;
  }
  if (matchesKey(data, "ctrl+p") && !busy && !confirming) {
    remote.listModels();
    return true;
  }
  return undefined;
});

transcript.append(`${BOLD}Cinba${RESET} ${DIM}${process.cwd()}${RESET}`);
transcript.append(`${DIM}Connecting to the core service...${RESET}`);

tui.start();
