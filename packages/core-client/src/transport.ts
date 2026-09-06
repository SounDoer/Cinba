import type { ChildProcess } from "node:child_process";
import { createLineSplitter } from "./line-splitter.ts";

/**
 * 传输层。只负责一行行地收发文本，不理解内容。
 * 阶段 3 会再实现一个 WebSocketTransport，上层代码不用改。
 */
export type Transport = {
  /** 发一行出去（实现负责补换行符）。 */
  send(line: string): void;
  /** 订阅收到的每一行。 */
  onLine(handler: (line: string) => void): void;
  /** 关闭连接。 */
  close(): Promise<void>;
};

/** 通过子进程的 stdin/stdout 通信。 */
export class StdioTransport {
  #child: ChildProcess;
  #handlers: Array<(line: string) => void> = [];

  constructor(child: ChildProcess) {
    this.#child = child;

    const feed = createLineSplitter((line) => {
      for (const handler of this.#handlers) handler(line);
    });

    if (!child.stdout) {
      throw new Error("子进程没有 stdout，检查 spawn 的 stdio 配置");
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => feed(chunk));
  }

  send(line: string): void {
    if (!this.#child.stdin) throw new Error("子进程没有 stdin");
    // JSONL 靠 \n 分隔记录。漏了这个，对面会一直等下去。
    this.#child.stdin.write(line + "\n");
  }

  onLine(handler: (line: string) => void): void {
    this.#handlers.push(handler);
  }

  async close(): Promise<void> {
    this.#child.kill();
  }
}
