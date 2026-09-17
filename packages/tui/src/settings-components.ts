import {
  type Component,
  type Focusable,
  SelectList,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { BOLD, DIM, MAGENTA, RESET, SELECT_THEME, YELLOW } from "./theme.ts";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export type Choice = {
  value: string;
  label: string;
  description?: string;
};

export class ChoicePicker implements Component {
  #list: SelectList;
  #title: string;
  #filter = "";
  onAnswer?: (value: string | undefined) => void;

  constructor(title: string, choices: Choice[], maxVisible = 10) {
    this.#title = title;
    this.#list = new SelectList(choices, maxVisible, SELECT_THEME);
    this.#list.onSelect = (item) => this.onAnswer?.(item.value);
    this.#list.onCancel = () => this.onAnswer?.(undefined);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "backspace")) {
      this.#filter = this.#filter.slice(0, -1);
      this.#list.setFilter(this.#filter);
      return;
    }
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

export class SecretInput implements Component, Focusable {
  #value = "";
  #label: string;
  #receivingPaste = false;
  focused = false;
  onAnswer?: (value: string | undefined) => void;

  constructor(label: string) {
    this.#label = label;
  }

  handleInput(data: string): void {
    if (this.#receivingPaste) {
      const end = data.indexOf(BRACKETED_PASTE_END);
      if (end === -1) {
        this.#appendPrintable(data);
        return;
      }
      this.#appendPrintable(data.slice(0, end));
      this.#receivingPaste = false;
      const remaining = data.slice(end + BRACKETED_PASTE_END.length);
      if (remaining !== "") {
        this.handleInput(remaining);
      }
      return;
    }

    const pasteStart = data.indexOf(BRACKETED_PASTE_START);
    if (pasteStart !== -1) {
      this.#appendPrintable(data.slice(0, pasteStart));
      this.#receivingPaste = true;
      this.handleInput(data.slice(pasteStart + BRACKETED_PASTE_START.length));
      return;
    }

    if (matchesKey(data, "escape")) {
      this.onAnswer?.(undefined);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      this.onAnswer?.(this.#value.trim() === "" ? undefined : this.#value.trim());
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.#value = this.#value.slice(0, -1);
      return;
    }
    if (data.length > 0 && !data.startsWith("\x1b") && data >= " ") {
      this.#value += data;
    }
  }

  #appendPrintable(data: string): void {
    this.#value += [...data]
      .filter((character) => character >= " " && character !== "\x7f")
      .join("");
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [
      ...wrapTextWithAnsi(`${YELLOW}${BOLD}${this.#label}${RESET}`, width),
      `${DIM}(nothing is echoed; Enter to save, Esc to cancel)${RESET}`,
      `> ${"*".repeat(Math.min(this.#value.length, Math.max(width - 4, 0)))}`,
    ];
  }
}

export class TextInput implements Component, Focusable {
  #value = "";
  #label: string;
  #receivingPaste = false;
  focused = false;
  onAnswer?: (value: string | undefined) => void;

  constructor(label: string, initial = "") {
    this.#label = label;
    this.#value = initial;
  }

  handleInput(data: string): void {
    if (this.#receivingPaste) {
      const end = data.indexOf(BRACKETED_PASTE_END);
      if (end === -1) {
        this.#appendPrintable(data);
        return;
      }
      this.#appendPrintable(data.slice(0, end));
      this.#receivingPaste = false;
      const remaining = data.slice(end + BRACKETED_PASTE_END.length);
      if (remaining !== "") {
        this.handleInput(remaining);
      }
      return;
    }

    const pasteStart = data.indexOf(BRACKETED_PASTE_START);
    if (pasteStart !== -1) {
      this.#appendPrintable(data.slice(0, pasteStart));
      this.#receivingPaste = true;
      this.handleInput(data.slice(pasteStart + BRACKETED_PASTE_START.length));
      return;
    }

    if (matchesKey(data, "escape")) {
      return this.onAnswer?.(undefined);
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      return this.onAnswer?.(this.#value.trim() || undefined);
    }
    if (matchesKey(data, "backspace")) {
      this.#value = this.#value.slice(0, -1);
      return;
    }
    if (data.length > 0 && !data.startsWith("\x1b") && data >= " ") {
      this.#value += data;
    }
  }

  #appendPrintable(data: string): void {
    this.#value += [...data]
      .filter((character) => character >= " " && character !== "\x7f")
      .join("");
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [
      ...wrapTextWithAnsi(`${YELLOW}${BOLD}${this.#label}${RESET}`, width),
      truncateToWidth(`> ${this.#value}`, width),
      `${DIM}Enter to save, Esc to cancel${RESET}`,
    ];
  }
}
