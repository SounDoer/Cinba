import assert from "node:assert/strict";
import test from "node:test";
import type { ClientMessage, ServerMessage, WebToolsStatus } from "@cinba/contract";
import { handleWebToolsMessage } from "./web-tools-messages.ts";
import type { WebToolsService } from "./web-tools-service.ts";

const STATUS: WebToolsStatus = {
  primary: "auto",
  effectiveOrder: ["duckduckgo"],
  providers: [],
};

test("reads reply only to the requester while successful mutations broadcast", () => {
  const sent: ServerMessage[] = [];
  const broadcasts: ServerMessage[] = [];
  const calls: string[] = [];
  const service: WebToolsService = {
    getStatus: () => STATUS,
    configure: (provider) => {
      calls.push(`configure:${provider}`);
      return STATUS;
    },
    remove: (provider) => {
      calls.push(`remove:${provider}`);
      return STATUS;
    },
    choosePrimary: (primary) => {
      calls.push(`primary:${primary}`);
      return STATUS;
    },
  };
  const handle = (message: ClientMessage) =>
    handleWebToolsMessage(message, {
      service,
      send: (reply) => sent.push(reply),
      broadcast: (reply) => broadcasts.push(reply),
    });

  assert.equal(handle({ type: "get_web_tools_status" }), true);
  assert.equal(
    handle({ type: "set_web_tools_api_key", providerId: "exa", apiKey: "secret" }),
    true,
  );
  assert.equal(handle({ type: "clear_web_tools_api_key", providerId: "brave" }), true);
  assert.equal(handle({ type: "set_web_search_primary", primary: "brave" }), true);
  assert.equal(handle({ type: "abort" }), false);

  assert.deepEqual(sent, [{ type: "web_tools_status", status: STATUS }]);
  assert.deepEqual(broadcasts, [
    { type: "web_tools_status", status: STATUS },
    { type: "web_tools_status", status: STATUS },
    { type: "web_tools_status", status: STATUS },
  ]);
  assert.deepEqual(calls, ["configure:exa", "remove:brave", "primary:brave"]);
});

test("a failed mutation replies safely without broadcasting raw error details", () => {
  const sent: ServerMessage[] = [];
  const broadcasts: ServerMessage[] = [];
  const service: WebToolsService = {
    getStatus: () => STATUS,
    configure: () => {
      throw new Error("disk failed while writing secret-value");
    },
    remove: () => STATUS,
    choosePrimary: () => STATUS,
  };

  handleWebToolsMessage(
    { type: "set_web_tools_api_key", providerId: "exa", apiKey: "secret-value" },
    {
      service,
      send: (reply) => sent.push(reply),
      broadcast: (reply) => broadcasts.push(reply),
    },
  );

  assert.deepEqual(sent, [
    {
      type: "web_tools_status",
      status: STATUS,
      error: "Could not access web tools settings",
    },
  ]);
  assert.deepEqual(broadcasts, []);
  assert.equal(JSON.stringify(sent).includes("secret-value"), false);
});
