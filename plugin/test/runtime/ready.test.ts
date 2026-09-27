import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../tempdir.ts";
import { harness, laneWithPeer } from "./harness.ts";

/** Whether `check` comes true within `ms`, looked at every 20 ms. */
async function within(ms: number, check: () => boolean): Promise<boolean> {
  for (const end = Date.now() + ms; !check(); await new Promise((resolve) => setTimeout(resolve, 20)))
    if (Date.now() > end) return false;
  return true;
}

test("a READY is what the lane's copy holds with nobody writing there, and whatever changes the lane takes it away", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  const copy = lane.worktree!;
  const report = (ready = true) => h.call(lead, "lead", "report", { summary: "done", ready });
  const ready = () => h.ledger().lanes.L1!.ready;
  /** A task beside the lane's copy holding `file`, handed back with it committed. */
  const beside = async (key: string, file: string) => {
    const tasks = [
      { key, title: key, goal: "g", acceptance: ["c"], holds: [file], outOfScope: ["the rest"], parallel: true },
    ];
    await h.call(lead, "lead", "add_tasks", { tasks });
    const task = Object.values(h.ledger().tasks).find((entry) => entry.title === key)!;
    h.commit(task.worktree!, file, `${file}\n`);
    await h.call(task.peer!, "peer", "done", { outcome: "complete", summary: file });
    h.agents.get(task.peer!)!.status = "idle";
    return task;
  };

  const writing = new RegExp(
    `^${peer} is mid-turn in the lane's working copy, so what ready claims could still change under the gate\\. Report ready once that turn ends\\.$`,
  );
  const refused = await report();
  assert.equal(refused.ok, false);
  assert.match(refused.text, writing);
  assert.equal(ready(), undefined);
  assert.equal((await report(false)).ok, true);
  await h.idle(peer);
  const seats = (h.paseo as { agents: { ref: (id: string) => { refresh: () => Promise<unknown> } } }).agents;
  const ref = seats.ref;
  seats.ref = (id) => {
    const handle = ref(id);
    if (id !== peer) return handle;
    seats.ref = ref;
    return Object.assign(Object.create(handle) as typeof handle, {
      refresh: () => Promise.reject(new Error("the daemon did not answer")),
    });
  };
  assert.match((await report()).text, new RegExp(`^${peer} is mid-turn in the lane's working copy`));
  const branch = h.ledger().tasks["L1-T1"]!.branch!;
  assert.match(
    (await report()).text,
    new RegExp(
      `^The lane's working copy is on ${branch}, L1-T1's branch, not ${lane.branch}: the gate would read L1-T1's tree\\. Report ready once it is merged or cut\\.$`,
    ),
  );
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "nothing to change" });
  await h.idle(peer);
  await h.call(lead, "lead", "accept", { task: "L1-T1" });
  assert.equal((await report()).ok, true);
  assert.ok(ready());

  const side = await beside("Side", "c.txt");
  assert.equal(ready(), undefined);
  assert.equal((await report()).ok, true);
  await h.call(lead, "lead", "accept", { task: side.id });
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks[side.id]!.status, "merged");
  assert.equal(ready(), undefined);

  await h.call(sup, "supervisor", "set_project", { gate: "test -f c.txt", gateOn: "lane" });
  const late = await beside("Late", "d.txt");
  writeFileSync(join(copy, "a.txt"), "being written\n");
  await h.call(lead, "lead", "accept", { task: late.id });
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks[late.id]!.status, "queued");
  h.git(copy, "checkout", "--", "a.txt");
  assert.equal((await report()).ok, true);
  assert.equal(h.ledger().tasks[late.id]!.status, "merged");
  assert.match(h.heard(sup).join("\n"), /test -f c\.txt passed on the lane branch/);

  // Amended while its gate runs, the lane is not ready: what READY would claim changed under it.
  const dir = tempDir("sw3-amend-");
  const [started, go] = [join(dir, "started"), join(dir, "go")];
  await h.call(sup, "supervisor", "set_project", { gate: `touch ${started}; until [ -f ${go} ]; do sleep 0.05; done` });
  const reporting = report();
  assert.ok(await within(5000, () => existsSync(started)), "the gate runs");
  const amended = await h.call(sup, "supervisor", "amend_lane", {
    lane: "L1",
    why: "the Human wants one more case",
    acceptance: ["c", "d"],
  });
  assert.equal(amended.ok, true, amended.text);
  writeFileSync(go, "");
  const answer = await reporting;
  assert.equal(answer.ok, false, answer.text);
  assert.match(answer.text, /amended while its gate ran/);
  assert.equal(ready(), undefined);
});

test("a review started on a lane reported ready takes the READY back and calls off its ordered landing, and whoever supervises hears both", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { acceptance: ["a"], outOfScope: ["anything else"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Numbers", outcome: "a.txt gains words", ...scope });
  const lane = h.ledger().lanes.L1!;
  h.commit(h.root, "a.txt", "one\ntwo\nthree\nfour\n");
  h.commitTo("main", "other.txt", "main moved\n");
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  assert.match((await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).text, /^Lane L1 lands once /);
  await h.idle(sup);

  const started = await h.call(lane.lead!, "lead", "start_review", { focus: "Does the whole lane hold?" });
  assert.equal(started.ok, true, started.text);
  assert.deepEqual([h.ledger().lanes.L1!.ready, h.ledger().lanes.L1!.landing], [undefined, undefined]);
  assert.match(
    h.agents.get(sup)!.sent.join("\n"),
    /NOT LANDED L1 \(Numbers\): L1-R1 started reading it since your land_lane, so the desk will not land it\./,
  );
  assert.match(
    h.agents.get(sup)!.sent.join("\n"),
    /READY WITHDRAWN L1 \(Numbers\): its Lead started L1-R1 after reporting it ready/,
    "riding with the word that asks",
  );

  h.agents.get(lane.lead!)!.status = "idle";
  await h.endTurn(lane.lead!, "reviewing");
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().lanes.L1!.status, "open", "nothing lands on a READY taken back");
});
