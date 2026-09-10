// The terminal transcript and its width-aware rendering.

import { Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { MARKDOWN_THEME } from "./theme.ts";

type Block = { kind: "lines"; lines: string[] } | { kind: "markdown"; source: Markdown };

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
export class Transcript implements Component {
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

  /** Start over when a whole conversation arrives or the server corrects the transcript. */
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
          out.push("");
          continue;
        }
        // A terminal measures display columns: CJK characters take two and ANSI escapes take none.
        out.push(...wrapTextWithAnsi(line, width));
      }
    }
    return out;
  }
}
