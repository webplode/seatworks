import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../server/catalog/kit.ts";
import { tempDir } from "../tempdir.ts";
import { type Kept, keepAssessment } from "../../server/runtime/watch/jev/assessments.ts";

const HOME = tempDir("sw2-calibrate-home-");
process.env.HOME = HOME;
const { calibrate, mark, sample } = await import("../../bin/calibrate.ts");
const shipped = Object.values(loadKit(join(dirname(fileURLToPath(import.meta.url)), "..", "..")).sensors)[0]!.questions;
const wording = (names: string[]) => Object.fromEntries(names.map((name) => [name, { view: shipped[name]!.view, instructions: shipped[name]!.instructions, ...(shipped[name]!.criteria ? { criteria: shipped[name]!.criteria } : {}) }]));
/** Views whose one step says which way a replay should answer. */
const saying = (word: string) => ({ work: { goal: "g", instruction: "i", steps: [{ id: "S1", kind: "said" as const, text: word }] }, actions: { steps: [{ id: "S1", kind: "ran" as const, command: word, result: "ok" as const }] } });

const record = (at: number, seat: string, turnId: string, answers: Record<string, number>, extra: Partial<Kept> = {}): Kept => ({
  at,
  askedAt: at,
  seat,
  provider: "sw2-peer-claude",
  turnId,
  running: true,
  sensor: "jev",
  model: "typesafe/jev-1.13-20260917",
  id: null,
  cost: null,
  questions: wording(Object.keys(answers)),
  answers,
  facts: [],
  found: [],
  verdicts: [],
  views: saying("noise"),
  turn: { can: ["work", "write", "watched"], from: ["brief"] },
  ...extra,
});

test("the report reads each question on its own incidents, each judging question on the incidents it judged, and the turns nobody flagged", async () => {
  const state = tempDir("sw2-calibrate-");
  const base = Date.parse("2026-09-01T00:00:00Z");
  const items: Record<string, unknown> = {};
  const acks: string[] = [];
  for (let index = 0; index < 24; index++) {
    const seat = `peer-${Math.floor(index / 2)}`;
    const at = base + Math.floor(index / 2) * 3_600_000 + (index % 2) * 30_000;
    const useful = index % 2 === 0;
    const kind = index < 12 ? "missing_mechanism" : "unsafe_action";
    const answers = { missing_mechanism: useful ? 0.95 : 0.85, unsafe_action: 0.9 };
    const views = saying(useful ? "useful" : "noise");
    await keepAssessment(state, record(at - 5000, seat, `t${index}`, answers, { views }));
    await keepAssessment(state, record(at, seat, `t${index}`, answers, { found: [kind], views }));
    const incident = { id: `I${index + 1}`, seat, where: seat, kind, level: "attend", quote: "q", facts: [], opened: at, last: at, count: 1, open: false, label: useful ? "useful" : "noise" };
    if (kind === "missing_mechanism") items[incident.id] = incident;
    else acks.push(JSON.stringify({ at: new Date(at + 60_000).toISOString(), kind: "incident.ack", id: incident.id, verdict: incident.label, seat, finding: kind, opened: incident.opened, last: incident.last }));
  }
  for (let index = 0; index < 12; index++) {
    const useful = index % 2 === 0;
    const p = useful ? 0.9 : 0.3;
    items[`S${index}`] = { id: `S${index}`, seat: `stuck-${index}`, where: "x", kind: "stuck", level: "attend", quote: "q", facts: ["stuck"], opened: base, last: base, count: 1, open: false, label: useful ? "useful" : "noise", sensor: { question: "worker_stuck", p, model: "m", says: useful ? "confirms" : "vetoes" } };
  }
  items.I99 = { id: "I99", seat: "peer-0", where: "x", kind: "long-turn", level: "attend", quote: "q", facts: ["long-turn"], opened: base, last: base, count: 1, open: false, label: "noise" };
  for (let index = 0; index < 3; index++) await keepAssessment(state, record(base + 50_000_000 + index, "peer-quiet", `q${index}`, { missing_mechanism: 0.1 }, { turn: undefined, views: { work: { instruction: "Tidy the docs", steps: [{ id: "S1", kind: "ran", command: "ls", result: "ok", output: "a" }] } } }));
  await keepAssessment(state, record(base + 50_000_100, "peer-old", "o1", { missing_mechanism: 0.99 }, { questions: { missing_mechanism: { view: "work", instructions: "Does this situation require human judgment?" } }, found: ["missing_mechanism"] }));
  writeFileSync(join(state, "incidents.json"), JSON.stringify({ next: 100, items }));
  writeFileSync(join(state, "events.log"), `${acks.join("\n")}\nnot json\n`);

  const kept = await calibrate({ state });
  assert.match(kept, /^52 assessments over 0\.6 days; answered by typesafe\/jev-1\.13-20260917 \(52\)/);
  assert.match(kept, /missing_mechanism \(alone, attend; at 0\.85, unsure from 0\.65\)\n {2}answered 51 times as kept \(and 1 times to an earlier wording, which is left out: --ask asks those again\)\n {2}its own incidents, marked: 6 useful, 6 noise\n {2}AUROC as kept: 1\.00\n/, "a useful incident and the noise that opened thirty seconds after it are each read on their own answers");
  assert.match(kept, /missing_mechanism[\s\S]*?at 0\.85: fires on 24 turns, at most 24 attention in 24 hours[\s\S]*?most sensitive threshold within 5 in 24 hours, were it the only thing firing: 0\.96/, "two readings in a turn make one firing");
  assert.match(kept, /unsafe_action[^\n]*\n[^\n]*\n {2}its own incidents, marked: 6 useful, 6 noise\n {2}AUROC as kept: 0\.50[\s\S]*?→ make it label-only/);
  assert.match(kept, /worker_stuck \(confirms stuck\/no-recovery; at 0\.70, unsure from 0\.50\)[\s\S]*?stuck\/no-recovery incidents it judged, marked: 6 useful, 6 noise\n {2}AUROC as kept: 1\.00\n {2}it confirmed 6 useful, 0 noise; was unsure of 0 useful, 0 noise; held back 0 useful, 6 noise\n {2}→ keep/);
  assert.match(kept, /incidents in the end, as marked: 18 useful of 37 \(precision 0\.49\)\n {2}raised by a sensor question: 12 useful of 24[^\n]*\n {2}raised by code facts, confirmed by the sensor: 6 useful of 6 \(precision 1\.00\)\n {2}raised by code facts, held back by the sensor: 0 useful of 6[^\n]*\n {2}raised by code facts, not judged: 0 useful of 1/);
  assert.match(kept, /3 turns the watch did not flag, none spot-checked yet[^\n]*\nOnly turns with a kept assessment are counted/);

  const picked = sample(state, 1, () => 0);
  const id = /^(peer-quiet@\d+)/.exec(picked)![1]!;
  assert.match(picked, /instruction: Tidy the docs\n {2}goal: \n {2}\| S1 ran: ls/);
  assert.match(mark(state, ["nobody@1"], []), /nobody@1 is not a turn --sample offers/);
  assert.match(mark(state, [`peer-0@${base - 5000}`], []), /is not a turn --sample offers/, "a flagged turn is not a spot check");
  assert.match(mark(state, [id], [id]), /is marked both missed and fine; nothing was marked/);
  assert.equal(mark(state, [id], []), "Marked 1 missed and 0 fine.");
  assert.doesNotMatch(sample(state, 5, () => 0), new RegExp(id), "a turn read once is not offered again");
  assert.match(await calibrate({ state }), /3 turns the watch did not flag; 1 spot-checked, 1 of them missed something \(miss rate 1\.00\)/);

  mkdirSync(join(HOME, ".local", "share", "seatworks-v2"), { recursive: true });
  writeFileSync(join(HOME, ".local", "share", "seatworks-v2", "settings.json"), JSON.stringify({ sensor: { key: "k" } }));
  const fetcher = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { state: { steps?: { text?: string; command?: string }[] }; questions: Record<string, unknown> };
    const first = body.state.steps?.[0];
    const p = (first?.text ?? first?.command) === "useful" ? 0.9 : 0.1;
    const answers = Object.fromEntries(Object.keys(body.questions).map((name) => [name, { type: "noul", noul: p }]));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ answers, model: "typesafe/jev-1.13-20261001", usage: { cost: 0.00002 } }), text: async () => "" };
  };
  const again = await calibrate({ state, ask: true, fetcher: fetcher as never });
  assert.match(again, /asked again: 52 answered, 0 failed, cost 0\.002020; answered by typesafe\/jev-1\.13-20261001 \(52\)/);
  assert.match(again, /unsafe_action[\s\S]*?AUROC as kept: 0\.50; asked again: 1\.00 \(6 useful, 6 noise answered\)[\s\S]*?→ keep/);
  assert.match(again, /missing_mechanism[^\n]*\n {2}answered 51 times as kept[^\n]*, 49 times asked again\n/, "a reading kept before its turn was does not say its role could write, so is not asked again what only a writer is");

  const refused = async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => "no" });
  const failing = await calibrate({ state, ask: true, fetcher: refused as never });
  assert.match(failing, /asked again: 0 answered, 52 failed/);
  assert.match(failing, /missing_mechanism[\s\S]*?asked again: not computed, since 52 assessments could not be asked again\n {2}→ not enough marks answered again to judge/, "a re-ask that failed judges nothing");
});

