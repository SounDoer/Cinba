// Cinba's terminal client.
//
// It is a client of the core service, exactly like the browser and the Electron
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
  type Component,
  Container,
  ProcessTerminal,
  SelectList,
  type TUI,
  TuiMainScreen,
  matchesKey,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  COMMANDS,
  type Command,
  type Entry,
  type RecoveredDraft,
  type Session,
  type SessionSummary,
  type SkillCommand,
  type Snapshot,
  type ViewAction,
  agentActivity,
  commandArgument,
  createSession,
  isCommand,
  isThinkingLevel,
  sessionSubtitle,
  sessionTitle,
} from "@cinba/contract";
import { CoreClient, CoreSyncControlClient } from "@cinba/core-client";
import { BLUE, BOLD, DIM, GREEN, MAGENTA, RED, RESET, SELECT_THEME, YELLOW } from "./theme.ts";
import { Transcript } from "./transcript.ts";
import { PromptInput } from "./prompt-input.ts";
import { ProviderFlow } from "./provider-flow.ts";
import { WebToolsFlow } from "./web-tools-flow.ts";
import { SyncFlow } from "./sync-flow.ts";
import { createTuiUpdateConsumer, startProductUpdateObserver } from "./product-update.ts";
import { StatusBar } from "./status-bar.ts";

/**
 * Which core to talk to. Nothing here starts one: the service has to be running.
 *
 * Configurable because a terminal has no address bar. The browser picks its
 * core by the address it was opened at — that is what a bookmark is — and this
 * is the equivalent. An environment variable rather than an argument so it
 * composes with cinba-tui.cmd, which already spends its argument on a folder.
 */
const SERVER_URL = process.env.CINBA_SERVER || "ws://127.0.0.1:4517/ws";

/** The permission confirmation. While it is up, it stands in for the input at the bottom. */
class ConfirmDialog implements Component {
  #list: SelectList;
  #title: string;
  #message: string | undefined;
  #negativeLabel: string;
  onAnswer?: (confirmed: boolean) => void;

  constructor(title: string, message?: string, labels = { positive: "Allow", negative: "Deny" }) {
    this.#title = title;
    this.#message = message;
    this.#negativeLabel = labels.negative;
    this.#list = new SelectList(
      [
        { value: "yes", label: labels.positive },
        { value: "no", label: labels.negative },
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
      ...(this.#message
        ? this.#message
            .split("\n")
            .flatMap((line) => wrapTextWithAnsi(`${DIM}${line}${RESET}`, width))
        : []),
      ...this.#list.render(width),
      `${DIM}↑↓ to choose, Enter to confirm, Esc to ${this.#negativeLabel.toLowerCase()}${RESET}`,
    ];
  }
}

/**
 * A list to choose from, standing in for the input at the bottom.
 *
 * Typing narrows it. SelectList can filter but does not read the keyboard for
 * it — handleInput there is only arrows and Enter — so the filter is collected
 * here and handed over. Without this a list of forty providers could only be
 * walked one arrow press at a time.
 */
class ChoiceDialog implements Component {
  #list: SelectList;
  #title: string;
  #filter = "";

  constructor(title: string, items: { value: string; label: string; description?: string }[]) {
    this.#title = title;
    this.#list = new SelectList(items, 10, SELECT_THEME);
    this.#list.onSelect = (item) => this.onAnswer?.(item.value);
    this.#list.onCancel = () => this.onAnswer?.(undefined);
  }

  onAnswer?: (value: string | undefined) => void;

