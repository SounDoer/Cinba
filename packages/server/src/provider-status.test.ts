import assert from "node:assert/strict";
import test from "node:test";
import { effectiveProviderStatuses } from "./provider-status.ts";

const local = [
  { id: "deepseek", name: "DeepSeek", configured: true, source: "local-api-key" as const },
  { id: "openai", name: "OpenAI", configured: true, source: "local-oauth" as const },
  { id: "anthropic", name: "Anthropic", configured: false },
];

test("Local Credentials preserves local Provider management", () => {
  assert.deepEqual(effectiveProviderStatuses(local, "local"), [
    { ...local[0], management: "local" },
    { ...local[1], management: "local" },
    { ...local[2], management: "local" },
  ]);
});

test("Shared Credentials exposes Sync keys, local OAuth, and local API-key conflicts", () => {
  assert.deepEqual(effectiveProviderStatuses(local, "sync", new Set(["deepseek", "anthropic"])), [
    {
      id: "deepseek",
      name: "DeepSeek",
      configured: false,
      source: "conflict",
      management: "sync",
    },
    {
      id: "openai",
      name: "OpenAI",
      configured: true,
      source: "local-oauth",
      management: "sync",
    },
    {
      id: "anthropic",
      name: "Anthropic",
      configured: true,
      source: "sync-api-key",
      management: "sync",
    },
  ]);
});
