// 「我的核心」的定义：怎么启动 Pi、用哪个 provider/model、加载哪些扩展。
// 三端共用这一份，保证醒来的永远是同一个大脑。

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export type CoreOptions = {
  /** 工作目录。Pi 的会话按工作目录隔离，所以这决定了「当前是哪个项目」。 */
  cwd?: string;
  /** 模型厂商。 */
  provider?: string;
  /** 模型 id。不填则用该 provider 的默认模型。 */
  model?: string;
  /** 要加载的 extension 文件的绝对路径。 */
  extensions?: string[];
};

const DEFAULT_PROVIDER = "deepseek";

/**
 * 启动 Pi 的 RPC 进程。
 *
 * 用 Node 直接执行 Pi 的 rpc-entry，而不是 spawn "pi" 命令：
 * Windows 上 pi 实际是 pi.cmd，Node 18.20+ 禁止直接 spawn .cmd（报 EINVAL），
 * 用 shell: true 绕过则会触发 DEP0190 弃用警告。直接跑入口 JS 两个问题都没有。
 */
export function startCore(options: CoreOptions = {}): ChildProcess {
  // import.meta.resolve 返回 file:// URL，spawn 需要普通路径，所以转一道。
  // 注意必须用 import.meta.resolve：该子路径只声明了 import 条件，
  // CJS 的 require.resolve 会报 ERR_PACKAGE_PATH_NOT_EXPORTED。
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
  );

  const args: string[] = ["--provider", options.provider ?? DEFAULT_PROVIDER];

  if (options.model) {
    args.push("--model", options.model);
  }

  for (const extension of options.extensions ?? []) {
    args.push("-e", extension);
  }

  return spawn(process.execPath, [entry, ...args], {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "inherit"],
  });
}