  handleInput(data: string): void {
    if (matchesKey(data, "backspace")) {
      this.#filter = this.#filter.slice(0, -1);
      this.#list.setFilter(this.#filter);
      return;
    }

    // Printable characters narrow the list; everything else (arrows, Enter,
    // Esc) belongs to the list itself.
    if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.#filter += data;
      this.#list.setFilter(this.#filter);
      return;
    }

    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    const typed = this.#filter === "" ? "" : `  ${MAGENTA}${this.#filter}${RESET}`;
    return [
      ...wrapTextWithAnsi(`${YELLOW}${BOLD}${this.#title}${RESET}${typed}`, width),
      ...this.#list.render(width),
      `${DIM}type to narrow, up/down to choose, Enter to confirm, Esc to cancel${RESET}`,
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
const consumeProductUpdate = createTuiUpdateConsumer({
  setStatus: (update) => {
    statusBar.update = update;
  },
  appendNotice: (notice) => transcript.append(`${YELLOW}[${notice}]${RESET}`),
  requestRender: () => tui.requestRender(),
  canAppendNotice: () => statusBar.activity.type === "idle" && !redrawQueued,
});

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

// ---- Starting the core ----

// ---- Talking to the core ----

/** The mirror ledger, the same one the web UI keeps. The server owns the real one. */
let mirror: Session = createSession();
let busy = false;
let compacting = false;
let sessionId = "";
let statusModel = "";
let exiting = false;
let recoveredDrafts: RecoveredDraft[] = [];
let skillCommands: SkillCommand[] = [];
let retryRenderTimer: NodeJS.Timeout | undefined;
let productUpdateObserver: { dispose(): void } | undefined;

function refreshActivity(snapshot: Snapshot): void {
  statusBar.activity = agentActivity(snapshot);
  if (statusBar.activity.type === "retrying" && !retryRenderTimer) {
    retryRenderTimer = setInterval(() => tui.requestRender(), 250);
    retryRenderTimer.unref();
  } else if (statusBar.activity.type !== "retrying" && retryRenderTimer) {
    clearInterval(retryRenderTimer);
    retryRenderTimer = undefined;
  }
  consumeProductUpdate.flushNotice();
}

/**
 * Redraw the whole transcript from the mirror, once the current burst of
 * actions has been applied. Deferred by a tick because a batch arrives as
 * several actions and redrawing on the first would draw a half-applied state.
 */
let redrawQueued = false;
function queueRedraw(): void {
  if (redrawQueued) {
    return;
  }
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
      for (const part of parts.slice(1)) {
        transcript.append(part);
      }
      break;
    }

    case "tool_changed": {
      if (action.status === "pending") {
        transcript.append("");
        transcript.append(
          `${YELLOW}[tool] ${action.toolName}${RESET} ${DIM}awaiting approval${RESET}`,
        );
        if (action.args !== undefined) {
          for (const line of JSON.stringify(action.args, null, 2).split("\n")) {
            transcript.append(`${DIM}   ${line}${RESET}`);
          }
        }
      } else if (action.status !== "running" || action.result !== undefined) {
        // Progress is cumulative, so redraw the card from the mirror instead of
        // appending every update. The server already coalesces events into short
        // batches, and queueRedraw coalesces every action in that batch again.
        queueRedraw();
      }
      // A newly started tool stays hidden until it produces output. This avoids
      // briefly drawing an optimistic running card before a confirmation arrives.
      break;
    }

    case "confirm_requested":
      raiseConfirm(action.requestId, action.title, action.message);
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
      // A finished turn is the moment the text stops growing, so this is when
      // it can be laid out as Markdown. Redrawing from the mirror also brings
      // the terminal back in step after the server corrects anything.
      if (!action.busy) {
        queueRedraw();
      }
      break;

    case "context_changed":
      statusBar.context = action.context;
      break;

    case "thinking_changed":
      statusBar.thinkingLevel = action.level;
      break;

    case "compaction_changed":
      compacting = action.compacting;
      break;

    case "queue_changed":
      statusBar.pendingCount = action.steering.length + action.followUp.length;
      break;

    // thinking stays hidden in the terminal: it is long and rarely what you came for.
    default:
      break;
  }
  refreshActivity(mirror.snapshot());
  tui.requestRender();
}

