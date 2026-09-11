// End to end: does adding a provider key actually put its models within reach?
//
// The rest of this package is tested as pure functions, which is the right
// shape for a policy but the wrong shape for this. What broke here was never a
// wrong answer from a function: it was that a Pi child process reads the
// credential file once, at startup, so a key added later was invisible to it
// while every function involved behaved exactly as written. Only a real core,
// with a real Pi under it, can show that.
//
// It runs against a temporary home directory, so it never reads or writes the
// real ~/.pi/agent/auth.json or ~/.cinba/config.json. The key it adds is not a
// real one and is never used to call anybody: listing a provider's models needs
// a credential to exist, not a credential that works.
//
// Slow (it starts processes), so it is not part of `npm test`. Run it with
// `npm run test:e2e`.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";

/** A port of its own, so a core the developer is already running is left alone. */
const PORT = "4599";
const PROVIDER = "moonshotai-cn";

type Message = { type: string; [key: string]: unknown };
type Model = { provider: string; id: string };

let home: string;
let server: ChildProcess;
let socket: WebSocket;

/**
 * Everything the core has said, in order.
 *
 * Buffered rather than awaited one listener at a time: a restart announces
 * itself when it is ready, not when a test happens to be watching, and a
 * message that arrived between two tests must still be there to be read.
 */
const inbox: Message[] = [];
let arrived: (() => void) | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Take the first message of this type out of the inbox, waiting for one if need be. */
async function nextOfType(type: string, timeoutMs = 30_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const index = inbox.findIndex((message) => message.type === type);
    if (index >= 0) return inbox.splice(index, 1)[0]!;
    if (Date.now() >= deadline) throw new Error(`the core never sent a ${type}`);
    await new Promise<void>((resolve) => {
      arrived = resolve;
      setTimeout(resolve, 50);
    });
  }
}

function send(message: Message): void {
  socket.send(JSON.stringify(message));
}

/** Ask for the model list and answer with the models of one provider. */
async function modelsOf(provider: string): Promise<Model[]> {
  send({ type: "list_models" });
  const listing = await nextOfType("model_listing");
  return (listing.models as Model[]).filter((model) => model.provider === provider);
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "cinba-e2e-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  // No credentials at all, which is where a fresh machine starts.
  writeFileSync(join(home, ".pi", "agent", "auth.json"), "{}", "utf8");

  server = spawn(process.execPath, ["--experimental-strip-types", "packages/server/src/index.ts"], {
    // The whole home directory rather than PI_CODING_AGENT_DIR, which is what
    // the credential tests redirect: a core writes ~/.cinba/config.json as
    // well, and a test run must not decide which conversation the developer's
    // own core opens next. USERPROFILE is what homedir() reads on Windows,
    // HOME everywhere else.
    env: { ...process.env, USERPROFILE: home, HOME: home, CINBA_PORT: PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.setEncoding("utf8");
  server.stderr?.on("data", (chunk: string) => process.stderr.write(`[core] ${chunk}`));

  // A core that has to be loaded from a cold cache takes several seconds to
  // reach its first listen, so this waits well past what a warm one needs. An
  // exit is not worth waiting through: the port will never open.
  let exited: string | undefined;
  server.once("exit", (code) => {
    exited = `the core exited with code ${String(code)} before it listened`;
  });

  const givingUpAt = Date.now() + 60_000;
  for (;;) {
    try {
      socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      break;
    } catch (error) {
      if (exited) throw new Error(exited);
      if (Date.now() >= givingUpAt) throw error;
      await sleep(250);
    }
  }

  socket.on("message", (data: unknown) => {
    inbox.push(JSON.parse(String(data)) as Message);
    arrived?.();
  });

  await nextOfType("session_opened");
});

after(async () => {
  socket?.close();
  server?.kill("SIGTERM");
  await sleep(1500);
  server?.kill("SIGKILL");
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // A file still held open on Windows is not worth failing the run over.
  }
});

test("a conversation on a machine with no credentials offers no models", async () => {
  assert.deepEqual(await modelsOf(PROVIDER), []);
});

test("adding a key puts that provider's models in the list, with nothing reopened by hand", async () => {
  send({ type: "set_api_key", providerId: PROVIDER, apiKey: "sk-not-a-real-key" });

  const listing = await nextOfType("provider_listing");
  const provider = (listing.providers as { id: string; configured: boolean }[]).find(
    (entry) => entry.id === PROVIDER,
  );
  assert.equal(provider?.configured, true, "the provider should report itself configured");

  // The conversation's Pi is replaced and the conversation handed back. Without
  // that, the list below still comes from the process that started before the key.
  await nextOfType("session_opened");

  assert.ok((await modelsOf(PROVIDER)).length > 0, `expected models from ${PROVIDER}`);
});

test("and the conversation can be switched onto one of them", async () => {
  const [target] = await modelsOf(PROVIDER);
  assert.ok(target, "the previous test should have left models to switch to");

  send({ type: "set_model", provider: target.provider, modelId: target.id });
  const changed = await nextOfType("model_changed");
  assert.deepEqual(changed.model, { provider: target.provider, id: target.id });
});

test("removing that key leaves the conversation alive rather than on a model it cannot reach", async () => {
  send({ type: "clear_credential", providerId: PROVIDER });
  await nextOfType("provider_listing");
  await nextOfType("session_opened");

  assert.deepEqual(await modelsOf(PROVIDER), []);
});
