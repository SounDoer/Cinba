// 权限门：模型每次要用工具，先问过用户。
//
// 必要性来自阶段 0 的实测：Pi 的 RPC 模式默认放行模型请求的一切工具调用，
// tool_call 之后直接执行，不会等客户端回话。没有这道门，等于把 shell 直接交出去。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 只读的工具，问了也是浪费用户的注意力，直接放行。 */
const AUTO_ALLOW = new Set(["read", "glob", "grep"]);

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (AUTO_ALLOW.has(event.toolName)) return;

    // 没有界面就问不了人。安全闸门此时必须拦下来，而不是放行——
    // 联系不上负责人时正确的默认动作是拒绝（fail-closed）。
    //
    // 今天走不到这里：core-host 永远用 rpc-entry 启动 Pi，而 RPC 模式下 hasUI 恒为 true
    // （阶段 0 实测）。但若将来把 core-host 用在无界面的自动化里，写成放行就意味着
    // 所有工具静默通过，而且不会有任何报错。
    if (!ctx.hasUI) {
      return { block: true, reason: "没有界面可供确认，默认拦截" };
    }

    const detail = JSON.stringify(event.input, null, 2);
    const allowed = await ctx.ui.confirm(`允许执行 ${event.toolName}？`, detail);

    if (!allowed) {
      return { block: true, reason: "用户拒绝了这次工具调用" };
    }
  });
}
