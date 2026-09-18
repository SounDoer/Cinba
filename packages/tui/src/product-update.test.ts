import assert from "node:assert/strict";
import { resolve as resolvePath } from "node:path";
import test from "node:test";
import type { UpdateState } from "@cinba/installer";
import {
  createDeferredReadyNotice,
  createTuiUpdateConsumer,
  startProductUpdateObserver,
} from "./product-update.ts";

const stateDirectory = resolvePath("state");

const baseState = {
  schemaVersion: 1,
  currentVersion: "0.1.0",
  checkedAt: "2026-09-18T07:00:00.000Z",
  candidate: null,
  failure: null,
} as const;

const candidate = {
  version: "0.2.0",
  revision: "b".repeat(40),
  target: "windows-x64",
  artifactPath: null,
  sha256: "c".repeat(64),
  size: 123,
  releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.2.0",
} as const;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("development TUI without the installed state env does not watch", () => {
  let scheduled = 0;
  const observer = startProductUpdateObserver(
    { environment: {}, onUpdate: () => assert.fail("unexpected update") },
    {
      readState: async () => undefined,
      setInterval: () => {
        scheduled += 1;
        return { unref() {} };
      },
      clearInterval: () => {},
    },
  );

  assert.equal(observer, undefined);
  assert.equal(scheduled, 0);
});

test("observer maps shared states, silences failures, and unreferences its timer", async () => {
  const states: Array<UpdateState | Error | undefined> = [
    { ...baseState, phase: "checking" },
    { ...baseState, phase: "downloading", candidate },
    {
      ...baseState,
      phase: "ready",
      candidate: { ...candidate, artifactPath: resolvePath("cache", "cinba.zip") },
    },
    { ...baseState, phase: "failed", failure: "discovery-failed" },
    new Error("partial write"),
  ];
  const updates: string[] = [];
  let tick: (() => void) | undefined;
  let unreferenced = false;
  let cleared = false;

  const observer = startProductUpdateObserver(
    {
      environment: { CINBA_UPDATE_STATE_DIR: stateDirectory },
      onUpdate: (update) =>
        updates.push(
          update.phase === "ready" ? `${update.phase}:${update.candidateVersion}` : update.phase,
        ),
    },
    {
      readState: async () => {
        const next = states.shift();
        if (next instanceof Error) {
          throw next;
        }
        return next;
      },
      setInterval: (callback) => {
        tick = callback;
        return {
          unref() {
            unreferenced = true;
          },
        };
      },
      clearInterval: () => {
        cleared = true;
      },
    },
  );

  await flush();
  for (let index = 0; index < 4; index += 1) {
    tick?.();
    await flush();
  }

  assert.deepEqual(updates, ["checking", "downloading", "ready:0.2.0", "idle"]);
  assert.equal(unreferenced, true);
  observer?.dispose();
  assert.equal(cleared, true);
});

test("dispose and abort stop observations and late callbacks", async () => {
  let tick: (() => void) | undefined;
  let reads = 0;
  const updates: string[] = [];
  const controller = new AbortController();
  let resolveRead!: (state: UpdateState | undefined) => void;
  const pendingRead = new Promise<UpdateState | undefined>((resolve) => {
    resolveRead = resolve;
  });
  const observer = startProductUpdateObserver(
    {
      environment: { CINBA_UPDATE_STATE_DIR: stateDirectory },
      signal: controller.signal,
      onUpdate: (update) => updates.push(update.phase),
    },
    {
      readState: async () => {
        reads += 1;
        return pendingRead;
      },
      setInterval: (callback) => {
        tick = callback;
        return { unref() {} };
      },
      clearInterval: () => {},
    },
  );

  controller.abort();
  resolveRead({ ...baseState, phase: "checking" });
  await flush();
  tick?.();
  await flush();

  assert.deepEqual(updates, []);
  assert.equal(reads, 1);
  observer?.dispose();
});

test("ready notice appears once per version while every state change renders", () => {
  const statuses: string[] = [];
  const notices: string[] = [];
  let renders = 0;
  const consume = createTuiUpdateConsumer({
    setStatus: (update) => statuses.push(update.phase),
    appendNotice: (notice) => notices.push(notice),
    requestRender: () => {
      renders += 1;
    },
  });

  consume({ phase: "checking" });
  consume({ phase: "downloading" });
  consume({ phase: "ready", candidateVersion: "0.2.0" });
  consume({ phase: "idle" });
  consume({ phase: "ready", candidateVersion: "0.2.0" });

  assert.deepEqual(statuses, ["checking", "downloading", "ready", "idle", "ready"]);
  assert.deepEqual(notices, ["Cinba 0.2.0 is ready. Type /update to install."]);
  assert.equal(renders, 5);
});

test("continuous polls of one installation failure append one notice", () => {
  const notices: string[] = [];
  const consume = createTuiUpdateConsumer({
    setStatus: () => {},
    appendNotice: (notice) => notices.push(notice),
    requestRender: () => {},
  });
  const failed = {
    phase: "failed" as const,
    candidateVersion: "0.2.0",
    message: "Cinba 0.2.0 could not be installed. Run cinba update to retry.",
  };

  consume(failed);
  consume(failed);

  assert.deepEqual(notices, [failed.message]);
});

