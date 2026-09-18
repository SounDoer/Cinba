import assert from "node:assert/strict";
import test from "node:test";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentActivity } from "@cinba/contract";
import { BOLD, DIM, RESET, YELLOW } from "./theme.ts";
import { StatusBar, formatProductUpdate } from "./status-bar.ts";

test("update status hides idle and current and styles active phases", () => {
  assert.equal(formatProductUpdate({ phase: "idle" }), "");
  assert.equal(formatProductUpdate({ phase: "current" }), "");
  assert.equal(formatProductUpdate({ phase: "checking" }), `${DIM} · checking update${RESET}`);
  assert.equal(
    formatProductUpdate({ phase: "downloading" }),
    `${DIM} · downloading update${RESET}`,
  );
  assert.equal(
    formatProductUpdate({ phase: "ready", candidateVersion: "0.2.0" }),
    `${YELLOW}${BOLD} · Update 0.2.0 Ready${RESET}`,
  );
  assert.equal(
    formatProductUpdate({
      phase: "failed",
      candidateVersion: "0.2.0",
      message: "Cinba 0.2.0 could not be installed. Run cinba update to retry.",
    }),
    `${YELLOW}${BOLD} · Update 0.2.0 Failed${RESET}`,
  );
});

test("status bar keeps existing fields and truncates update ANSI at narrow widths", () => {
  const status = new StatusBar();
  status.model = "example-model";
  status.update = { phase: "ready", candidateVersion: "0.2.0" };

  const full = status.render(500)[0]!;
  assert.match(full, /context unavailable/);
  assert.match(full, /example-model/);
  assert.match(full, /Update 0\.2\.0 Ready/);
  assert.ok(full.includes(`${RESET}    ${DIM}context unavailable`));
  const narrow = status.render(92)[0]!;
  assert.match(narrow, /Update/);
  assert.equal(narrow, truncateToWidth(full, 92));
});

test("80-column status keeps every active update visible ahead of long metadata", () => {
  const updates = [
    { update: { phase: "checking" } as const, expected: /checking update/ },
    { update: { phase: "downloading" } as const, expected: /downloading update/ },
    {
      update: { phase: "ready", candidateVersion: "123.45.67" } as const,
      expected: /Update 123\.45\.67 Ready/,
    },
  ];

  for (const { update, expected } of updates) {
    const status = new StatusBar();
    status.context = {
      tokens: 120_000,
      contextWindow: 200_000,
      percent: 60,
      estimated: false,
    };
    status.core = "A Very Long Core Name";
    status.model = "provider/a-very-long-model-name";
    status.update = update;

    assert.match(status.render(80)[0]!, expected);
  }
});

test("busy activities stay clear beside an update at 80 columns", () => {
  const activities = [
    { activity: { type: "answering" }, expected: /answering.*Enter steer/ },
    { activity: { type: "tool", toolName: "read_file" }, expected: /running read_file/ },
    {
      activity: { type: "permission", toolName: "write_file" },
      expected: /waiting for permission/,
    },
    {
      activity: {
        type: "retrying",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 10_000,
        retryAt: Date.now() + 10_000,
        errorMessage: "temporary failure",
      },
      expected: /retrying 1\/3/,
    },
    { activity: { type: "compacting" }, expected: /compacting context/ },
  ] satisfies Array<{ activity: AgentActivity; expected: RegExp }>;

  for (const { activity, expected } of activities) {
    const status = new StatusBar();
    status.context = {
      tokens: 120_000,
      contextWindow: 200_000,
      percent: 60,
      estimated: false,
    };
    status.core = "A Very Long Core Name";
    status.model = "provider/a-very-long-model-name";
    status.update = { phase: "ready", candidateVersion: "123.45.67" };
    status.activity = activity;

    const rendered = status.render(80)[0]!;
    assert.match(rendered, /Update 123\.45\.67 Ready/);
    assert.match(rendered, expected);
  }
});
