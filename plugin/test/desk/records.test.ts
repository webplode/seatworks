import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { rolledStamps } from "../../server/core/rolling.ts";
import { tempDir } from "../tempdir.ts";
import { appendRolling } from "../../server/core/rolling.ts";
import { type Lane, emptyLedger } from "../../server/desk/ledger.ts";
import { GATE_LOGS_PER_OWNER, tidyRecords } from "../../server/desk/records.ts";

test("a record log rolls over, keeps its newest roll as text for a grep, and packs the older ones and drops what outgrows its bytes", async () => {
  const dir = tempDir("sw2-roll-");
  const line = `${"x".repeat(20)}\n`;
  const roll = { dir, current: "events.log", prefix: "events.", ext: ".log", rotateAt: 2 * line.length, keepBytes: 2 * line.length + 2 * gzipSync(line.repeat(2)).length, plain: 1 };
  for (let index = 0; index < 12; index++) await appendRolling(roll, line);
  const names = readdirSync(dir).sort();
  assert.deepEqual(names.filter((name) => !name.endsWith(".gz")), ["events.00000005.log", "events.log"], names.join(", "));
  assert.deepEqual(names.filter((name) => name.endsWith(".gz")), ["events.00000003.log.gz", "events.00000004.log.gz"]);
  assert.equal(gunzipSync(readFileSync(join(dir, "events.00000003.log.gz"))).toString("utf-8"), line.repeat(2));
  assert.equal(readFileSync(join(dir, "events.log"), "utf-8"), line.repeat(2), "the name agents read stays the live file");
});

test("two rolls close together pack each file once, so neither packing trips over the other's half-written copy", async () => {
  const dir = tempDir("sw2-roll-race-");
  const roll = { dir, current: "events.log", prefix: "events.", ext: ".log", rotateAt: 1, keepBytes: 1 << 20, plain: 0 };
  await appendRolling(roll, "a\n");
  await Promise.all(["b\n", "c\n", "d\n"].map((line) => appendRolling(roll, line)));
  const names = readdirSync(dir);
  assert.deepEqual(names.filter((name) => !name.endsWith(".gz")).sort(), ["events.log"], names.join(", "));
  const packed = rolledStamps(names, roll).map((stamp) => gunzipSync(readFileSync(join(dir, `events.${stamp}.log.gz`))).toString("utf-8"));
  assert.deepEqual(packed, ["a\n", "b\n", "c\n"]);
});

const lane = (id: string): Lane =>
  ({ id, title: id, outcome: "", acceptance: [], outOfScope: [], base: "main", branch: `lane/${id}`, writeSet: [], contracts: [], opener: "s", status: "closed", openedAt: 0, tasks: 0 }) as Lane;

test("a lane in the ledger keeps its records but the gate runs a newer run of the same owner replaced", () => {
  const state = tempDir("sw2-tidy-");
  const gates = join(state, "gates");
  const handbacks = join(state, "handbacks");
  mkdirSync(gates);
  mkdirSync(handbacks);
  const touch = (dir: string, name: string) => writeFileSync(join(dir, name), "x");
  for (let run = 0; run < GATE_LOGS_PER_OWNER + 2; run++) touch(gates, `L1-T1-${1000 - run}.log`);
  touch(gates, "L1-1.log");
  for (let run = 0; run < GATE_LOGS_PER_OWNER + 2; run++) touch(gates, `L9-T1-${1000 - run}.log`);
  for (let run = 0; run < GATE_LOGS_PER_OWNER + 2; run++) touch(handbacks, `L1-T1-${1000 - run}.md`);
  touch(gates, "notes.txt");
  const ledger = emptyLedger();
  ledger.lanes = { L1: lane("L1") };

  tidyRecords(state, ledger);

  const kept = readdirSync(gates);
  assert.deepEqual(kept.filter((name) => name.startsWith("L1-T1-")).sort(), [1000, 996, 997, 998, 999].map((at) => `L1-T1-${at}.log`), "the newest runs of each task");
  assert.ok(kept.includes("L1-1.log"), "the only run of its owner, however old");
  assert.equal(kept.filter((name) => name.startsWith("L9-")).length, GATE_LOGS_PER_OWNER + 2, "a lane gone from the ledger is filed whole, not tidied");
  assert.ok(kept.includes("notes.txt"), "a file the desk did not name is not its to drop");
  assert.equal(readdirSync(handbacks).length, GATE_LOGS_PER_OWNER + 2, "hand-backs are never tidied");
});
