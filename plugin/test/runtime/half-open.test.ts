import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { harness, heldCreate, laneWithPeer } from "./harness.ts";

const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["anything else in the repository"] };

test("a stop while seats were being started takes on what Paseo seated and gives back what it never seated", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", ...scope, isolate: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Order", ...scope, after: ["L1"], isolate: true });
  const order = heldCreate(h, /^L2 · Lead/);
  void h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  await order.reached;
  const reserved = h.ledger().lanes.L2!.slot!;
  const aside = heldCreate(h, /^L3 · Lead/);
  void h.call(sup, "supervisor", "open_lane", { title: "Aside", ...scope });
  await aside.reached;
  const branch = h.ledger().lanes.L3!.branch;
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), branch);
  h.restart();
  await h.tick(Date.now());
  const lanes = h.ledger().lanes;
  assert.equal(h.ledger().slots[reserved], undefined);
  assert.equal(lanes.L2!.status, "open");
  assert.ok(lanes.L2!.lead && lanes.L2!.slot);
  assert.deepEqual([lanes.L3!.status, lanes.L3!.worktree, lanes.L3!.workspaceId], ["closed", undefined, undefined]);
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), "main");
  assert.equal(h.git(h.root, "branch", "--list", branch).trim(), "");
  assert.match(h.heard(sup).join("\n"), /NOT OPENED L3 \(Aside\): the desk stopped while its Lead was being started/);

  const lead = lanes.L2!.lead;
  const task = (key: string, extra: Record<string, unknown>) => ({
    tasks: [{ key, title: key, goal: "g", acceptance: ["a"], outOfScope: ["the rest"], ...extra }],
  });
  const waited = heldCreate(h, /^L2-T1 ·/);
  void h.call(lead, "lead", "add_tasks", task("Waited", { hints: ["b.txt"] }));
  await waited.reached;
  const review = heldCreate(h, /^L2-R1 ·/);
  void h.call(lead, "lead", "start_review", { focus: "the lane as a whole" });
  await review.reached;
  const seated = heldCreate(h, /^L2-T2 ·/, true);
  void h.call(lead, "lead", "add_tasks", task("Seated", { holds: ["c.txt"], parallel: true }));
  await seated.reached;
  const peer = [...h.agents.values()].find((agent) => agent.title.startsWith("L2-T2 ·"))!.id;
  const seats = h.agents.size;
  h.restart();
  await h.tick(Date.now());
  const tasks = h.ledger().tasks;
  assert.equal(tasks["L2-T1"]!.status, "running");
  assert.ok(tasks["L2-T1"]!.peer);
  assert.equal(tasks["L2-R1"]!.status, "cut");
  assert.equal(tasks["L2-T2"]!.peer, peer);
  assert.equal(h.agents.size, seats + 1);
  await h.idle(lead);
  assert.match(
    h.agents.get(lead)!.sent.join("\n"),
    /NOT STARTED L2-R1 \([^)]*\): the desk stopped while its Peer was being started, so it is cut\.\n\nNext: add_tasks it again if you still want it/,
  );
});

test("a round leaves alone a lane or a task whose seat is still being started", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const lead = heldCreate(h, /^L1 · Lead/);
  const opening = h.call(sup, "supervisor", "open_lane", { title: "Slow", ...scope, isolate: true });
  await lead.reached;
  await h.tick(Date.now());
  assert.equal(h.ledger().lanes.L1!.status, "open");
  lead.release();
  assert.equal((await opening).ok, true);
  assert.ok(h.ledger().lanes.L1!.lead);

  const peer = heldCreate(h, /^L1-T1 ·/);
  const tasks = [
    { key: "t", title: "Beside", goal: "g", acceptance: ["a"], holds: ["c.txt"], outOfScope: ["x"], parallel: true },
  ];
  const starting = h.call(h.ledger().lanes.L1!.lead!, "lead", "add_tasks", { tasks });
  await peer.reached;
  await h.tick(Date.now());
  assert.deepEqual([h.ledger().tasks["L1-T1"]!.status, h.ledger().tasks["L1-T1"]!.peer], ["running", undefined]);
  peer.release();
  assert.equal((await starting).ok, true);
  assert.deepEqual([h.ledger().tasks["L1-T1"]!.status, Boolean(h.ledger().tasks["L1-T1"]!.peer)], ["running", true]);
});

