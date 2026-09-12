import { test } from "node:test";
import assert from "node:assert/strict";
import { activatePreparedRelease } from "./activate-release.ts";

const OPTIONS = {
  releasesRoot: "/home/cinba/releases",
  currentLink: "/home/cinba/current",
  targetRevision: "abcdef1234567890abcdef1234567890abcdef12",
  expectedCurrentRevision: "1234567890abcdef1234567890abcdef12345678",
};

test("the old core is fully stopped before current is switched", async () => {
  const events: string[] = [];
  await activatePreparedRelease(OPTIONS, {
    async stopService() {
      events.push("stopped");
    },
    async switchRelease(options) {
      events.push("switched");
      assert.deepEqual(options, OPTIONS);
    },
  });
  assert.deepEqual(events, ["stopped", "switched"]);
});

test("a drain failure leaves current untouched", async () => {
  let switched = false;
  await assert.rejects(
    activatePreparedRelease(OPTIONS, {
      async stopService() {
        throw new Error("drain failed");
      },
      async switchRelease() {
        switched = true;
      },
    }),
    /drain failed/,
  );
  assert.equal(switched, false);
});
