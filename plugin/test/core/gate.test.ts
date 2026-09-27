import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runGate } from "../../server/core/gate.ts";
import { tempDir } from "../tempdir.ts";

test("the gate reports exit, output tail and timeouts", async () => {
  const dir = tempDir("sw3-gate-");
  const pass = await runGate("echo ok", dir, join(dir, "g1.log"), 10_000);
  assert.equal(pass.ok, true);
  assert.match(pass.tail, /ok/);
  const fail = await runGate("echo broken >&2; exit 3", dir, join(dir, "g2.log"), 10_000);
  assert.deepEqual([fail.ok, fail.code], [false, 3]);
  const slow = await runGate("sleep 5", dir, join(dir, "g3.log"), 300);
  assert.deepEqual([slow.ok, slow.timedOut], [false, true]);
  assert.equal(existsSync(join(dir, "g3.log")), true);

  // A passing suite that leaves something running: the verdict is the command's own exit, not the output's end.
  const started = Date.now();
  const leftBehind = await runGate(
    "echo 'ok 1 - everything passes'; (sleep 1; echo late $((6*7)) >> g4.log) & exit 0",
    dir,
    join(dir, "g4.log"),
    3_000,
  );
  assert.deepEqual([leftBehind.ok, leftBehind.code, leftBehind.timedOut], [true, 0, false]);
  assert.equal(Date.now() - started < 1_000, true, "and it answers when the command does, not when the limit runs out");
  assert.match(leftBehind.tail, /everything passes/);
  // What it left running is stopped with the verdict; nothing else would stop it writing into the log.
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  assert.doesNotMatch(
    readFileSync(join(dir, "g4.log"), "utf-8"),
    /late 42/,
    "the log line the command itself echoes is not a leftover writing",
  );

  // The tail is read from the end, since reading the whole log back throws past half a gigabyte.
  const noisy = await runGate(
    "head -c 3000000 /dev/zero | tr '\\0' 'x'; echo; echo 'the last line is the reason'; exit 1",
    dir,
    join(dir, "g5.log"),
    20_000,
  );
  assert.equal(noisy.code, 1);
  assert.match(
    noisy.tail,
    /the last line is the reason/,
    "the reason is at the end, which is the part that has to survive",
  );
  assert.equal(noisy.tail.length <= 3000, true);
});
