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
  /** Subscribe to connection loss. An error is present when the loss was unexpected. */
  onClose(handler: (error?: Error) => void): void;
  /** Close the connection. */
  close(): Promise<void>;
};

/** Talks over a child process's stdin and stdout. */
export class StdioTransport {
  #child: ChildProcess;
  #handlers: Array<(line: string) => void> = [];
  #closeHandlers: Array<(error?: Error) => void> = [];
  #closing = false;
  #closed = false;
  #closeError: Error | undefined;

  constructor(child: ChildProcess) {
    this.#child = child;

    const feed = createLineSplitter((line) => {
      for (const handler of this.#handlers) {
        handler(line);
      }
    });

    if (!child.stdout) {
      throw new Error("Child process has no stdout; check the stdio option passed to spawn");
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => feed(chunk));
    child.once("error", (error) => this.#notifyClose(error));
    child.once("close", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#notifyClose(this.#closing ? undefined : new Error(`Pi process exited with ${detail}`));
    });
  }

  send(line: string): void {
    if (!this.#child.stdin) {
      throw new Error("Child process has no stdin");
    }
    // JSONL separates records with \n. Omit it and the other side waits forever.
    this.#child.stdin.write(line + "\n");
  }

  onLine(handler: (line: string) => void): void {
    this.#handlers.push(handler);
  }

  onClose(handler: (error?: Error) => void): void {
    if (this.#closed) {
      handler(this.#closeError);
      return;
    }
    this.#closeHandlers.push(handler);
  }

  close(): Promise<void> {
    if (this.#closed || this.#child.exitCode !== null || this.#child.signalCode !== null) {
      this.#notifyClose();
      return Promise.resolve();
    }

    this.#closing = true;
    return new Promise((resolve) => {
      const done = () => resolve();
      this.#child.once("close", done);
      this.#child.once("error", done);
      if (!this.#child.kill()) {
        this.#notifyClose();
        done();
      }
    });
  }

  #notifyClose(error?: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeError = error;
    for (const handler of this.#closeHandlers) {
      handler(error);
    }
    this.#closeHandlers = [];
  }
}