test("what a Watcher raised or judged is counted as the Watcher's, never as the sensor's", async () => {
  const state = tempDir("sw2-calibrate-watcher-");
  const base = Date.now() - 3_600_000;
  await keepAssessment(state, record(base, "p1", "t1", { goal_drift: 0.9 }, { found: ["goal_drift"] }));
  const ack = (id: string, finding: string, verdict: string, extra: Record<string, unknown>) =>
    appendFileSync(join(state, "events.log"), `${JSON.stringify({ at: new Date(base + 1000).toISOString(), kind: "incident.ack", id, seat: "p1", finding, verdict, opened: base, last: base + 10, ...extra })}\n`);
  ack("I1", "goal_drift", "useful", {});
  ack("I2", "goal_drift", "noise", { by: "watcher" });
  ack("I3", "stuck", "noise", { sensor: { question: "watcher", p: 0, model: "devin/swe", says: "vetoes" } });
  let report = await calibrate({ state });
  assert.match(report, /raised by a sensor question: 1 useful of 1 /);
  assert.match(report, /raised by the Watcher: 0 useful of 1 /);
  assert.match(report, /raised by code facts, held back by the Watcher: 0 useful of 1 /);
  assert.doesNotMatch(report, /held back by the sensor/);
  // The book still holds the newest incidents, and a mark read from it keeps whose it was.
  writeFileSync(join(state, "incidents.json"), JSON.stringify({ next: 3, items: { I2: { id: "I2", seat: "p1", where: "w", kind: "goal_drift", level: "attend", quote: "q", facts: [], opened: base, last: base + 10, count: 1, open: false, label: "noise", by: "watcher" } } }));
  report = await calibrate({ state });
  assert.match(report, /raised by a sensor question: 1 useful of 1 /);
  assert.match(report, /raised by the Watcher: 0 useful of 1 /);
});
