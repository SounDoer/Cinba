import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnPlan } from "./index.ts";

test("默认走 deepseek，不带 model 与 extension", () => {
  const plan = buildSpawnPlan("/entry.js", {}, {});

  assert.deepEqual(plan.args, ["/entry.js", "--provider", "deepseek"]);
});

test("model 与 extensions 依次追加到参数后面", () => {
  const plan = buildSpawnPlan(
    "/entry.js",
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
    "/a.ts",
    "-e",
    "/b.ts",
  ]);
});

test("环境里必须带上 ELECTRON_RUN_AS_NODE", () => {
  // 在 Electron 主进程里 process.execPath 是 electron.exe 而不是 node.exe。
  // 不设这个变量，electron.exe 会把 rpc-entry.js 当成一个 app 去加载并立刻退出，
  // Pi 根本没跑起来（实测：exit code=0，stdout 只有一个换行，stderr 为空）。
  const plan = buildSpawnPlan("/entry.js", {}, { PATH: "/usr/bin" });

  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(plan.env.PATH, "/usr/bin", "原有环境变量必须保留");
});
