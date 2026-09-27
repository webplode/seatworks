import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness, ideCalls, laneWithPeer } from "./harness.ts";

type Harness = ReturnType<typeof harness>;

const scope = { acceptance: ["done"], outOfScope: ["anything else in the repository"] };

/** Opens a lane in a copy of its own writing `dir`, with one commit on its branch and its Lead idle. */
async function isolated(h: Harness, sup: string, title: string, dir: string) {
  const opened = await h.call(sup, "supervisor", "open_lane", {
    title,
    outcome: dir,
    ...scope,
    writeSet: [`${dir}/**`],
    isolate: true,
  });
  assert.equal(opened.ok, true, opened.text);
  const lane = Object.values(h.ledger().lanes).find((entry) => entry.title === title)!;
  h.agents.get(lane.lead!)!.status = "idle";
  mkdirSync(join(lane.worktree!, dir), { recursive: true });
  h.commit(lane.worktree!, `${dir}/${dir}.txt`, `${dir}\n`);
  return lane;
}

const copyCalls = (path: string) => ideCalls.filter((call) => call.path === path).map((call) => call.kind);

test("a copy waits for every seat writing in it: the last to stop puts it away, or leaves it where it holds work nobody committed, and a round puts away one whose writers are gone for good", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const release = (lane: string) => h.call(sup, "supervisor", "release", { lane });
  await h.tick();
  await h.call(sup, "supervisor", "open_lane", { title: "Both in here", outcome: "x", ...scope, isolate: true });
  const lane = h.ledger().lanes.L1!;
  const lead = lane.lead!;
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title: "In the lane's copy", goal: "g", ...scope, hints: ["a.txt"] }],
  });
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  assert.equal(h.agents.get(peer)!.cwd, lane.worktree);
  writeFileSync(join(lane.worktree!, "half-written.txt"), "the Peer is mid-sentence\n");
  assert.equal(
    (await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "the outcome was wrong" })).ok,
    true,
  );
  assert.match(
    (await release("L1")).text,
    new RegExp(`its working copy ${lane.slot} is put away once ${lead} and ${peer} finish the turn they are in\\.`),
  );
  h.agents.get(peer)!.status = "idle";
  await h.endTurn(peer, "stopping");
  assert.equal(existsSync(join(lane.worktree!, "half-written.txt")), true);
  assert.ok(h.ledger().slots[lane.slot!]);
  h.agents.get(lead)!.status = "idle";
  await h.endTurn(lead, "stopping too");
  const unsaved = join(lane.worktree!, "half-written.txt");
  assert.equal(readFileSync(unsaved, "utf-8"), "the Peer is mid-sentence\n", "the desk never deletes work");
  assert.deepEqual(Object.keys(h.ledger().slots), []);
  assert.notEqual(h.git(h.root, "branch", "--list", lane.branch).trim(), "");

  await h.call(sup, "supervisor", "open_lane", { title: "Abandoned", outcome: "x", ...scope, isolate: true });
  const abandoned = h.ledger().lanes.L2!;
  await h.call(sup, "supervisor", "drop_lane", { lane: "L2", reason: "the outcome was wrong" });
  await release("L2");
  assert.equal(existsSync(abandoned.worktree!), true);
  assert.deepEqual(h.ledger().slots[abandoned.slot!]!.releasing!.writers, [abandoned.lead!]);
  h.agents.get(abandoned.lead!)!.archivedAt = new Date().toISOString();
  await h.tick(Date.now());
  assert.equal(existsSync(abandoned.worktree!), false);
  assert.deepEqual(Object.keys(h.ledger().slots), []);
  assert.equal(existsSync(unsaved), true, "nor does a round's sweep");
});

