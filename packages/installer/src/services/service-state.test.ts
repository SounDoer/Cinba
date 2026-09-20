import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "@cinba/test-support";
import {
  createDefaultServiceState,
  parseServiceState,
  readServiceState,
  writeServiceState,
} from "./service-state.ts";

test("default service intent keeps Core on-demand and Sync disabled", () => {
  const state = createDefaultServiceState(new Date("2026-09-17T00:00:00.000Z"));
  assert.equal(state.core.mode, "on-demand");
  assert.equal(state.sync.mode, "disabled");
  assert.deepEqual(parseServiceState(state), state);
});

test("service state rejects unknown schemas and inconsistent success", () => {
  const state = createDefaultServiceState();
  assert.throws(() => parseServiceState({ ...state, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(
    () =>
      parseServiceState({
        ...state,
        core: { ...state.core, desiredMode: "background" },
      }),
    /stable service state is inconsistent/,
  );
  assert.throws(
    () => parseServiceState({ ...state, secret: "must not be accepted" }),
    /fields are invalid/,
  );
});

test("service state is atomically persisted outside a release", async (t) => {
  const root = temporaryDirectory("cinba-service-state-", t);
  const stateDirectory = join(root, "state");
  assert.equal(await readServiceState(stateDirectory), undefined);
  const state = createDefaultServiceState(new Date("2026-09-17T00:00:00.000Z"));
  await writeServiceState(stateDirectory, state);
  assert.deepEqual(await readServiceState(stateDirectory), state);
});
