import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnPlan } from "./pi-process.ts";

const GATE = "/gate.ts";

test("all intrinsic extensions are mounted before caller extensions", () => {
  const plan = buildSpawnPlan(
    "/entry.js",
    [GATE, "/session-edit.ts", "/web-tools.ts"],
    { extensions: ["/caller.ts"] },
    {},
  );

  assert.deepEqual(plan.args.slice(3), [
    "-e",
    GATE,
    "-e",
    "/session-edit.ts",
    "-e",
    "/web-tools.ts",
    "-e",
    "/caller.ts",
  ]);
});

test("deepseek is the default", () => {
  const plan = buildSpawnPlan("/entry.js", [GATE], {}, {});

  assert.deepEqual(plan.args.slice(0, 3), ["/entry.js", "--provider", "deepseek"]);
});

test("the permission gate is always mounted; callers cannot leave it out", () => {
  // The permission gate is not a feature of some frontend but an intrinsic
  // property of this agent. Left to callers, whichever caller forgets it runs
  // unguarded — a security problem, not merely an untidy one.
  const plan = buildSpawnPlan("/entry.js", [GATE], {}, {});

  assert.deepEqual(plan.args, ["/entry.js", "--provider", "deepseek", "-e", "/gate.ts"]);
});

test("caller extensions are appended after the permission gate", () => {
  const plan = buildSpawnPlan(
    "/entry.js",
    [GATE],
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

test("the environment must carry ELECTRON_RUN_AS_NODE", () => {
  // Inside the Electron main process, process.execPath is electron.exe rather
  // than node.exe. Without this variable, electron.exe loads rpc-entry.js as an
  // app and exits immediately, so Pi never runs at all (measured: exit code 0,
  // a single newline on stdout, empty stderr).
  const plan = buildSpawnPlan("/entry.js", [GATE], {}, { PATH: "/usr/bin" });

  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(plan.env.PATH, "/usr/bin", "the existing environment must be preserved");
});

test("a resolved Provider credential is injected through environment, never arguments", () => {
  const plan = buildSpawnPlan(
    "/entry.js",
    [GATE],
    { provider: "openai", providerCredential: "selected-secret" },
    { OPENAI_API_KEY: "parent-openai", ANTHROPIC_API_KEY: "parent-anthropic" },
  );
  assert.equal(plan.env.OPENAI_API_KEY, "selected-secret");
  assert.equal(plan.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(plan.args.includes("selected-secret"), false);
  assert.equal(JSON.stringify(plan.args).includes("API_KEY"), false);
});

test("Web tools receive only the Core-owned runtime configuration path", () => {
  const plan = buildSpawnPlan("/entry.js", [GATE], {
    webToolsRuntimeConfig: "C:/state/runtime-web-tools.json",
  });
  assert.equal(plan.env.CINBA_WEB_TOOLS_RUNTIME_CONFIG, "C:/state/runtime-web-tools.json");
});

test("Pi never opens its own Windows terminal window", () => {
  const plan = buildSpawnPlan("/entry.js", [GATE], {}, {});

  assert.equal(plan.windowsHide, true);
});

test("a session path is passed through so a stored conversation can be resumed", () => {
  const plan = buildSpawnPlan("entry.js", ["gate.ts"], {
    sessionPath: "C:/sessions/a.jsonl",
  });

  const at = plan.args.indexOf("--session");
  assert.ok(at > 0, "the session flag has to be there for the history to come back");
  assert.equal(plan.args[at + 1], "C:/sessions/a.jsonl");
});

test("no session path means a fresh conversation", () => {
  const plan = buildSpawnPlan("entry.js", ["gate.ts"], {});
  assert.equal(plan.args.includes("--session"), false);
});

test("an explicit project trust decision is passed to Pi", () => {
  const trusted = buildSpawnPlan("entry.js", ["gate.ts"], { projectTrusted: true });
  const refused = buildSpawnPlan("entry.js", ["gate.ts"], { projectTrusted: false });

  assert.equal(trusted.args.includes("--approve"), true);
  assert.equal(refused.args.includes("--no-approve"), true);
});
