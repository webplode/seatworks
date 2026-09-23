import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { tempDir } from "../tempdir.ts";
import { type Kept, assessmentsDir, keepAssessment, readAssessments, readTally } from "../../server/runtime/watch/jev/assessments.ts";

const record = (at: number): Kept => ({
  at,
  askedAt: at,
  seat: "peer-1",
  provider: "sw2-peer-claude",
  turnId: "t1",
  running: true,
  sensor: "jev",
  model: "typesafe/jev-1.13-20260917",
  id: `gen-${at}`,
  cost: 0.00002,
  questions: { unsafe_action: { view: "actions", instructions: "Does it?" } },
  answers: { unsafe_action: 0.1 },
  facts: [],
  found: [],
  verdicts: [],
  views: { work: { steps: [{ id: "S1", kind: "said", text: "x".repeat(400) }] } },
});

test("kept assessments roll over into packed files, the oldest go first, and every one left reads back once and in order", async () => {
  const state = tempDir("sw2-kept-");
  const two = 2 * Buffer.byteLength(`${JSON.stringify(record(1000))}\n`);
  const packed = (at: number) => gzipSync(`${JSON.stringify(record(at))}\n${JSON.stringify(record(at + 1))}\n`).length;
  for (let index = 0; index < 12; index++) await keepAssessment(state, record(1000 + index), two, packed(1004) + packed(1006) + packed(1008));
  const dir = assessmentsDir(state);
  const files = readdirSync(dir).sort();
  assert.equal(files.filter((name) => name.endsWith(".jsonl.gz")).length, 3, files.join(", "));
  assert.deepEqual(files.filter((name) => !name.endsWith(".jsonl.gz")), ["current.jsonl"]);
  assert.equal(gunzipSync(readFileSync(join(dir, files[0]!))).toString("utf-8").split("\n").filter(Boolean).length, 2);
  const read = readAssessments(state);
  assert.deepEqual(read.kept.map((kept) => kept.at), [1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011]);
  assert.equal(read.broken, 0);

  const oldest = files.find((name) => name.endsWith(".gz"))!;
  writeFileSync(join(dir, oldest.replace(/\.gz$/, "")), gunzipSync(readFileSync(join(dir, oldest))));
  copyFileSync(join(dir, oldest), join(dir, `${oldest}.part`));
  appendFileSync(join(dir, "current.jsonl"), '{"at": 2000, "seat"');
  const again = readAssessments(state);
  assert.deepEqual(again.kept.map((kept) => kept.at), [1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011], "a file packed but not yet removed, or half packed, is read once");
  assert.equal(again.broken, 1, "a line cut short by a crash is counted, not read");
});

test("what was written last is kept even when the clock steps back, and a pack left half done goes with its file", async () => {
  const state = tempDir("sw2-kept-back-");
  const two = 2 * Buffer.byteLength(`${JSON.stringify(record(1000))}\n`);
  const budget = 2 * gzipSync(`${JSON.stringify(record(5000))}\n${JSON.stringify(record(4900))}\n`).length + 8;
  for (let index = 0; index < 6; index++) await keepAssessment(state, record(5000 - index * 100), two, budget);
  const dir = assessmentsDir(state);
  const oldest = readdirSync(dir).filter((name) => name.endsWith(".jsonl.gz")).sort()[0]!;
  writeFileSync(join(dir, `${oldest.replace(/\.gz$/, "")}.gz.part`), "half");
  for (let index = 6; index < 10; index++) await keepAssessment(state, record(5000 - index * 100), two, budget);
  assert.deepEqual(readAssessments(state).kept.map((kept) => kept.at), [4100, 4200, 4300, 4400, 4500, 4600], "the six written last, though each carries an earlier time than the one before")
  assert.ok(!readdirSync(dir).some((name) => name.endsWith(".part")), "the half-packed file went when its file did");
});

test("the tally of every reading kept counts what was added since, and keeps counting across a rotation", async () => {
  // The card is polled every few seconds over a file of megabytes, so it is read once and then from where it left off.
  const state = tempDir("sw2-tally-");
  assert.deepEqual(readTally(state), { turns: 0, cost: 0 }, "a project the watch never read in");
  const one = (cost: number | null) => ({ at: Date.now(), seat: "s", cost }) as unknown as Kept;
  await keepAssessment(state, one(0.001));
  await keepAssessment(state, one(0.002));
  assert.deepEqual(readTally(state), { turns: 2, cost: 0.003 });
  await keepAssessment(state, one(null));
  assert.deepEqual(readTally(state), { turns: 3, cost: 0.003 }, "a reading whose price was not reported still counts as read");

  // A tiny rotation threshold forces the current file away into a dated, packed one.
  await keepAssessment(state, one(0.004), 10);
  assert.ok(readdirSync(assessmentsDir(state)).some((name) => name.endsWith(".jsonl.gz")), "the old readings were rotated and packed");
  const after = readTally(state);
  assert.equal(after.turns, 4, "nothing counted twice and nothing lost when the file it was reading moved");
  assert.equal(Math.round(after.cost * 1000), 7);
});