test("a lane whose Lead is gone gets one where it stands, with the asks that waited on the old one, and one Paseo already seated is taken on", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const replace = () => h.call(sup, "supervisor", "replace_lead", { lane: "L1" });
  assert.match((await replace()).text, /still seated; message it instead/);
  assert.equal((await h.call(peer, "peer", "ask", { question: "Which rounding?", bestGuess: "half up" })).ok, true);
  h.agents.get(lane.lead!)!.status = "idle";
  assert.match(
    (await h.call(sup, "supervisor", "release", { lane: "L1" })).text,
    new RegExp(
      `^Lane L1's Lead ${lane.lead} is released; the lane stays open where it stands, for replace_lead to seat another\\.`,
    ),
    "the Supervisor may end the Lead of a lane still under way",
  );
  assert.ok(h.agents.get(lane.lead!)!.archivedAt);
  assert.equal((await h.call(peer, "peer", "ask", { question: "Cents or units?", bestGuess: "cents" })).ok, true);

  const replaced = await replace();
  assert.equal(replaced.ok, true, replaced.text);
  const now = h.ledger().lanes.L1!;
  assert.notEqual(now.lead, lane.lead);
  assert.notEqual(now.lead, peer);
  const seated = h.agents.get(now.lead!)!;
  assert.equal(seated.cwd, lane.worktree);
  assert.match(
    seated.prompt ?? "",
    new RegExp(`^You take over L1 from its Lead ${lane.lead}, which is gone\\.[^]*SUPERVISOR DIRECTIVE L1: Build`),
  );
  assert.deepEqual(
    Object.values(h.ledger().asks).map((ask) => ask.to),
    [now.lead, sup],
    "one put to the Supervisor while the lane had no Lead stays the Supervisor's",
  );
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "running");
  assert.match((await h.call(sup, "supervisor", "answer", { ask: "A2", text: "cents" })).text, /Its lane's Lead/);
  assert.match(
    h.heard(now.lead!).join("\n"),
    new RegExp(
      `ANSWERED FOR YOU: A2 \\(question\\) from the Peer on L1-T1, put to the Supervisor while your lane had no Lead, was answered by the Supervisor\\.[^]*cents`,
    ),
    "the Supervisor reaching a Peer past its Lead never leaves the Lead out of sight",
  );

  h.agents.get(now.lead!)!.archivedAt = new Date().toISOString();
  await h.tick(Date.now());
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 31 * 60_000 });
  try {
    await h.tick(Date.now());
  } finally {
    mock.timers.reset();
  }
  const mail = h.agents.get(sup)!.sent.join("\n---\n");
  assert.equal(mail.match(/^LEAD GONE L1/gm)?.length, 1, mail);
  assert.match(
    mail,
    /LEAD GONE L1 \(Build\): its Lead [^ ]+ is no longer seated[^]*replace_lead puts a new Lead on it where it stands/,
  );

  const orphan = h.add("sw3-lead-claude/claude-opus-5", lane.worktree!, "L1 Build", "idle", undefined, {
    "seatworks.project": h.project.slug,
    "seatworks.lane": "L1",
    "seatworks.role": "lead",
  });
  const before = h.agents.size;
  assert.match((await replace()).text, new RegExp(`the Lead ${orphan} that Paseo already had seated for it`));
  assert.deepEqual([h.ledger().lanes.L1!.lead, h.agents.size], [orphan, before]);
});
