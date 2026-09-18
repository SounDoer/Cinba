// The terminal prompt and its discoverable slash-command menu.

import {
  type Component,
  type Focusable,
  Input,
  matchesKey,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type SkillCommand, type SlashCommand, matchCommands } from "@cinba/contract";
import { BOLD, DIM, GREEN, MAGENTA, RESET } from "./theme.ts";

export type TuiLocalCommand = {
  source: "tui";
  name: string;
  summary: string;
};

type TuiSlashCommand = SlashCommand | TuiLocalCommand;

const UPDATE_COMMAND: TuiLocalCommand = {
  source: "tui",
  name: "update",
  summary: "install the ready update and restart",
};

export function createTuiLocalCommands(installed: boolean): readonly TuiLocalCommand[] {
  return installed ? [UPDATE_COMMAND] : [];
}

function matchTuiCommands(
  input: string,
  localCommands: readonly TuiLocalCommand[],
  skills: readonly SkillCommand[],
): TuiSlashCommand[] {
  const trimmed = input.trim();
  const typed = trimmed.startsWith("/")
    ? (trimmed.slice(1).split(/\s+/)[0] ?? "").toLowerCase()
    : "";
  const localNames = new Set(localCommands.map((command) => command.name));
  const shared = matchCommands(
    input,
    skills.filter((command) => !localNames.has(command.name)),
  );
  const local =
    trimmed === `/${typed}`
      ? localCommands.filter((command) => command.name.startsWith(typed))
      : [];
  const rank = (command: TuiSlashCommand): number => {
    if (command.source === "cinba") {
      return 0;
    }
    return command.source === "tui" ? 1 : 2;
  };
  return [...shared, ...local].toSorted((left, right) => {
    const exact = Number(right.name === typed) - Number(left.name === typed);
    return exact || rank(left) - rank(right) || left.name.localeCompare(right.name);
  });
}

/**
 * The input line, plus the command menu above it.
 *
 * Input has no hook for text changes, so keystrokes pass through this wrapper
 * before reaching it. That lets the command menu open, narrow, and handle its
 * own arrow and Tab navigation without changing the basic input component.
 */
export class PromptInput implements Component, Focusable {
  readonly input = new Input();
  #hints: TuiSlashCommand[] = [];
  #skills: SkillCommand[] = [];
  #tuiCommands: readonly TuiLocalCommand[] = [];
  #selected = 0;
  #focused = false;

  /** Focus stays on the wrapper so it can observe keys, while the inner input still draws the cursor. */
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
        this.#selected = (this.#selected + this.#hints.length - 1) % this.#hints.length;
        return;
      }
      if (matchesKey(data, "down") || matchesKey(data, "tab")) {
        this.#selected = (this.#selected + 1) % this.#hints.length;
        return;
      }
    }

    this.input.handleInput(data);

    const before = this.#hints[this.#selected];
    this.#hints = matchTuiCommands(this.input.getValue(), this.#tuiCommands, this.#skills);

    const stillThere = this.#hints.findIndex(
      (command) => command.source === before?.source && command.name === before.name,
    );
    this.#selected = stillThere >= 0 ? stillThere : 0;
  }

  /** The command Enter would run, if any. */
  pending(): TuiSlashCommand | undefined {
    return this.#hints[this.#selected];
  }

  clearHints(): void {
    this.#hints = [];
    this.#selected = 0;
  }

  setSkills(skills: SkillCommand[]): void {
    this.#skills = [...skills];
    this.#hints = matchTuiCommands(this.input.getValue(), this.#tuiCommands, this.#skills);
    this.#selected = 0;
  }

  setTuiCommands(commands: readonly TuiLocalCommand[]): void {
    this.#tuiCommands = [...commands];
    this.#hints = matchTuiCommands(this.input.getValue(), this.#tuiCommands, this.#skills);
    this.#selected = 0;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const menu: string[] = [];
    for (const [index, command] of this.#hints.entries()) {
      const chosen = index === this.#selected;
      const source = command.source === "skill" ? `  ${command.scope}` : "";
      const line = chosen
        ? `${MAGENTA}> /${command.name}${RESET}  ${DIM}${command.summary}${source}${RESET}`
        : `${DIM}  /${command.name}  ${command.summary}${source}${RESET}`;
      menu.push(...wrapTextWithAnsi(line, width));
    }

    if (menu.length > 0) {
      menu.push(`${DIM}  up/down to choose, Enter to run${RESET}`);
    }

    return [...menu, `${GREEN}${BOLD}You:${RESET}`, ...this.input.render(width)];
  }
}