/** Draw a whole conversation from scratch: on opening one, and after the server corrects the transcript. */
function drawSnapshot(snapshot: Snapshot): void {
  transcript.clear();
  transcript.append(`${BOLD}Cinba${RESET} ${DIM}${process.cwd()}${RESET}`);
  transcript.append(`${DIM}Type and press Enter to send. Ctrl+C to exit.${RESET}`);
  for (const entry of snapshot.entries) {
    drawEntry(entry);
  }

  statusBar.totalTokens = snapshot.totalTokens;
  statusBar.totalCost = snapshot.totalCost;
  statusBar.model = statusModel;
  statusBar.thinkingLevel = snapshot.thinking.level;
  busy = snapshot.busy;
  compacting = snapshot.compacting;
  statusBar.context = snapshot.context;
  statusBar.pendingCount = snapshot.queue.steering.length + snapshot.queue.followUp.length;
  refreshActivity(snapshot);
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
      let outcome = `${DIM}${entry.status}${RESET}`;
      if (entry.status === "done") {
        outcome = `${GREEN}done${RESET}`;
      } else if (entry.status === "error") {
        outcome = `${RED}denied or failed${RESET}`;
      }
      transcript.append(`${YELLOW}[tool] ${entry.toolName}${RESET} ${outcome}`);
      const outputLines = (entry.result ?? "").split("\n");
      const visibleLines =
        entry.status === "running" ? outputLines.slice(-20) : outputLines.slice(0, 20);
      for (const line of visibleLines) {
        if (line !== "") {
          transcript.append(`${DIM}   ${line}${RESET}`);
        }
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
function raiseConfirm(requestId: string, title?: string, message?: string): void {
  const waiting = mirror
    .snapshot()
    .entries.filter((entry) => entry.kind === "tool" && entry.status === "pending")
    .at(-1);
  const toolName = waiting && waiting.kind === "tool" ? waiting.toolName : "this tool";

  confirming = true;
  const dialog = new ConfirmDialog(title ?? `Allow ${toolName}?`, message);
  dialog.onAnswer = (confirmed) => {
    confirming = false;
    transcript.append(confirmed ? `${DIM}   -> allowed${RESET}` : `${DIM}   -> denied${RESET}`);
    showPrompt();
    coreClient.respondConfirm(requestId, confirmed);
  };
  setBottom(dialog);
  tui.setFocus(dialog);
}

const coreClient = new CoreClient(SERVER_URL, {
  onConnectionChanged: (state) => {
    if (state === "connected") {
      coreClient.listSessions(process.cwd());
      return;
    }
    if (state !== "disconnected" || exiting) {
      return;
    }

    // Exit rather than wait and reconnect. Reliable reconnect needs command
    // deduplication before it can safely retry anything sent near a disconnect.
    tui.stop();
    console.error("The Cinba service went away.");
    process.exit(1);
  },
  onError: () => {
    // Nothing is started here on purpose. Whoever owns that process should own
    // its lifetime and its log.
    tui.stop();
    console.error(`Cannot reach the Cinba service at ${SERVER_URL}.`);
    console.error("Start it with the cinba command or cinba-web.cmd.");
    process.exit(1);
  },
  onSnapshot: (state) => {
    mirror = createSession(state.snapshot);
    sessionId = state.sessionId;
    statusModel = state.model?.id ?? "";
    drawSnapshot(state.snapshot);
    productUpdateObserver ??= startProductUpdateObserver({
      environment: process.env,
      onUpdate: consumeProductUpdate,
    });
  },
  onActions: (actions) => {
    for (const action of actions) {
      mirror.apply(action);
      applyAction(action);
    }
  },
  onCoreIdentity: (name) => {
    statusBar.core = name;
    tui.requestRender();
  },
  onDraftsRecovered: (drafts) => {
    recoveredDrafts.push(...drafts);
    statusBar.recoveredCount = recoveredDrafts.length;
    transcript.append(
      `${YELLOW}[Recovered ${drafts.length} queued message${drafts.length === 1 ? "" : "s"}; press Alt+Up to edit]${RESET}`,
    );
    tui.requestRender();
  },
  onSkillListing: (listedSessionId, skills) => {
    if (sessionId !== "" && listedSessionId !== sessionId) {
      return;
    }
    skillCommands = skills;
    promptInput.setSkills(skills);
    tui.requestRender();
  },
  onProjectTrustRequested: (request) => {
    confirming = true;
    const details = [
      request.cwd,
      "",
      "Detected agent resources:",
      ...request.resources.map((resource) => `  ${resource}`),
      "",
      "Trusting this folder also trusts project resources added there later.",
    ].join("\n");
    const dialog = new ConfirmDialog("Trust agent resources in this project?", details, {
      positive: "Trust",
      negative: "Do not trust",
    });
    dialog.onAnswer = (trusted) => {
      confirming = false;
      showPrompt();
      coreClient.respondProjectTrust(request.requestId, trusted);
    };
    setBottom(dialog);
    tui.setFocus(dialog);
  },
  onProviderListing: (providers) => {
    providerFlow.onListing(providers);
  },
  onWebToolsStatus: (status, error) => {
    webToolsFlow.onStatus(status, error);
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
        if (id) {
          coreClient.openSession(id);
        }
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
        if (!picked) {
          return;
        }
        const [provider, ...rest] = picked.split("/");
        coreClient.setModel(provider ?? "", rest.join("/"));
      },
    );
  },
  onModelChanged: (model) => {
    statusModel = `${model.id}`;
    tui.requestRender();
  },
});

