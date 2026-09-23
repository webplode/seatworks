import assert from "node:assert/strict";
import { test } from "node:test";
import { Relink } from "../../server/runtime/relink.ts";

test("a lost link reloads the plugin, once per gap", () => {
  let reloads = 0;
  const relink = new Relink(() => reloads++, 60_000);
  assert.equal(relink.failed("Error: Transport not connected (status: disconnected)", 1_000), true);
  assert.equal(relink.failed("Error: Transport not connected (status: disconnected)", 31_000), false);
  assert.equal(reloads, 1);
  assert.equal(relink.failed("Error: Transport not connected (status: disconnected)", 61_000), true);
  assert.equal(reloads, 2);
});

test("a closing transport or any other failure does not reload", () => {
  let reloads = 0;
  const relink = new Relink(() => reloads++, 60_000);
  assert.equal(relink.failed("Error: Transport closed", 1_000), false);
  assert.equal(relink.failed("Error: Daemon client is disposed", 2_000), false);
  assert.equal(relink.failed("Error: ENOENT: no such file", 3_000), false);
  assert.equal(relink.failed("MCP server: Transport not connected", 4_000), false);
  assert.equal(reloads, 0);
});
