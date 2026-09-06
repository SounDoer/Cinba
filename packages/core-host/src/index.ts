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

export type SpawnPlan = {
  args: string[];
  env: Record<string, string | undefined>;
};

const DEFAULT_PROVIDER = "deepseek";

/**
 * 算出启动 Pi 要用的参数与环境变量。
 *
 * 抽成纯函数是为了能测：真正的 spawn 依赖运行时状态，测不了，
 * 但「参数拼对没有」「环境变量带上没有」是能测的，而后者恰好出过一次事故。
 */
export function buildSpawnPlan(
  entry: string,
  options: CoreOptions = {},
  baseEnv: Record<string, string | undefined> = process.env,
): SpawnPlan {
  const args: string[] = [entry, "--provider", options.provider ?? DEFAULT_PROVIDER];

  if (options.model) {
    args.push("--model", options.model);
  }

  for (const extension of options.extensions ?? []) {
    args.push("-e", extension);
  }

  return {
    args,
    // 在 Electron 主进程里 process.execPath 是 electron.exe，不是 node.exe。
    // 不设这个变量，electron.exe 会把 rpc-entry.js 当成一个 app 去加载后立刻退出
    // （实测：exit code=0，stdout 只有一个换行，stderr 为空——完全静默）。
    // 在普通 Node 下这个变量无害，所以两边都设，不做环境判断。
    env: { ...baseEnv, ELECTRON_RUN_AS_NODE: "1" },
  };
}

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

  const plan = buildSpawnPlan(entry, options);

  // stderr 也走 pipe，不用 "inherit"：Windows 上的 Electron GUI 进程没有挂控制台，
  // "inherit" 会让 Pi 的报错彻底消失（阶段 1b 有一个 bug 就因此难查）。
  // 由调用方决定往哪儿转发。
  return spawn(process.execPath, plan.args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: plan.env,
  });
}