test("blocked update notice appears once and defers while the transcript is busy", () => {
  const notices: string[] = [];
  let busy = true;
  const consume = createTuiUpdateConsumer({
    setStatus: () => {},
    appendNotice: (notice) => notices.push(notice),
    requestRender: () => {},
    canAppendNotice: () => !busy,
  });
  const blocked = {
    phase: "blocked" as const,
    reason: "incompatible" as const,
    candidateVersion: "0.2.0",
    message:
      "Cinba 0.2.0 requires a newer system and cannot be installed. Run cinba update for details.",
  };

  consume(blocked);
  consume(blocked);
  assert.deepEqual(notices, []);
  busy = false;
  consume.flushNotice();
  consume.flushNotice();
  consume(blocked);
  assert.deepEqual(notices, [blocked.message]);
});

test("blocked notice is cancelled when the update transitions", () => {
  for (const transition of [
    { phase: "ready" as const, candidateVersion: "0.2.0" },
    { phase: "current" as const },
    { phase: "idle" as const },
    {
      phase: "blocked" as const,
      reason: "unverified" as const,
      candidateVersion: "0.2.0",
      message: "compatibility unknown",
    },
  ]) {
    const notices: string[] = [];
    let busy = true;
    const consume = createTuiUpdateConsumer({
      setStatus: () => {},
      appendNotice: (notice) => notices.push(notice),
      requestRender: () => {},
      canAppendNotice: () => !busy,
    });
    consume({
      phase: "blocked",
      reason: "incompatible",
      candidateVersion: "0.2.0",
      message: "requires newer system",
    });
    consume(transition);
    busy = false;
    consume.flushNotice();
    assert.equal(notices.includes("requires newer system"), false, transition.phase);
  }
});

test("every non-failed state starts a new failure attempt for the same version", () => {
  const failed = {
    phase: "failed" as const,
    candidateVersion: "0.2.0",
    message: "Cinba 0.2.0 could not be installed. Run cinba update to retry.",
  };
  for (const transition of [
    { phase: "ready" as const, candidateVersion: "0.2.0" },
    { phase: "checking" as const },
    { phase: "current" as const },
    { phase: "idle" as const },
  ]) {
    const notices: string[] = [];
    const consume = createTuiUpdateConsumer({
      setStatus: () => {},
      appendNotice: (notice) => notices.push(notice),
      requestRender: () => {},
    });
    consume(failed);
    consume(transition);
    consume(failed);
    assert.equal(notices.filter((notice) => notice === failed.message).length, 2, transition.phase);
  }
});

test("installation failure notice defers while the transcript is busy", () => {
  const notices: string[] = [];
  let busy = true;
  const consume = createTuiUpdateConsumer({
    setStatus: () => {},
    appendNotice: (notice) => notices.push(notice),
    requestRender: () => {},
    canAppendNotice: () => !busy,
  });
  const failed = {
    phase: "failed" as const,
    candidateVersion: "0.2.0",
    message: "Cinba 0.2.0 could not be installed. Run cinba update to retry.",
  };

  consume(failed);
  consume(failed);
  assert.deepEqual(notices, []);
  busy = false;
  consume.flushNotice();
  consume.flushNotice();
  consume(failed);
  assert.deepEqual(notices, ["Cinba 0.2.0 could not be installed. Run cinba update to retry."]);
});

test("busy ready replaced by failed flushes only the current failure", () => {
  const notices: string[] = [];
  let busy = true;
  const consume = createTuiUpdateConsumer({
    setStatus: () => {},
    appendNotice: (notice) => notices.push(notice),
    requestRender: () => {},
    canAppendNotice: () => !busy,
  });
  const failure = "Cinba 0.2.0 could not be installed. Run cinba update to retry.";

  consume({ phase: "ready", candidateVersion: "0.2.0" });
  consume({ phase: "failed", candidateVersion: "0.2.0", message: failure });
  busy = false;
  consume.flushNotice();

  assert.deepEqual(notices, [failure]);
});

test("cancelled ready queue can show the same version when it becomes ready again", () => {
  const notices: string[] = [];
  let busy = true;
  const consume = createTuiUpdateConsumer({
    setStatus: () => {},
    appendNotice: (notice) => notices.push(notice),
    requestRender: () => {},
    canAppendNotice: () => !busy,
  });

  consume({ phase: "ready", candidateVersion: "0.2.0" });
  consume({ phase: "current" });
  busy = false;
  consume({ phase: "ready", candidateVersion: "0.2.0" });

  assert.deepEqual(notices, ["Cinba 0.2.0 is ready. Type /update to install."]);
});

test("busy failed replaced by ready flushes only the current ready notice", () => {
  const notices: string[] = [];
  let busy = true;
  const consume = createTuiUpdateConsumer({
    setStatus: () => {},
    appendNotice: (notice) => notices.push(notice),
    requestRender: () => {},
    canAppendNotice: () => !busy,
  });

  consume({
    phase: "failed",
    candidateVersion: "0.2.0",
    message: "Cinba 0.2.0 could not be installed. Run cinba update to retry.",
  });
  consume({ phase: "ready", candidateVersion: "0.2.0" });
  busy = false;
  consume.flushNotice();

  assert.deepEqual(notices, ["Cinba 0.2.0 is ready. Type /update to install."]);
});

test("ready notice defers while busy, flushes once when idle, and keeps only the latest version", () => {
  const notices = createDeferredReadyNotice();

  assert.equal(notices.receive("0.2.0", false), undefined);
  assert.equal(notices.receive("0.2.0", false), undefined);
  assert.equal(notices.receive("0.3.0", false), undefined);
  assert.equal(notices.flush(true), "Cinba 0.3.0 is ready. Type /update to install.");
  assert.equal(notices.flush(true), undefined);
  assert.equal(notices.receive("0.3.0", true), undefined);
});
