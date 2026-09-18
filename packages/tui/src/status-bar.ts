import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { type AgentActivity, type ContextUsage, nameColourIndex } from "@cinba/contract";
import type { ProductUpdateViewModel } from "@cinba/product-runtime";
import { BOLD, CORE_COLOURS, DIM, RESET, YELLOW } from "./theme.ts";

export function formatProductUpdate(update: ProductUpdateViewModel): string {
  if (update.phase === "idle" || update.phase === "current") {
    return "";
  }
  if (update.phase === "ready") {
    return `${YELLOW}${BOLD} · Update ${update.candidateVersion} Ready${RESET}`;
  }
  if (update.phase === "failed") {
    return `${YELLOW}${BOLD} · Update ${update.candidateVersion} Failed${RESET}`;
  }
  return `${DIM} · ${update.phase} update${RESET}`;
}

function formatContextUsage(context: ContextUsage): string {
  if (context.contextWindow === null) {
    return "context unavailable";
  }
  const used = context.tokens === null ? "—" : context.tokens.toLocaleString("en-US");
  const percent = context.percent === null ? "—" : `${Math.round(context.percent)}%`;
  const estimate = context.estimated ? "~" : "";
  return `context ${estimate}${used}/${context.contextWindow.toLocaleString("en-US")} (${percent})`;
}

/** The bottom line: cumulative usage and the keys available right now. */
export class StatusBar implements Component {
  totalTokens = 0;
  totalCost = 0;
  activity: AgentActivity = { type: "idle" };
  context: ContextUsage = {
    tokens: null,
    contextWindow: null,
    percent: null,
    estimated: false,
  };
  model = "";
  thinkingLevel = "off";
  /** Which machine this terminal is talking to. Empty until the core says. */
  core = "";
  pendingCount = 0;
  recoveredCount = 0;
  update: ProductUpdateViewModel = { phase: "idle" };

  invalidate(): void {}

  render(width: number): string[] {
    const where =
      this.core === ""
        ? ""
        : ` · ${CORE_COLOURS[nameColourIndex(this.core)]}${BOLD}● ${this.core}${RESET}`;
    const context = formatContextUsage(this.context);
    const usage = `${DIM}${context} · session ${this.totalTokens.toLocaleString("en-US")} tokens · $${this.totalCost.toFixed(4)}${RESET}`;
    // Highlight while busy: this line sits pinned at the bottom of a fast-scrolling screen, and all-dim means invisible.
    const pending = this.pendingCount > 0 ? ` · ${this.pendingCount} queued` : "";
    const recovered = this.recoveredCount > 0 ? ` · ${this.recoveredCount} drafts (Alt+Up)` : "";
    let hint = `${DIM}/ for commands · ^C exit${RESET}`;
    if (this.activity.type === "answering") {
      hint = `${YELLOW}${BOLD}⏳ answering${pending} - Enter steer · Alt+Enter follow-up · Esc stop${RESET}`;
    }
    if (this.activity.type === "tool") {
      hint = `${YELLOW}${BOLD}⏳ running ${this.activity.toolName}${pending} · Esc stop${RESET}`;
    }
    if (this.activity.type === "permission") {
      hint = `${YELLOW}${BOLD}⏳ waiting for permission · ${this.activity.toolName}${RESET}`;
    }
    if (this.activity.type === "retrying") {
      const seconds = Math.max(0, Math.ceil((this.activity.retryAt - Date.now()) / 1_000));
      hint = `${YELLOW}${BOLD}⏳ retrying ${this.activity.attempt}/${this.activity.maxAttempts} in ${seconds}s · Esc stop retrying${RESET}`;
    }
    if (this.activity.type === "compacting") {
      hint = `${YELLOW}${BOLD}⏳ compacting context · Esc stop${RESET}`;
    }
    const model = this.model
      ? `${DIM} · ${this.model} · thinking ${this.thinkingLevel}${RESET}`
      : "";
    const update = formatProductUpdate(this.update);
    const line = update
      ? `${update}    ${hint}    ${usage}${where}${model}${recovered}`
      : `${usage}${where}${model}${recovered}    ${hint}`;
    // Truncated by display columns as well; see the note in Transcript.render.
    return [truncateToWidth(line, width)];
  }
}
