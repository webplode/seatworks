import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../tempdir.ts";

const SEAT_ROOM = new URL("../../bin/seat-room", import.meta.url).pathname;

function seat(baseProvider: string) {
  const dir = tempDir("sw2-seat-room-");
  mkdirSync(join(dir, "harness", "acme"), { recursive: true });
  writeFileSync(join(dir, "harness", "acme", "harness.json"), JSON.stringify({ baseProvider, configDirEnv: "ACME_HOME", provider: { command: ["KIT/bin/seat-room", "acp"] } }));
  const launched = join(dir, "launched");
  const agent = join(dir, "agent");
  // Configured, it records how it was started; unconfigured, it answers ACP and records each call.
  writeFileSync(
    agent,
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
if (process.env.ACME_HOME) { writeFileSync(${JSON.stringify(launched)}, process.env.ACME_HOME + " " + process.argv.slice(2).join(" ") + "\\n"); process.exit(0); }
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  appendFileSync(${JSON.stringify(launched)}, m.method + "\\n");
  const result = m.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { loadSession: true } } : { sessionId: "s1", modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] }, configOptions: [{ id: "model", category: "model", currentValue: "m1", options: [{ value: "m1", name: "M1" }] }] };
  if (m.method === "session/new") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } }) + "\\n");
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
`,
  );
  chmodSync(agent, 0o755);
  return { launched, env: { PATH: process.env.PATH!, SEATWORKS_KIT: dir, SEATWORKS_HARNESS: "acme", SEATWORKS_AGENT_BIN: agent } };
}

function open(env: Record<string, string>, messages: object[], args = ["acp"]): Promise<{ code: number | null; replies: any[]; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(SEAT_ROOM, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolve({ code, stderr, replies: out.split("\n").filter(Boolean).map((line) => JSON.parse(line)) }));
    child.stdin.end(messages.map((message) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`).join(""));
  });
}

const PROBE = [
  { id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } },
  { method: "session/update", params: {} },
  { id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } },
  { id: 3, method: "session/set_mode", params: { sessionId: "seat-room", modeId: "bypass" } },
  { id: "4", method: "session/prompt", params: { sessionId: "seat-room", prompt: [{ type: "text", text: "hi" }] } },
];

test("an ACP seat the plugin did not configure lets Paseo list the agent's own models and modes, and refuses everything else", async () => {
  const { launched, env } = seat("acp");
  const { code, replies } = await open(env, PROBE);
  assert.equal(code, 0);
  assert.deepEqual(replies.slice(0, 3), [
    { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } },
    // What the agent says of itself as the session opens reaches Paseo too: it waits for it.
    { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } },
    { jsonrpc: "2.0", id: 2, result: { sessionId: "s1", modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] }, configOptions: [{ id: "model", category: "model", currentValue: "m1", options: [{ value: "m1", name: "M1" }] }] } },
  ]);
  assert.deepEqual(replies.slice(3).map((reply) => [reply.id, reply.result]), [[3, undefined], ["4", undefined]]);
  for (const reply of replies.slice(3)) assert.match(reply.error.message, /^Seat room: ACME_HOME is unset, so this seat would run on your own settings/);
  // A prompt run on the owner's own settings is what the refusal is for: it never reaches the agent.
  assert.equal(readFileSync(launched, "utf-8"), "initialize\nsession/new\n");
});

test("any other launch the plugin did not configure is refused outright", async () => {
  for (const [baseProvider, args] of [["claude", ["acp"]], ["acp", ["--version"]], ["acp", []]] as const) {
    const { launched, env } = seat(baseProvider);
    const { code, replies, stderr } = await open(env, PROBE, [...args]);
    assert.equal(code, 2, `${baseProvider} ${args.join(" ")}`);
    assert.equal(existsSync(launched), false);
    assert.deepEqual(replies, []);
    assert.match(stderr, /ACME_HOME is unset/);
  }
});

test("a seat the plugin configured starts the agent on its own settings", async () => {
  const { launched, env } = seat("acp");
  const { code, replies } = await open({ ...env, ACME_HOME: "/seats/acme-peer" }, PROBE);
  assert.equal(code, 0);
  assert.deepEqual(replies, []);
  assert.equal(readFileSync(launched, "utf-8"), "/seats/acme-peer acp\n");
});

/** A seat whose harness names a keychain entry, with a `security` on PATH that answers only for that entry. */
function keyed(stored: string | undefined) {
  const dir = tempDir("sw2-seat-room-key-");
  mkdirSync(join(dir, "harness", "acme"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "harness", "acme", "harness.json"), JSON.stringify({ baseProvider: "claude", configDirEnv: "ACME_HOME", provider: { keychainEnv: { ACME_TOKEN: "Acme seat token" } } }));
  const launched = join(dir, "launched");
  const agent = join(dir, "agent");
  writeFileSync(agent, `#!/bin/sh\nprintf '%s' "\${ACME_TOKEN:-none}" > ${JSON.stringify(launched)}\n`);
  const security = join(dir, "bin", "security");
  writeFileSync(security, `#!/bin/sh\n[ "$1 $2 $3" = "find-generic-password -s Acme seat token" ] || exit 44\n${stored === undefined ? "exit 44" : `[ "$4" = "-w" ] && echo ${JSON.stringify(stored)}`}\n`);
  chmodSync(agent, 0o755);
  chmodSync(security, 0o755);
  return { launched, env: { PATH: `${join(dir, "bin")}:${process.env.PATH!}`, SEATWORKS_KIT: dir, SEATWORKS_HARNESS: "acme", SEATWORKS_AGENT_BIN: agent, ACME_HOME: "/seats/acme-peer" } };
}

test("a configured seat is signed in from the keychain entry its harness names", async () => {
  const { launched, env } = keyed("tok-123");
  assert.equal((await open(env, [], [])).code, 0);
  assert.equal(readFileSync(launched, "utf-8"), "tok-123");
});

test("a token already in the seat's env is kept, and a missing keychain entry still starts the agent", async () => {
  const set = keyed("tok-123");
  assert.equal((await open({ ...set.env, ACME_TOKEN: "own" }, [], [])).code, 0);
  assert.equal(readFileSync(set.launched, "utf-8"), "own");
  const missing = keyed(undefined);
  assert.equal((await open(missing.env, [], [])).code, 0);
  assert.equal(readFileSync(missing.launched, "utf-8"), "none");
});

test("a launch the plugin did not configure never reads the keychain", async () => {
  const { launched, env } = keyed("tok-123");
  const { ACME_HOME: _, ...unconfigured } = env;
  const { code } = await open(unconfigured, [], []);
  assert.equal(code, 2);
  assert.equal(existsSync(launched), false);
});
