import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnPlan } from "./index.ts";

const GATE = "/gate.ts";

test("默认走 deepseek", () => {
  const plan = buildSpawnPlan("/entry.js", GATE, {}, {});

  assert.deepEqual(plan.args.slice(0, 3), ["/entry.js", "--provider", "deepseek"]);
});

test("权限门总是挂上，调用方漏不掉", () => {
  // 权限门不是某个界面的功能，是这个 agent 的固有属性。
  // 交给调用方传的话，哪个调用方忘了传，哪个就裸奔——那是安全问题，不只是整洁问题。
  const plan = buildSpawnPlan("/entry.js", GATE, {}, {});

  assert.deepEqual(plan.args, ["/entry.js", "--provider", "deepseek", "-e", "/gate.ts"]);
});

test("调用方的扩展追加在权限门后面", () => {
  const plan = buildSpawnPlan(
    "/entry.js",
    GATE,
    { provider: "anthropic", model: "some-model", extensions: ["/a.ts", "/b.ts"] },
    {},
  );

  assert.deepEqual(plan.args, [
    "/entry.js",
    "--provider",
    "anthropic",
    "--model",
    "some-model",
    "-e",
    "/gate.ts",
    "-e",
    "/a.ts",
    "-e",
    "/b.ts",
  ]);
});

test("环境里必须带上 ELECTRON_RUN_AS_NODE", () => {
  // 在 Electron 主进程里 process.execPath 是 electron.exe 而不是 node.exe。
  // 不设这个变量，electron.exe 会把 rpc-entry.js 当成一个 app 去加载并立刻退出，
  // Pi 根本没跑起来（实测：exit code=0，stdout 只有一个换行，stderr 为空）。
  const plan = buildSpawnPlan("/entry.js", GATE, {}, { PATH: "/usr/bin" });

  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(plan.env.PATH, "/usr/bin", "原有环境变量必须保留");
});
