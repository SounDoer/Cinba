import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { removeTemporaryDirectory } from "@cinba/test-support";
import WebSocket from "ws";

const PORT = "4601";
const FAKE_KEY = "exa-e2e-key-not-real";

type Message = { type: string; [key: string]: unknown };

type Inbox = {
  messages: Message[];
  raw: string[];
  arrived?: () => void;
};

let stateDirectory: string;
let agentDirectory: string;
let server: ChildProcess;
let first: WebSocket;
let second: WebSocket;
let firstInbox: Inbox;
let secondInbox: Inbox;
let logs = "";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function nextOfType(inbox: Inbox, type: string, timeoutMs = 30_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const index = inbox.messages.findIndex((message) => message.type === type);
    if (index >= 0) {
      return inbox.messages.splice(index, 1)[0]!;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the core never sent a ${type}`);
    }
    await new Promise<void>((resolve) => {
      inbox.arrived = resolve;
      setTimeout(resolve, 50);
    });
  }
}

async function connect(): Promise<{ socket: WebSocket; inbox: Inbox }> {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const inbox: Inbox = { messages: [], raw: [] };
  socket.on("message", (data) => {
    const raw = String(data);
    inbox.raw.push(raw);
    inbox.messages.push(JSON.parse(raw) as Message);
    inbox.arrived?.();
  });
  return { socket, inbox };
}

async function startCore(): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CINBA_PORT: PORT,
    CINBA_STATE_DIR: stateDirectory,
    PI_CODING_AGENT_DIR: agentDirectory,
  };
  delete environment.EXA_API_KEY;
  delete environment.BRAVE_SEARCH_API_KEY;
  server = spawn(process.execPath, ["--experimental-strip-types", "packages/server/src/index.ts"], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.setEncoding("utf8");
  server.stderr?.setEncoding("utf8");
  server.stdout?.on("data", (chunk: string) => {
    logs += chunk;
  });
  server.stderr?.on("data", (chunk: string) => {
    logs += chunk;
  });

  let exited: string | undefined;
  server.once("exit", (code) => {
    exited = `the core exited with code ${String(code)} before it listened`;
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      ({ socket: first, inbox: firstInbox } = await connect());
      ({ socket: second, inbox: secondInbox } = await connect());
      return;
    } catch (error) {
      if (exited) {
        throw new Error(exited, { cause: error });
      }
      if (Date.now() >= deadline) {
        throw error;
      }
      await sleep(250);
    }
  }
}

async function stopCore(): Promise<void> {
  first?.close();
  second?.close();
  if (!server || server.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  server.kill("SIGTERM");
  await Promise.race([exited, sleep(5_000)]);
  if (server.exitCode === null) {
    server.kill("SIGKILL");
  }
}

function send(socket: WebSocket, message: Message): void {
  socket.send(JSON.stringify(message));
}

before(async () => {
  stateDirectory = mkdtempSync(join(tmpdir(), "cinba-web-tools-e2e-"));
  agentDirectory = join(stateDirectory, "pi-agent");
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(join(agentDirectory, "auth.json"), "{}", "utf8");
  writeFileSync(
    join(stateDirectory, "credentials.json"),
    JSON.stringify({ otherNamespace: { remains: true } }),
    "utf8",
  );
  await startCore();
});

after(async () => {
  await stopCore();
  try {
    // The Core owns this directory until it is gone, so removal stays here rather
    // than with the temporaryDirectory helper, whose hook would run first.
    await removeTemporaryDirectory(stateDirectory);
  } catch {
    // A Windows process may briefly retain a handle after termination.
  }
});

test("fresh clients see the keyless DuckDuckGo fallback", async () => {
  send(first, { type: "get_web_tools_status" });
  const message = await nextOfType(firstInbox, "web_tools_status");
  const status = message.status as { primary: string; effectiveOrder: string[] };

  assert.equal(status.primary, "auto");
  assert.deepEqual(status.effectiveOrder, ["duckduckgo"]);
});

test("setting a key persists it while broadcasting only redacted status", async () => {
  send(first, { type: "set_web_tools_api_key", providerId: "exa", apiKey: FAKE_KEY });
  const [toFirst, toSecond] = await Promise.all([
    nextOfType(firstInbox, "web_tools_status"),
    nextOfType(secondInbox, "web_tools_status"),
  ]);
  const document = JSON.parse(
    readFileSync(join(stateDirectory, "credentials.json"), "utf8"),
  ) as Record<string, unknown>;

  assert.equal(JSON.stringify(document).includes(FAKE_KEY), true);
  assert.deepEqual(document.otherNamespace, { remains: true });
  assert.equal(JSON.stringify([toFirst, toSecond]).includes(FAKE_KEY), false);
  assert.equal([...firstInbox.raw, ...secondInbox.raw].join("\n").includes(FAKE_KEY), false);
});

test("changing primary broadcasts to both clients and persists in Local Settings", async () => {
  send(first, { type: "set_web_search_primary", primary: "brave" });
  const [toFirst, toSecond] = await Promise.all([
    nextOfType(firstInbox, "web_tools_status"),
    nextOfType(secondInbox, "web_tools_status"),
  ]);
  const firstStatus = toFirst.status as { primary: string };
  const secondStatus = toSecond.status as { primary: string };
  const settings = JSON.parse(
    readFileSync(join(stateDirectory, "local-settings.json"), "utf8"),
  ) as {
    webTools?: { searchPrimary?: string };
  };

  assert.equal(firstStatus.primary, "brave");
  assert.equal(secondStatus.primary, "brave");
  assert.equal(settings.webTools?.searchPrimary, "brave");
});

test("clearing removes only the selected stored key", async () => {
  send(first, { type: "clear_web_tools_api_key", providerId: "exa" });
  await Promise.all([
    nextOfType(firstInbox, "web_tools_status"),
    nextOfType(secondInbox, "web_tools_status"),
  ]);
  const document = JSON.parse(readFileSync(join(stateDirectory, "credentials.json"), "utf8")) as {
    webTools?: { exa?: unknown };
    otherNamespace?: unknown;
  };

  assert.equal(document.webTools?.exa, undefined);
  assert.deepEqual(document.otherNamespace, { remains: true });
});

test("primary survives a real Core restart and no server output contains the key", async () => {
  await stopCore();
  await startCore();
  send(first, { type: "get_web_tools_status" });
  const message = await nextOfType(firstInbox, "web_tools_status");

  assert.equal((message.status as { primary: string }).primary, "brave");
  assert.equal(logs.includes(FAKE_KEY), false);
});
