// 权限门：模型每次要用工具，先问过用户。
//
// 必要性来自阶段 0 的实测：Pi 的 RPC 模式默认放行模型请求的一切工具调用，
// tool_call 之后直接执行，不会等客户端回话。没有这道门，等于把 shell 直接交出去。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 只读的工具，问了也是浪费用户的注意力，直接放行。 */
const AUTO_ALLOW = new Set(["read", "glob", "grep"]);

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (AUTO_ALLOW.has(event.toolName)) return;

    const detail = JSON.stringify(event.input, null, 2);
    const allowed = await ctx.ui.confirm(`允许执行 ${event.toolName}？`, detail);

    if (!allowed) {
      return { block: true, reason: "用户拒绝了这次工具调用" };
    }
  });
}
