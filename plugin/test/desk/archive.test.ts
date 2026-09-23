import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { tempDir } from "../tempdir.ts";
import { KEEP_CLOSED_LANES, type LaneArchive, RECORD_TAIL_BYTES, archiveDir, fileRecords, keepArchived, takeFinished } from "../../server/desk/archive.ts";
import { type Lane, type Task, emptyLedger } from "../../server/desk/ledger.ts";

const lane = (n: number, status: Lane["status"] = "closed"): Lane =>
  ({ id: `L${n}`, title: `lane ${n}`, outcome: "", acceptance: [], outOfScope: [], base: "main", branch: `lane/l${n}`, writeSet: [], contracts: [], opener: "sup", status, openedAt: n, tasks: 1, lead: `lead-${n}` }) as Lane;
const task = (n: number, status: Task["status"] = "merged"): Task => ({ id: `L${n}-T1`, lane: `L${n}`, peer: `peer-${n}`, status, title: "t", goal: "g", acceptance: [] }) as unknown as Task;

function busyLedger(count: number) {
  const ledger = emptyLedger();
  ledger.seq.lane = count;
  for (let n = 1; n <= count; n++) {
    ledger.lanes[`L${n}`] = lane(n);
    ledger.tasks[`L${n}-T1`] = task(n);
    ledger.agents[`lead-${n}`] = { id: `lead-${n}`, role: "lead", lane: `L${n}` };
    ledger.asks[`A${n}`] = { id: `A${n}`, from: `peer-${n}`, fromRole: "peer", to: `lead-${n}`, lane: `L${n}`, kind: "question", text: "?", status: "answered", openedAt: n, reminders: 0 };
  }
  return ledger;
}

const read = (state: string, id: string) => JSON.parse(gunzipSync(readFileSync(join(archiveDir(state), `${id}.json.gz`))).toString("utf-8")) as LaneArchive;

