import type { ChildProcess } from "node:child_process";
import { createLineSplitter } from "./line-splitter.ts";

/**
 * Transport layer. Carries text one line at a time and never inspects it.
 * Phase 3 adds a WebSocketTransport; nothing above this layer has to change.
 */
export type Transport = {
  /** Send one line. The implementation appends the newline. */
  send(line: string): void;
  /** Subscribe to every line received. */
  onLine(handler: (line: string) => void): void;
  /** Close the connection. */
  close(): Promise<void>;
};

/** Talks over a child process's stdin and stdout. */
export class StdioTransport {
  #child: ChildProcess;
  #handlers: Array<(line: string) => void> = [];

  constructor(child: ChildProcess) {
    this.#child = child;

    const feed = createLineSplitter((line) => {
      for (const handler of this.#handlers) handler(line);
    });

    if (!child.stdout) {
      throw new Error("Child process has no stdout; check the stdio option passed to spawn");
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => feed(chunk));
  }

  send(line: string): void {
    if (!this.#child.stdin) throw new Error("Child process has no stdin");
    // JSONL separates records with \n. Omit it and the other side waits forever.
    this.#child.stdin.write(line + "\n");
  }

  onLine(handler: (line: string) => void): void {
    this.#handlers.push(handler);
  }

  async close(): Promise<void> {
    this.#child.kill();
  }
}