test("a kept Lead keeps its lane's copy until the Supervisor releases it or the round finds it gone, and one failed look is not gone", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const release = (lane: string) => h.call(sup, "supervisor", "release", { lane });
  await h.call(sup, "supervisor", "set_project", { gate: "true" });
  const part = await isolated(h, sup, "Part B", "b");
  const lead = part.lead!;
  assert.equal(part.slot, "S0");
  assert.deepEqual(copyCalls(part.worktree!), ["open"]);

  const seats = (h.paseo as { agents: { ref: (id: string) => { refresh: () => Promise<unknown> } } }).agents;
  const ref = seats.ref;
  let failed = false;
  seats.ref = (id) => {
    const handle = ref(id);
    if (id !== lead || failed || h.ledger().lanes.L1!.status !== "closed") return handle;
    failed = true;
    return Object.assign(Object.create(handle) as typeof handle, {
      refresh: () => Promise.reject(new Error("the daemon is busy")),
    });
  };
  const landed = await h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  assert.equal(landed.ok, true, landed.text);
  assert.equal(failed, true);
  assert.equal(h.agents.get(lead)!.archivedAt, null);
  assert.ok(existsSync(part.worktree!));
  assert.match(
    landed.text,
    new RegExp(
      `Lane L1 closed; squashed ${part.branch} into one commit on main, its own commits kept at refs/seatworks/lanes/L1\\. Its Peers are archived, and its Lead ${lead} stays until you release it\\. Its working copy S0 stays with its Lead\\.`,
    ),
  );
  assert.notEqual(h.git(h.root, "branch", "--list", part.branch).trim(), "");
  assert.match(
    h.heard(lead).join("\n"),
    /LANE CLOSED L1 \(Part B\): landed[^]*you stay on with what you know of it until the Supervisor or the Human releases you/,
  );
  assert.match(
    (await h.call(lead, "lead", "status", {})).text,
    /^Lane L1 \(Part B\) is closed and landed\. You are kept on with what you know of it until the Supervisor or the Human releases you: nothing of it is yours to do\.$/,
  );
  assert.match(
    (await h.call(sup, "supervisor", "status", {})).text,
    new RegExp(
      `## Kept Leads\\n\\n- L1 Part B, landed: Lead ${lead} idle \\d+ min, in S0\\. Kept until it is released\\.`,
    ),
  );

  const other = await isolated(h, sup, "Part C", "c");
  assert.equal(other.slot, "S1");
  assert.equal((await release("L1")).text, `Lane L1's Lead ${lead} is released, and its working copy S0 is put away.`);
  assert.ok(h.agents.get(lead)!.archivedAt);
  assert.equal(existsSync(part.worktree!), false);
  assert.equal(h.git(h.root, "branch", "--list", part.branch).trim(), "");
  assert.deepEqual(copyCalls(part.worktree!), ["open", "close"]);
  assert.match((await release("L1")).text, /Lane L1's Lead is gone already, and nothing of it is kept\./);
  assert.equal((await isolated(h, sup, "Part D", "d")).slot, "S2");

  assert.equal((await h.call(sup, "supervisor", "land_lane", { lane: "L2" })).ok, true);
  assert.ok(existsSync(other.worktree!));
  await (h.paseo as { agents: { ref: (id: string) => { archive: () => Promise<void> } } }).agents.ref(sup).archive();
  assert.ok(h.agents.get(other.lead!)!.archivedAt);
  await h.tick();
  assert.equal(existsSync(other.worktree!), false);
  assert.equal(h.git(h.root, "branch", "--list", other.branch).trim(), "");
});

test("closing a lane settles what it leaves: its asks answered, its questions canceled, its unfinished tasks cut, and its kept Lead never reminded", async () => {
  const { h, sup, lane, peer } = await laneWithPeer({ hitl: { on: true } }, undefined, {
    holds: ["a.txt"],
    parallel: true,
  });
  assert.equal((await h.call(peer, "peer", "ask", { question: "Round half up?", bestGuess: "half up" })).ok, true);
  const ask = Object.values(h.ledger().asks)[0]!;
  await h.call(sup, "supervisor", "ask_human", {
    lane: "L1",
    question: "Keep old invoices?",
    why: "They cannot come back.",
    options: [
      { label: "Delete", effect: "gone" },
      { label: "Archive", effect: "kept" },
    ],
    recommend: "Archive",
    reason: "Nothing is lost.",
    ifSilent: "The lane archives them.",
    class: "reversible",
  });
  const dropped = await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "not needed after all" });
  assert.match(dropped.text, /It cut L1-T1, which was not finished\./);
  assert.match(dropped.text, /Its open question for the Human, H1, is canceled\./);
  assert.deepEqual(
    [h.ledger().asks[ask.id]!.status, h.ledger().asks[ask.id]!.answer],
    ["answered", "Lane L1 closed before this was answered."],
  );
  assert.deepEqual([h.ledger().questions.H1!.status, h.ledger().questions.H1!.answer?.by], ["canceled", "desk"]);
  assert.deepEqual(
    h.events("question.answered").map((event) => [event.question, event.status, event.by]),
    [["H1", "canceled", "desk"]],
  );
  await h.idle(lane.lead!);
  const before = h.heard(lane.lead!).length;
  await h.tick(Date.now() + 60 * 60_000);
  assert.equal(h.heard(lane.lead!).length, before);
});
