import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CommunicationWatch, communicationCase, readCommunicationAnswers } from "../../server/runtime/watch/jev/communication.ts";
import { emptyLedger, type Task } from "../../server/desk/ledger.ts";
import type { Letter } from "../../server/runtime/outbox.ts";
import { Supervision } from "../../server/runtime/supervision.ts";
import { projectOf } from "../../server/desk/project.ts";
import { writeJson, readJson } from "../../server/core/store.ts";
import { tempDir } from "../tempdir.ts";

const project = { slug: "api", root: "/api", state: "/state/api" };
const task: Task = { id: "L1-T1", lane: "L1", kind: "code", mode: "parallel", title: "Schema", goal: "Publish API", acceptance: ["client consumes it"], owned: ["api"], outOfScope: ["mobile"], peer: "p1", status: "done", openedAt: 1, updatedAt: 5, silent: 0, handback: { file: "/state/api/report", outcome: "blocked", summary: "Consumer needs a versioned schema", at: 5 } };
const letter: Letter = { id: "d1", key: "api:done:L1-T1:hash", to: "lead", text: "handback", at: 5, state: "delivered", deliveredAt: 6 };
function ledger() { const l = emptyLedger(); l.lanes.L1 = { id: "L1", lead: "lead" } as never; l.tasks[task.id] = structuredClone(task); return l; }
function response(choice = "adequate") {
  return { model: "typesafe/jev-1.13", answers: Object.fromEntries(["brief", "handback", "handling"].map((q) => [q, { type: "choice", choice, probabilities: { adequate: choice === "adequate" ? 0.97 : 0.01, deficient: choice === "deficient" ? 0.97 : 0.01, unknown: 0.01, not_applicable: 0.01 } }])) };
}

test("communication evidence accepts repair by a different Peer and revisions only that episode", () => {
  const l = ledger();
  l.tasks["L1-T2"] = { ...task, id: "L1-T2", peer: "p2", openedAt: 9, updatedAt: 10, status: "done", handback: { ...task.handback!, at: 10, outcome: "done", summary: "Published v2 schema" } };
  const turn = { started: 8, ended: 12, text: "Another Peer delivered the missing contract", complete: true };
  const before = communicationCase(project, task, l, [letter], turn);
  assert.equal(before.unknown, undefined);
  assert.match(JSON.stringify(before.state.repairs), /p2.*Published v2 schema/);
  l.tasks.UNRELATED = { ...task, lane: "L2", id: "unrelated", updatedAt: 30 };
  assert.equal(communicationCase(project, task, l, [letter], turn).revision, before.revision);
  l.tasks["L1-T2"]!.handback!.summary = "Repair failed";
  assert.notEqual(communicationCase(project, task, l, [letter], turn).revision, before.revision);
});

test("missing delivery, overlapping turns and oversized evidence stay unknown", () => {
  const l = ledger(); const turn = { started: 4, ended: 12, text: "Looks good", complete: true };
  assert.match(communicationCase(project, task, l, [letter], turn).unknown!, /strictly after/);
  assert.match(communicationCase(project, task, l, [], turn).unknown!, /unconfirmed/);
  assert.match(communicationCase(project, task, l, [letter], { ...turn, started: 8 }, 10).unknown!, /window/);
  assert.match(communicationCase(project, task, l, [letter]).unknown!, /complete Lead turn/);
});

test("Choice validation requires every obligation, exact model, finite normalized probabilities and a unique maximum", () => {
  assert.equal(readCommunicationAnswers(response(), "typesafe/jev-1.13").answers.brief!.choice, "adequate");
  for (const mutate of [
    (r: any) => { delete r.answers.handback; },
    (r: any) => { r.model = "another-model"; },
    (r: any) => { r.answers.handling.probabilities.deficient = NaN; },
    (r: any) => { r.answers.brief.probabilities.adequate = 0.2; },
    (r: any) => { r.answers.brief.choice = "deficient"; },
    (r: any) => { r.answers.brief.probabilities = { adequate: 0.49, deficient: 0.49, unknown: 0.01, not_applicable: 0.01 }; },
  ]) { const r = response(); mutate(r); assert.throws(() => readCommunicationAnswers(r, "typesafe/jev-1.13")); }
});

test("communication calls reserve a durable machine budget before paying, including across restart", async (t) => {
  const root = tempDir(); const store = new Supervision(root); const now = Date.now();
  const projects = ["first", "second"].map((id) => { const path = join(root, id); mkdirSync(path); return { id, ...projectOf(path, root), name: id, grants: ["observe" as const], leads: [] }; });
  store.change(0, (b) => { b.active = true; b.supervisor = { agent: "sup", workspace: "home" }; b.projects = projects; });
  const records: Letter[] = [];
  for (const p of projects) {
    const l = ledger(); l.lanes.L1!.lead = p.id;
    l.tasks[task.id]!.handback!.at = now - 2000;
    writeJson(join(p.state, "ledger.json"), l);
    records.push({ ...letter, id: p.id, to: p.id, key: `${p.slug}:done:L1-T1:hash`, at: now - 2000, deliveredAt: now - 1000 });
  }
  const budget = join(root, "jev-budget.json");
  writeJson(budget, { version: 2, day: new Date().toISOString().slice(0, 10), calls: 99, cases: {} });
  let paid = 0;
  t.mock.method(globalThis, "fetch", async () => { paid++; assert.equal(readJson<{ calls: number }>(budget, { calls: 0 }).calls, 100); return new Response(JSON.stringify(response())); });
  const make = () => new CommunicationWatch(store, { records: () => records } as never, { notice: () => { throw new Error("An adequate result must not open an incident."); } } as never,
    () => ({ attention: { communication: "shadow", by: "jev" }, sensor: { key: "fake-key", spec: { id: "jev", model: "typesafe/jev-1.13", url: "https://example.invalid", timeoutSeconds: 1, retries: 2, stateChars: 8000 } } }) as never);
  let clock = now + 10; t.mock.method(Date, "now", () => ++clock);
  const watch = make();
  for (const p of projects) { watch.started(p.id); watch.ended(p.id, "Requested a repair from another Peer", true); }
  await watch.tick();
  assert.equal(paid, 1); assert.equal(watch.coverage.get("second")?.status, "budget"); watch.dispose();
  const restarted = make();
  for (const p of projects) { restarted.started(p.id); restarted.ended(p.id, "New evidence", true); }
  await restarted.tick(); assert.equal(paid, 1); restarted.dispose();
});
