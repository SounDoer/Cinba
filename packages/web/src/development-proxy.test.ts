import assert from "node:assert/strict";
import test from "node:test";

import { developmentProxy } from "./development-proxy.ts";

test("proxies both Core control surfaces during web development", () => {
  assert.deepEqual(developmentProxy(4518), {
    "/api": { target: "http://127.0.0.1:4518" },
    "/ws": { target: "ws://127.0.0.1:4518", ws: true },
  });
});
