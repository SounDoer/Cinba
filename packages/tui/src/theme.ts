// The terminal client's visual language: ANSI colours and widget themes.

import type { MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
export const GREEN = "\x1b[32m";
export const BLUE = "\x1b[34m";
export const RED = "\x1b[31m";
export const YELLOW = "\x1b[33m";
export const MAGENTA = "\x1b[35m";
export const RESET = "\x1b[0m";

/** One ANSI foreground colour for each stable slot supplied by the shared naming rules. */
export const CORE_COLOURS = [
  "\x1b[34m",
  "\x1b[32m",
  "\x1b[33m",
  "\x1b[35m",
  "\x1b[31m",
  "\x1b[36m",
];

export const SELECT_THEME: SelectListTheme = {
  selectedPrefix: (text) => `${MAGENTA}${text}${RESET}`,
  selectedText: (text) => `${MAGENTA}${text}${RESET}`,
  description: (text) => `${DIM}${text}${RESET}`,
  scrollInfo: (text) => `${DIM}${text}${RESET}`,
  noMatch: (text) => `${YELLOW}${text}${RESET}`,
};

/** Markdown styling written locally so the TUI stays independent from Pi. */
export const MARKDOWN_THEME: MarkdownTheme = {
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