const syncFlow = new SyncFlow(new CoreSyncControlClient(SERVER_URL), {
  append: (line) => transcript.append(line),
  showInteraction: (component) => {
    setBottom(component);
    tui.setFocus(component);
  },
  showPrompt,
  requestRender: () => tui.requestRender(),
  showNotice: (text) => applyAction({ type: "notice", text }),
});

const providerFlow = new ProviderFlow(coreClient, {
  append: (line) => transcript.append(line),
  showInteraction: (component) => {
    setBottom(component);
    tui.setFocus(component);
  },
  showPrompt,
  requestRender: () => tui.requestRender(),
  showNotice: (text) => applyAction({ type: "notice", text }),
});

const webToolsFlow = new WebToolsFlow(coreClient, {
  append: (line) => transcript.append(line),
  showInteraction: (component) => {
    setBottom(component);
    tui.setFocus(component);
  },
  showPrompt,
  requestRender: () => tui.requestRender(),
  showNotice: (text) => applyAction({ type: "notice", text }),
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
  if (landed) {
    return;
  }
  landed = true;

  const here = sessions.filter((session) => session.cwd === process.cwd());
  const recent = here[0];

  if (!recent) {
    coreClient.createSession(process.cwd());
    return;
  }
  if (recent.id !== sessionId) {
    coreClient.openSession(recent.id);
  }
}

// ---- Interaction ----

/** Carry out one of Cinba's own commands. What it means here; the catalogue says which exist. */
function runCommand(command: Command, line: string): void {
  switch (command.id) {
    case "compact":
      coreClient.compact();
      return;

    case "name": {
      const name = commandArgument(line);
      if (name === "") {
        applyAction({ type: "notice", text: "give it a name, e.g. /name parser work" });
        return;
      }
      coreClient.renameSession(name);
      return;
    }

    case "sessions":
      coreClient.listSessions();
      return;
    case "model":
      coreClient.listModels();
      return;
    case "thinking": {
      const thinking = mirror.snapshot().thinking;
      if (thinking.available.length <= 1) {
        applyAction({ type: "notice", text: "This model does not support adjustable reasoning." });
        return;
      }
      choose(
        "Set thinking level",
        thinking.available.map((level) => ({
          value: level,
          label: `${level === thinking.level ? "● " : "  "}${level}`,
        })),
        (level) => {
          if (isThinkingLevel(level)) {
            coreClient.setThinkingLevel(level);
          }
        },
      );
      return;
    }
    case "new":
      // The terminal's rule throughout: you are in the directory you started in.
      coreClient.createSession(process.cwd());
      return;
    case "providers":
      providerFlow.list();
      return;

    case "login":
      providerFlow.login();
      return;

    case "logout":
      providerFlow.logout();
      return;

    case "webtools":
      webToolsFlow.open();
      return;

    case "sync":
      void syncFlow.open();
      return;

    case "help":
      transcript.append("");
      for (const entry of COMMANDS) {
        transcript.append(`${MAGENTA}/${entry.name}${RESET}  ${DIM}${entry.summary}${RESET}`);
      }
      for (const entry of skillCommands) {
        transcript.append(
          `${MAGENTA}/${entry.name}${RESET}  ${DIM}${entry.summary} (${entry.scope})${RESET}`,
        );
      }
      tui.requestRender();
      return;
  }
}

function submitInput(value: string, delivery: "default" | "followUp" = "default"): void {
  if (confirming) {
    return;
  }
  const text = value.trim();
  if (text === "") {
    return;
  }

  if (compacting) {
    applyAction({ type: "notice", text: "Wait for context compaction to finish." });
    return;
  }

  if (isCommand(text)) {
    if (busy || compacting) {
      applyAction({ type: "notice", text: "Commands cannot be queued while answering." });
      return;
    }
    // What the menu is pointing at, which is not the first match once the
    // arrows have been used.
    const command = promptInput.pending();
    promptInput.input.setValue("");
    promptInput.clearHints();
    if (command?.source === "cinba") {
      runCommand(command, text);
    } else if (command?.source === "skill") {
      coreClient.prompt(text);
    } else {
      // Say so rather than sending it to the model: a mistyped command is not a question.
      applyAction({ type: "notice", text: `no such command: ${text}` });
    }
    return;
  }

  let sent: boolean;
  if (!busy && !compacting) {
    sent = coreClient.prompt(text);
  } else if (delivery === "followUp") {
    sent = coreClient.followUp(text);
  } else {
    sent = coreClient.steer(text);
  }
  if (!sent) {
    return;
  }
  promptInput.input.setValue("");

  if (!busy && !compacting) {
    // Go busy immediately rather than waiting for the signal to come back over
    // the socket. The server sends the same thing; this only updates the hint at once.
    const action = { type: "busy_changed", busy: true } as const;
    mirror.apply(action);
    applyAction(action);
  }
}

promptInput.input.onSubmit = (value: string) => submitInput(value);

// Esc stops an answer in progress. Pressing it while idle does nothing: exiting
// is Ctrl+C, so a slip of the hand cannot close the conversation.
promptInput.input.onEscape = () => {
  if (!busy && !compacting) {
    return;
  }
  if (mirror.snapshot().retry) {
    coreClient.abortRetry();
  } else {
    coreClient.abort();
  }
};

function exit(): void {
  exiting = true;
  productUpdateObserver?.dispose();
  if (retryRenderTimer) {
    clearInterval(retryRenderTimer);
  }
  tui.stop();
  coreClient.close();
  process.exit(0);
}

tui.addInputListener((data: string) => {
  if (matchesKey(data, "ctrl+c")) {
    exit();
  }

  if (matchesKey(data, "alt+enter") && promptInput.focused && !confirming) {
    submitInput(promptInput.input.getValue(), "followUp");
    return { consume: true };
  }

  if (matchesKey(data, "alt+up") && promptInput.focused && !confirming) {
    const restored = recoveredDrafts.shift();
    if (restored) {
      const current = promptInput.input.getValue();
      promptInput.input.setValue(`${current}${current ? "\n\n" : ""}${restored.text}`);
      statusBar.recoveredCount = recoveredDrafts.length;
      tui.requestRender();
    }
    return { consume: true };
  }

  if (matchesKey(data, "shift+tab") && promptInput.focused && !busy && !compacting && !confirming) {
    coreClient.cycleThinkingLevel();
    return { consume: true };
  }

  // Accelerators for two of the commands. The slash menu is the discoverable
  // way in; these stay for the hands that already know them. Not available
  // mid-answer, for the same reason the GUI disables its header buttons.
  if (matchesKey(data, "ctrl+o") && !busy && !confirming) {
    coreClient.listSessions();
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+p") && !busy && !confirming) {
    coreClient.listModels();
    return { consume: true };
  }
  return undefined;
});

transcript.append(`${BOLD}Cinba${RESET} ${DIM}${process.cwd()}${RESET}`);
transcript.append(`${DIM}Connecting to the core service...${RESET}`);

tui.start();
