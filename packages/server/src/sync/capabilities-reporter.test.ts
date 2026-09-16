import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilitiesReport } from "@cinba/sync-contract";
import { createCapabilitiesReporter } from "./capabilities-reporter.ts";

test("capabilities are secret-free, reported on change, and retried after failure", async () => {
  const reports: CapabilitiesReport[] = [];
  let revision = 1;
  let fail = false;
  const reporter = createCapabilitiesReporter({
    remote: () => ({
      report: async (report) => {
        if (fail) {
          throw new Error("offline");
        }
        reports.push(report);
      },
    }),
    appVersion: "1.0.0",
    capabilities: () => ({
      version: 1,
      providers: [{ id: "deepseek", name: "DeepSeek", authKind: "api-key" }],
      models: [{ provider: "deepseek", id: "chat" }],
    }),
    syncState: () => ({ currentSyncRevision: revision }),
  });

  assert.equal(await reporter.reportIfChanged(), true);
  assert.equal(await reporter.reportIfChanged(), false);
  revision = 2;
  assert.equal(await reporter.reportIfChanged(), true);
  fail = true;
  revision = 3;
  await assert.rejects(reporter.reportIfChanged(), /offline/);
  fail = false;
  assert.equal(await reporter.reportIfChanged(), true);
  assert.equal(JSON.stringify(reports).includes("apiKey"), false);
  assert.equal(JSON.stringify(reports).includes("secret-value"), false);
});
