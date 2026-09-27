import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "../tempdir.ts";

const SEAT_ROOM = fileURLToPath(new URL("../../bin/seat-room.mjs", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../..", import.meta.url));

function open(env: Record<string, string>, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SEAT_ROOM, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

const acme = tempDir("sw3-seat-room-kit-");
mkdirSync(join(acme, "harness", "acme"), { recursive: true });
writeFileSync(
  join(acme, "harness", "acme", "harness.json"),
  JSON.stringify({ configDirEnv: "ACME_HOME", provider: { command: ["NODE", "KIT/bin/seat-room.mjs"] } }),
);
const ROWS: [string, string, string, string, string | undefined, string[], number, string | null][] = [
  ["a launch the plugin did not configure", acme, "acme", "ACME_HOME", undefined, ["--print"], 2, null],
  ["one with no arguments", acme, "acme", "ACME_HOME", undefined, [], 2, null],
  [
    "one asking the version among other things",
    acme,
    "acme",
    "ACME_HOME",
    undefined,
    ["--version", "--print"],
    2,
    null,
  ],
  [
    "Paseo asking the version for its model catalog, which starts no session",
    acme,
    "acme",
    "ACME_HOME",
    undefined,
    ["--version"],
    0,
    " --version\n",
  ],
  [
    "a seat the plugin configured",
    acme,
    "acme",
    "ACME_HOME",
    "/seats/acme-peer",
    ["--print"],
    0,
    "/seats/acme-peer --print\n",
  ],
  [
    "a Claude seat, whose settings come from its seat alone and whose thinking the watch reads",
    PLUGIN,
    "claude",
    "CLAUDE_CONFIG_DIR",
    "/seats/claude-peer",
    ["-p"],
    0,
    "/seats/claude-peer -p --setting-sources user --thinking-display summarized\n",
  ],
  [
    "whatever setting sources its caller names",
    PLUGIN,
    "claude",
    "CLAUDE_CONFIG_DIR",
    "/seats/claude-peer",
    ["--setting-sources", "project,local", "-p"],
    0,
    "/seats/claude-peer --setting-sources user -p --thinking-display summarized\n",
  ],
  [
    "and however it names them",
    PLUGIN,
    "claude",
    "CLAUDE_CONFIG_DIR",
    "/seats/claude-peer",
    ["--setting-sources=project", "-p"],
    0,
    "/seats/claude-peer --setting-sources=user -p --thinking-display summarized\n",
  ],
  [
    "and a thinking display its caller would hide",
    PLUGIN,
    "claude",
    "CLAUDE_CONFIG_DIR",
    "/seats/claude-peer",
    ["--thinking-display", "omitted", "-p"],
    0,
    "/seats/claude-peer --thinking-display summarized -p --setting-sources user\n",
  ],
];

test("the seat room starts the agent only on the seat's own settings and with the flags its agent is forced to take, and answers Paseo's version probe unconfigured", async () => {
  for (const [what, kit, harness, configDirEnv, configured, args, code, started] of ROWS) {
    const dir = tempDir("sw3-seat-room-");
    const launched = join(dir, "launched");
    const agent = join(dir, "agent");
    writeFileSync(agent, `#!/bin/sh\necho "$${configDirEnv} $*" > ${JSON.stringify(launched)}\n`);
    chmodSync(agent, 0o755);
    // A token in the env keeps the Claude rows from reading the keychain of the machine the tests run on.
    const env = {
      PATH: process.env.PATH!,
      SEATWORKS_KIT: kit,
      SEATWORKS_HARNESS: harness,
      SEATWORKS_AGENT_BIN: agent,
      CLAUDE_CODE_OAUTH_TOKEN: "unused",
    };
    const ran = await open(configured ? { ...env, [configDirEnv]: configured } : env, args);
    assert.equal(ran.code, code, `${what}: ${ran.stderr}`);
    assert.equal(existsSync(launched) ? readFileSync(launched, "utf-8") : null, started, what);
    if (!started)
      assert.match(
        ran.stderr,
        new RegExp(`^Seat room: ${configDirEnv} is unset, so this seat would run on your own settings`),
        what,
      );
  }
});

/** A seat whose harness names a keychain entry, with a `security` on PATH that answers only for that entry. */
function keyed(stored: string | undefined) {
  const dir = tempDir("sw3-seat-room-key-");
  mkdirSync(join(dir, "harness", "acme"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  writeFileSync(
    join(dir, "harness", "acme", "harness.json"),
    JSON.stringify({ configDirEnv: "ACME_HOME", provider: { keychainEnv: { ACME_TOKEN: "Acme seat token" } } }),
  );
  const launched = join(dir, "launched");
  const agent = join(dir, "agent");
  writeFileSync(agent, `#!/bin/sh\nprintf '%s' "\${ACME_TOKEN:-none}" > ${JSON.stringify(launched)}\n`);
  const security = join(dir, "bin", "security");
  writeFileSync(
    security,
    `#!/bin/sh\n[ "$1 $2 $3" = "find-generic-password -s Acme seat token" ] || exit 44\n${stored === undefined ? "exit 44" : `[ "$4" = "-w" ] && echo ${JSON.stringify(stored)}`}\n`,
  );
  chmodSync(agent, 0o755);
  chmodSync(security, 0o755);
  const env = {
    PATH: `${join(dir, "bin")}:${process.env.PATH!}`,
    SEATWORKS_KIT: dir,
    SEATWORKS_HARNESS: "acme",
    SEATWORKS_AGENT_BIN: agent,
  };
  return { launched, env, configured: { ...env, ACME_HOME: "/seats/acme-peer" } };
}

test("a configured seat is signed in from the keychain entry its harness names, unless its env already holds the token, and an unconfigured launch never reads it", async () => {
  const stored = keyed("tok-123");
  assert.equal((await open(stored.configured, ["-p"])).code, 0);
  assert.equal(readFileSync(stored.launched, "utf-8"), "tok-123");

  const own = keyed("tok-123");
  assert.equal((await open({ ...own.configured, ACME_TOKEN: "own" }, ["-p"])).code, 0);
  assert.equal(readFileSync(own.launched, "utf-8"), "own");

  const missing = keyed(undefined);
  assert.equal((await open(missing.configured, ["-p"])).code, 0);
  assert.equal(readFileSync(missing.launched, "utf-8"), "none");

  const unconfigured = keyed("tok-123");
  assert.equal((await open(unconfigured.env, ["-p"])).code, 2);
  assert.equal(existsSync(unconfigured.launched), false);
});
