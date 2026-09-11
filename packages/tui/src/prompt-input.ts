// The terminal prompt and its discoverable slash-command menu.

import {
  type Component,
  type Focusable,
  Input,
  matchesKey,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Command, matchCommands } from "@cinba/contract";
import { BOLD, DIM, GREEN, MAGENTA, RESET } from "./theme.ts";

/**
 * The input line, plus the command menu above it.
 *
 * Input has no hook for text changes, so keystrokes pass through this wrapper
 * before reaching it. That lets the command menu open, narrow, and handle its
 * own arrow and Tab navigation without changing the basic input component.
 */
export class PromptInput implements Component, Focusable {
  readonly input = new Input();
  #hints: Command[] = [];
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

    const before = this.#hints[this.#selected]?.id;
    this.#hints = matchCommands(this.input.getValue());

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
