import { test } from "node:test";
import assert from "node:assert/strict";
import gate from "./permission-gate.ts";

type ToolCallEvent = { toolName: string; input: unknown };
type Ctx = { hasUI: boolean; ui: { confirm: (title: string, message: string) => Promise<boolean> } };
type Handler = (event: ToolCallEvent, ctx: Ctx) => Promise<unknown>;

/** 装个假的 pi，把权限门注册的 tool_call 处理器抓出来单独调用。 */
function captureHandler(): Handler {
  let handler: Handler | undefined;
  const pi = {
    on(name: string, fn: Handler) {
      if (name === "tool_call") handler = fn;
    },
  };
  (gate as (api: unknown) => void)(pi);
  if (!handler) throw new Error("权限门没有注册 tool_call 处理器");
  return handler;
}

/** 造一个上下文。answer 为 undefined 表示不该被问到。 */
function makeCtx(hasUI: boolean, answer?: boolean): Ctx {
  return {
    hasUI,
    ui: {
      confirm: async () => {
        if (answer === undefined) throw new Error("不该询问用户");
        return answer;
      },
    },
  };
}

test("没有界面时拦截，而不是放行", async () => {
  // 安全闸门必须 fail-closed：联系不上负责人时默认拒绝，不是默认放行。
  // 今天 RPC 模式下 hasUI 恒为 true，但若哪天把 core-host 用在无界面的自动化里，
  // fail-open 会让所有工具静默通过——而且不报错。
  const handler = captureHandler();

  const result = await handler({ toolName: "bash", input: { command: "rm -rf /" } }, makeCtx(false));

  assert.deepEqual(result, {
    block: true,
    reason: "没有界面可供确认，默认拦截",
  });
});

test("没有界面时，只读工具仍然放行", async () => {
  // 只读工具不构成风险，拦下来只会让无界面场景彻底不可用。
  const handler = captureHandler();

  const result = await handler({ toolName: "read", input: { file: "a.txt" } }, makeCtx(false));

  assert.equal(result, undefined);
});

test("只读工具不打扰用户", async () => {
  const handler = captureHandler();

  for (const toolName of ["read", "glob", "grep"]) {
    const result = await handler({ toolName, input: {} }, makeCtx(true));
    assert.equal(result, undefined, `${toolName} 不该被拦`);
  }
});

test("用户答应就放行", async () => {
  const handler = captureHandler();

  const result = await handler({ toolName: "bash", input: { command: "ls" } }, makeCtx(true, true));

  assert.equal(result, undefined);
});

test("用户拒绝就拦截，并把理由带给模型", async () => {
  const handler = captureHandler();

  const result = await handler({ toolName: "bash", input: { command: "ls" } }, makeCtx(true, false));

  assert.deepEqual(result, { block: true, reason: "用户拒绝了这次工具调用" });
});
