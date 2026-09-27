import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { appendRolling } from "../../server/core/rolling.ts";
import { type Lane } from "../../server/domain/lane.ts";
import { emptyLedger } from "../../server/domain/ledger.ts";
import { tidyRecords } from "../../server/desk/store/records.ts";
import { tempDir } from "../tempdir.ts";

test("a record log rolls over, keeps its newest roll as text for a grep, and packs the older ones and drops what outgrows its bytes", async () => {
  const dir = tempDir("sw3-roll-");
  const line = `${"x".repeat(20)}\n`;
  const roll = {
    dir,
    current: "events.log",
    prefix: "events.",
    ext: ".log",
    rotateAt: 2 * line.length,
    keepBytes: 2 * line.length + 2 * gzipSync(line.repeat(2)).length,
    plain: 1,
  };
  for (let index = 0; index < 12; index++) await appendRolling(roll, line);
  const names = readdirSync(dir).sort();
  assert.deepEqual(
    names.filter((name) => !name.endsWith(".gz")),
    ["events.00000005.log", "events.log"],
    names.join(", "),
  );
  assert.deepEqual(
    names.filter((name) => name.endsWith(".gz")),
    ["events.00000003.log.gz", "events.00000004.log.gz"],
  );
  assert.equal(gunzipSync(readFileSync(join(dir, "events.00000003.log.gz"))).toString("utf-8"), line.repeat(2));
  assert.equal(
    readFileSync(join(dir, "events.log"), "utf-8"),
    line.repeat(2),
    "the name agents read stays the live file",
  );
});

test("two rolls close together pack each file once, so neither packing trips over the other's half-written copy", async () => {
  const dir = tempDir("sw3-roll-race-");
  const roll = {
    dir,
    current: "events.log",
    prefix: "events.",
    ext: ".log",
    rotateAt: 1,
    keepBytes: 1 << 20,
    plain: 0,
  };
  await appendRolling(roll, "a\n");
  await Promise.all(["b\n", "c\n", "d\n"].map((line) => appendRolling(roll, line)));
  const names = readdirSync(dir).sort();
  assert.deepEqual(
    names.filter((name) => !name.endsWith(".gz")),
    ["events.log"],
    names.join(", "),
  );
  const packed = names
    .filter((name) => name.endsWith(".gz"))
    .map((name) => gunzipSync(readFileSync(join(dir, name))).toString("utf-8"));
  assert.deepEqual(packed, ["a\n", "b\n", "c\n"]);
});

const lane = (id: string): Lane => ({
  id,
  title: id,
  outcome: "",
  acceptance: [],
  outOfScope: [],
  base: "main",
  branch: `lane/${id}`,
  writeSet: [],
  contracts: [],
  opener: "s",
  status: "closed",
  openedAt: 0,
  tasks: 0,
});

const GATE_RUNS_KEPT = 5;

test("a lane in the ledger keeps its records but the gate runs a newer run of the same owner replaced, rehearsals with their run", () => {
  const state = tempDir("sw3-tidy-");
  const gates = join(state, "gates");
  const handbacks = join(state, "handbacks");
  mkdirSync(gates);
  mkdirSync(handbacks);
  const touch = (dir: string, name: string) => writeFileSync(join(dir, name), "x");
  const runs = Array.from({ length: GATE_RUNS_KEPT + 2 }, (_, run) => 1000 - run);
  for (const at of runs) for (const tail of ["", "-1", "-2"]) touch(gates, `L1-T1-${at}${tail}.log`);
  touch(gates, "L1-1.log");
  for (const at of runs) touch(gates, `L9-T1-${at}.log`);
  for (const at of runs) touch(handbacks, `L1-T1-${at}.md`);
  touch(gates, "notes.txt");
  const ledger = emptyLedger();
  ledger.lanes = { L1: lane("L1") };

  tidyRecords(state, ledger);

  const kept = readdirSync(gates);
  assert.deepEqual(
    kept.filter((name) => name.startsWith("L1-T1-")).sort(),
    runs
      .slice(0, GATE_RUNS_KEPT)
      .flatMap((at) => ["", "-1", "-2"].map((tail) => `L1-T1-${at}${tail}.log`))
      .sort(),
    "the newest runs of each task, every rehearsal with its run, and the older runs gone whole",
  );
  assert.ok(kept.includes("L1-1.log"), "the only run of its owner, however old");
  assert.equal(
    kept.filter((name) => name.startsWith("L9-")).length,
    GATE_RUNS_KEPT + 2,
    "a lane gone from the ledger is filed whole, not tidied",
  );
  assert.ok(kept.includes("notes.txt"), "a file the desk did not name is not its to drop");
  assert.equal(readdirSync(handbacks).length, GATE_RUNS_KEPT + 2, "hand-backs are never tidied");
});