test("closed lanes past the newest few leave the ledger whole once nothing of theirs is pending and no open work names them", () => {
  const extra = 11;
  const ledger = busyLedger(KEEP_CLOSED_LANES + extra);
  ledger.lanes.L1!.restoring = { writers: [], base: "main", branch: "lane/l1" };
  ledger.slots.S1 = { id: "S1", path: "/tmp/s1", lane: "L2", createdAt: 0 };
  ledger.tasks["L3-T1"]!.status = "queued";
  ledger.asks.A4!.status = "open";
  const live = new Set(["peer-5"]);
  ledger.lanes.L99 = { ...lane(99, "open"), outcome: "Carry on from handbacks/L6-T1-1.md", base: "lane/l9-parser" };
  ledger.tasks["L99-T1"] = { ...task(99, "running"), context: "the fix in L7 was half done, see lane/l8-cache" };
  ledger.lanes.L98 = { ...lane(98, "open"), acceptance: ["l10 is gone"] };

  const taken = takeFinished(ledger, (id) => !live.has(id))!;

  assert.deepEqual(taken.lanes.map((entry) => entry.lane!.id), ["L11"], "only the unpinned lane beyond the newest kept");
  assert.deepEqual(taken.lanes[0]!.tasks.map((entry) => entry.id), ["L11-T1"]);
  assert.deepEqual(taken.lanes[0]!.asks.map((entry) => entry.id), ["A11"]);
  assert.deepEqual(taken.lanes[0]!.agents.map((entry) => entry.id), ["lead-11"]);
  for (const kept of ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L12"]) assert.ok(ledger.lanes[kept], `${kept} stays`);
  assert.ok(!ledger.lanes.L11 && !ledger.tasks["L11-T1"] && !ledger.asks.A11 && !ledger.agents["lead-11"]);
  assert.equal(ledger.seq.lane, KEEP_CLOSED_LANES + extra, "ids come from seq, which never moves");
  assert.equal(takeFinished(ledger, (id) => !live.has(id)), undefined, "a second look finds nothing more");
});

test("a closed lane a waiting lane waits for stays on record, however old", () => {
  const ledger = busyLedger(KEEP_CLOSED_LANES + 1);
  ledger.lanes.L99 = { ...lane(99, "waiting"), after: ["L1"] };
  assert.equal(takeFinished(ledger, () => true), undefined);
  assert.ok(ledger.lanes.L1);
});

test("an open lane is never archived; a seat with no lane keeps its role's newest entry and any open ask; an answered ask goes with its asker", () => {
  const ledger = busyLedger(KEEP_CLOSED_LANES + 1);
  ledger.lanes.L1!.status = "open";
  ledger.agents["sup-1"] = { id: "sup-1", role: "supervisor" };
  ledger.agents["sup-2"] = { id: "sup-2", role: "supervisor" };
  ledger.agents["sup-3"] = { id: "sup-3", role: "supervisor" };
  ledger.agents["watch-1"] = { id: "watch-1", role: "watcher" };
  ledger.asks.B1 = { id: "B1", from: "sup-2", fromRole: "supervisor", to: "human", kind: "question", text: "?", status: "open", openedAt: 0, reminders: 0 };
  ledger.asks.B2 = { id: "B2", from: "sup-1", fromRole: "supervisor", to: "human", kind: "question", text: "?", status: "answered", openedAt: 0, reminders: 0 };
  ledger.asks.B3 = { id: "B3", from: "sup-3", fromRole: "supervisor", to: "human", kind: "question", text: "?", status: "answered", openedAt: 0, reminders: 0 };

  const taken = takeFinished(ledger, () => true)!;

  assert.deepEqual(taken.lanes, [], "L1 is open; the rest are the newest kept");
  assert.deepEqual(taken.agents.map((agent) => agent.id), ["sup-1"]);
  assert.deepEqual(taken.asks.map((ask) => ask.id), ["B2"], "an answer its asker, still on record, may read again stays");
  assert.ok(ledger.agents["sup-2"] && ledger.agents["sup-3"] && ledger.agents["watch-1"] && ledger.asks.B1 && ledger.asks.B3);
});

test("a lane leaves as one file with its entries, every hand-back and each owner's last gate run, and filing it again changes nothing", () => {
  const state = tempDir("sw2-archive-");
  const ledger = busyLedger(KEEP_CLOSED_LANES + 1);
  ledger.seq.lane = 30;
  mkdirSync(join(state, "gates"));
  mkdirSync(join(state, "handbacks"));
  const put = (path: string) => writeFileSync(join(state, path), `text of ${path}`);
  for (const path of ["gates/L1-T1-10.log", "gates/L1-T1-20.log", "gates/L1-5.log", "handbacks/L1-T1-10.md", "handbacks/L1-T1-20.md", "gates/L2-T1-10.log", "gates/L31-1.log"]) put(path);

  const taken = takeFinished(ledger, () => true)!;
  keepArchived(state, taken);
  keepArchived(state, taken);
  const moved = fileRecords(state, ledger);

  assert.deepEqual(moved.sort(), ["gates/L1-5.log", "gates/L1-T1-10.log", "gates/L1-T1-20.log", "handbacks/L1-T1-10.md", "handbacks/L1-T1-20.md"]);
  const archive = read(state, "L1");
  assert.equal(archive.lane!.id, "L1");
  assert.deepEqual(archive.tasks.map((entry) => entry.id), ["L1-T1"]);
  assert.deepEqual(Object.keys(archive.records).sort(), ["gates/L1-5.log", "gates/L1-T1-20.log", "handbacks/L1-T1-10.md", "handbacks/L1-T1-20.md"]);
  assert.equal(archive.records["handbacks/L1-T1-10.md"], "text of handbacks/L1-T1-10.md");
  assert.deepEqual(readdirSync(join(state, "gates")).sort(), ["L2-T1-10.log", "L31-1.log"], "a lane in the ledger, and an id this ledger never gave out, stay where they are");

  const before = readFileSync(join(archiveDir(state), "L1.json.gz"));
  keepArchived(state, taken);
  assert.deepEqual(fileRecords(state, ledger), []);
  assert.deepEqual(read(state, "L1"), JSON.parse(gunzipSync(before).toString("utf-8")), "a crash replayed rewrites the same file");
});

test("records left by a crash between the ledger and the files are filed on the next look, and the oldest lanes' files go past the budget", () => {
  const state = tempDir("sw2-archive-budget-");
  const ledger = emptyLedger();
  ledger.seq.lane = 5;
  mkdirSync(join(state, "handbacks"));
  for (let n = 1; n <= 5; n++) writeFileSync(join(state, "handbacks", `L${n}-T1-1.md`), "x".repeat(2000) + n);
  fileRecords(state, ledger);
  const size = (n: number) => statSync(join(archiveDir(state), `L${n}.json.gz`)).size;
  const budget = size(5) + size(4) + size(3);
  writeFileSync(join(state, "handbacks", "L5-T2-2.md"), "late");

  fileRecords(state, ledger, budget + 40);

  assert.deepEqual(readdirSync(archiveDir(state)).sort(), ["L3.json.gz", "L4.json.gz", "L5.json.gz"]);
  assert.deepEqual(Object.keys(read(state, "L5").records).sort(), ["handbacks/L5-T1-1.md", "handbacks/L5-T2-2.md"], "a late record joins its lane's file");
  assert.ok(!existsSync(join(state, "handbacks", "L5-T2-2.md")));
});

test("a gate log too big to hold is filed by its tail, where a failure is, and nothing larger is ever read in", () => {
  const state = tempDir("sw2-archive-big-");
  const ledger = emptyLedger();
  ledger.seq.lane = 1;
  mkdirSync(join(state, "gates"));
  const line = "PASS a case that ran fine\n";
  writeFileSync(join(state, "gates", "L1-T1-1.log"), `${line.repeat(Math.ceil((RECORD_TAIL_BYTES * 1.5) / line.length))}FAIL the one that broke\n`);

  fileRecords(state, ledger);

  const kept = read(state, "L1").records["gates/L1-T1-1.log"]!;
  assert.match(kept, /^\[the start of this log was cut/);
  assert.match(kept, /FAIL the one that broke\n$/);
  assert.ok(Buffer.byteLength(kept) <= RECORD_TAIL_BYTES + 100, `${Buffer.byteLength(kept)} bytes kept`);
});
