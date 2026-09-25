import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { harness, laneWithPeer } from "./harness.ts";

const { saveLedger } = await import("../../server/desk/ledger.ts");
const { settle } = await import("./fake-timeline.ts");

test("a lane that waits for another opens by itself once that one lands, off a base that has its work, and its Supervisor is told", async () => {
  const h = harness("outbox-after.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", { gate: "true" });
  const scope = { acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", outcome: "a cart", ...scope, writeSet: ["a.txt"] });
  const cart = h.ledger().lanes.L1!;

  const queued = await h.call(sup, "supervisor", "open_lane", { title: "Order", outcome: "orders from the cart", ...scope, writeSet: ["a.txt"], after: ["l1"] });
  assert.equal(queued.ok, true, queued.text);
  assert.match(queued.text, /Lane L2 waits for L1 \(open\)/);
  const waiting = h.ledger().lanes.L2!;
  assert.deepEqual([waiting.status, waiting.lead, waiting.after], ["waiting", undefined, ["L1"]], "recorded, with nothing started for it");
  assert.equal(h.git(h.root, "branch", "--list", waiting.branch).trim(), "", "and no branch made yet");
  assert.match((await h.call(sup, "supervisor", "status", {})).text, /## Waiting lanes\n\n- L2 Order: after L1 open\n  Outcome: orders from the cart/);

  h.commit(h.root, "a.txt", "cart\n");
  h.agents.get(cart.lead!)!.status = "idle";
  await h.endTurn(cart.lead!, "done");
  const closed = await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: true });
  assert.equal(closed.ok, true, closed.text);
  const order = h.ledger().lanes.L2!;
  assert.deepEqual([order.status, h.ledger().lanes.L1!.landed], ["open", true]);
  assert.ok(order.lead, "its Lead is seated");
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), order.branch);
  assert.equal(readFileSync(join(h.root, "a.txt"), "utf-8"), "cart\n", "off a base that has the lane it waited for");
  assert.match(h.agents.get(sup)!.sent.join("\n"), /WAITING L2 \(Order\), the lane you opened to wait for L1: Lane L2 is open on lane\/l2-order/);
  h.runtime.dispose();
});

test("a lane waiting for one that closes without landing stays waiting, and its Supervisor is told once until it drops it", async () => {
  const h = harness("outbox-after-dropped.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", outcome: "a cart", ...scope, isolate: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Order", outcome: "orders", ...scope, after: ["L1"] });
  await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: false });
  await h.tick(Date.now());
  await h.tick(Date.now());

  assert.equal(h.ledger().lanes.L2!.status, "waiting");
  const told = h.agents.get(sup)!.sent.filter((text) => text.startsWith("WAITING L2"));
  assert.equal(told.length, 1, told.join("\n---\n"));
  assert.match(told[0]!, /Lane L1 closed without landing, so nothing of it is there to build on/);
  assert.match((await h.call(sup, "supervisor", "status", {})).text, /- L2 Order: after L1 closed without landing\. Not open: Lane L1 closed without landing/);

  assert.match((await h.call(sup, "supervisor", "close_lane", { lane: "L2", land: true })).text, /never opened/);
  const dropped = await h.call(sup, "supervisor", "close_lane", { lane: "L2", land: false });
  assert.match(dropped.text, /was waiting and is dropped/);
  assert.equal(h.ledger().lanes.L2!.status, "closed");
  h.runtime.dispose();
});

test("a waiting lane whose turn comes while an open lane writes its paths is held with the reason, and opens when that lane closes", async () => {
  const h = harness("outbox-after-held.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", outcome: "a cart", ...scope, writeSet: ["a.txt"], isolate: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Bees", outcome: "bees", ...scope, writeSet: ["b.txt"], isolate: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Order", outcome: "orders", ...scope, writeSet: ["b.txt"], after: ["L1"] });
  // Stopped first, so each close puts its copy away at once instead of leaving it to a later round.
  for (const id of ["L1", "L2"]) h.agents.get(h.ledger().lanes[id]!.lead!)!.status = "idle";

  await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: true });
  const held = h.ledger().lanes.L3!;
  assert.equal(held.status, "waiting");
  assert.match(held.held?.why ?? "", /overlaps lane L2 at b\.txt/, "checked again against the lanes open when its turn came");
  const letters = h.agents.get(sup)!.sent.filter((text) => text.startsWith("WAITING L3"));
  assert.equal(letters.length, 1);
  assert.match(letters[0]!, /overlaps lane L2 at b\.txt\. It opens by itself once that clears; amend it, or close it to drop it\./);
  assert.doesNotMatch(letters[0]!, /open it after L2 lands/, "not told to do what it already does");

  await h.tick(Date.now());
  assert.equal(h.ledger().lanes.L3!.status, "waiting", "a patrol round asks again and finds it still held");
  await h.call(sup, "supervisor", "open_lane", { title: "Aside", outcome: "aside", ...scope, writeSet: [".idea/misc.xml"], isolate: true });
  h.agents.get(h.ledger().lanes.L4!.lead!)!.status = "idle";
  await h.call(sup, "supervisor", "close_lane", { lane: "L4", land: false });
  const told = readFileSync(join(h.project.state, "events.log"), "utf-8").split("\n").filter((line) => line.includes('"lane.held"') && line.includes('"L3"'));
  assert.equal(told.length, 1, "tried again when a lane closed, held for the same reason, and not told twice");
  await h.call(sup, "supervisor", "close_lane", { lane: "L2", land: false });
  assert.equal(h.ledger().lanes.L3!.status, "open", "the close that freed its paths opens it");
  assert.equal(h.ledger().lanes.L3!.held, undefined);
  h.agents.get(h.ledger().lanes.L3!.lead!)!.status = "idle";
  await h.call(sup, "supervisor", "close_lane", { lane: "L3", land: false });
  h.runtime.dispose();
});

test("a lane may wait only for lanes that exist and can still land, and one whose lanes have all landed opens at once", async () => {
  const h = harness("outbox-after-refused.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  const open = (extra: Record<string, unknown>) => h.call(sup, "supervisor", "open_lane", { title: "T", ...scope, ...extra });

  assert.match((await open({ after: ["L9"] })).text, /There is no lane L9 to wait for/);
  await open({ isolate: true });
  await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: false });
  assert.match((await open({ after: ["L1"] })).text, /Lane L1 closed without landing[^]*Open this lane without waiting for it/);
  assert.match((await open({ after: ["L1"], onBranch: true, newBranch: "x" })).text, /A lane that waits cannot start a branch/);

  await open({ onBranch: true });
  const carried = Object.values(h.ledger().lanes).find((lane) => lane.onBranch)!;
  assert.match((await open({ after: [carried.id] })).text, new RegExp(`Lane ${carried.id} carries on main and merges nowhere, so a lane waiting for it carries on that branch too`));
  const behind = await open({ after: [carried.id], onBranch: true });
  assert.equal(behind.ok, true, behind.text);
  assert.equal(Object.values(h.ledger().lanes).find((lane) => lane.status === "waiting")!.branch, "main", "waiting to carry on the branch the lane before it carries");

  await open({ isolate: true, writeSet: ["b.txt"] });
  const landedId = Object.keys(h.ledger().lanes).at(-1)!;
  await h.call(sup, "supervisor", "close_lane", { lane: landedId, land: true });
  const now = await open({ after: [landedId], isolate: true });
  assert.match(now.text, /is open on lane\//, "nothing left to wait for, so it opens now");
  h.runtime.dispose();
});

test("a patrol round opens a waiting lane whose lanes landed without it being tried, as after a restart", async () => {
  const h = harness("outbox-after-patrol.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", ...scope, isolate: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Order", ...scope, after: ["L1"], isolate: true });
  // The desk stopped between landing L1 and opening what waited for it.
  const ledger = h.ledger();
  Object.assign(ledger.lanes.L1!, { status: "closed", landed: true });
  saveLedger(h.project.state, ledger);

  await h.tick(Date.now());
  assert.equal(h.ledger().lanes.L2!.status, "open");
  assert.ok(h.ledger().lanes.L2!.slot, "in a copy of its own, as it was asked");
  h.runtime.dispose();
});

test("a lane waiting for the project's copy is held while a closed lane's Lead ends its turn there, and a round opens it there once it has", async () => {
  const h = harness("outbox-after-restoring.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", ...scope });
  const cart = h.ledger().lanes.L1!;
  await h.call(sup, "supervisor", "open_lane", { title: "Order", ...scope, after: ["L1"] });
  await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: true });
  assert.ok(h.ledger().lanes.L1!.restoring, "its Lead is mid-turn, so the copy is still on its branch");
  assert.equal(h.ledger().lanes.L2!.status, "waiting");
  assert.match(h.ledger().lanes.L2!.held?.why ?? "", /its Lead is still ending a turn in the project's own copy/);
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), cart.branch, "and the copy the Lead is writing in is not switched under it");

  h.agents.get(cart.lead!)!.status = "idle";
  await h.endTurn(cart.lead!, "stopping");
  await h.tick(Date.now());
  const order = h.ledger().lanes.L2!;
  assert.deepEqual([order.status, order.slot], ["open", undefined], "it waited for the project's copy, as the Supervisor chose, and opened there");
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), order.branch);
  h.runtime.dispose();
});

test("work that arrives mid-lane is folded into the lane that owns it, and the lane that needs it opens once it lands", async () => {
  const h = harness("outbox-cart.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", { gate: "true" });
  const scope = { outOfScope: ["anything else in the repository"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", outcome: "add and update cart items", acceptance: ["adds an item"], ...scope, writeSet: ["a.txt"] });
  await h.call(sup, "supervisor", "open_lane", { title: "Order", outcome: "an order from the cart", acceptance: ["orders what is in the cart"], ...scope, writeSet: ["b.txt"], contracts: ["a.txt"], after: ["L1"] });
  const cart = h.ledger().lanes.L1!;
  await h.call(cart.lead!, "lead", "start_task", { title: "Add to cart", goal: "add an item", acceptance: ["adds an item"], owned: ["a.txt"], outOfScope: ["the rest"] });
  const peer = h.ledger().tasks["L1-T1"]!.peer!;

  // Ten minutes in, the Human asks for an upsert: it rewrites the code the Peer is writing, so it goes to that lane.
  assert.equal((await h.call(sup, "supervisor", "amend_lane", { lane: "L1", why: "the Human wants an upsert", acceptance: ["adds an item", "upserts an item"] })).ok, true);
  assert.equal((await h.call(cart.lead!, "lead", "amend_task", { task: "L1-T1", why: "the lane now upserts", goal: "upsert an item", acceptance: ["adds an item", "upserts an item"] })).ok, true);
  assert.deepEqual(Object.values(h.ledger().lanes).map((lane) => [lane.id, lane.status]), [["L1", "open"], ["L2", "waiting"]], "no lane of its own, so no second writer on the cart");

  h.commit(h.root, "a.txt", "upsert\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "upsert in place" });
  h.agents.get(peer)!.status = "idle";
  assert.equal((await h.call(cart.lead!, "lead", "accept", { task: "L1-T1" })).ok, true);
  h.agents.get(cart.lead!)!.status = "idle";
  await h.endTurn(cart.lead!, "ready");
  const landed = await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: true });
  assert.equal(landed.ok, true, landed.text);

  const order = h.ledger().lanes.L2!;
  assert.equal(order.status, "open", "the lane that needed the cart opens once it lands");
  assert.equal(readFileSync(join(h.root, "a.txt"), "utf-8"), "upsert\n", "off a base with the cart as amended");
  assert.deepEqual(h.ledger().lanes.L1!.amended?.[0]?.was, { acceptance: ["adds an item"] }, "and the record keeps what the cart was asked first");
  h.runtime.dispose();
});

test("a waiting lane that cannot start is held with why, and a patrol round does not set it up and tear it down again", async () => {
  const h = harness("outbox-after-unstartable.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  h.git(h.root, "branch", "gone-base");
  await h.call(sup, "supervisor", "open_lane", { title: "First", ...scope, isolate: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Unled", ...scope, after: ["L1"], isolate: true, role: "peer" });
  await h.call(sup, "supervisor", "open_lane", { title: "Baseless", ...scope, after: ["L1"], isolate: true, base: "gone-base" });
  h.git(h.root, "branch", "-D", "gone-base");
  h.agents.get(h.ledger().lanes.L1!.lead!)!.status = "idle";
  await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: true });

  assert.match(h.ledger().lanes.L2!.held?.why ?? "", /peer that can lead a lane|can lead a lane/);
  assert.match(h.ledger().lanes.L3!.held?.why ?? "", /its base branch gone-base no longer exists/);
  const taken = () => readFileSync(join(h.project.state, "events.log"), "utf-8").split("\n").filter((line) => line.includes('"slot.taken"')).length;
  const before = taken();
  await h.tick(Date.now());
  await h.tick(Date.now());
  assert.equal(taken(), before, "no copy is made and put away again each round");
  assert.deepEqual([h.ledger().lanes.L2!.status, h.ledger().lanes.L3!.status], ["waiting", "waiting"]);

  h.git(h.root, "branch", "gone-base");
  await h.tick(Date.now());
  assert.deepEqual([h.ledger().lanes.L2!.status, h.ledger().lanes.L3!.status], ["waiting", "open"], "a round opens the lane whose base came back, with no lane closing");
  assert.equal(h.ledger().lanes.L3!.held, undefined);
  h.runtime.dispose();
});

test("a lane waiting to carry on a branch is held if the Human's copy has moved off it by its turn", async () => {
  const h = harness("outbox-after-moved.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  await h.call(sup, "supervisor", "set_project", { gate: "true" });
  await h.call(sup, "supervisor", "open_lane", { title: "First", ...scope, onBranch: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Then", ...scope, onBranch: true, after: ["L1"] });
  h.git(h.root, "switch", "-qc", "elsewhere");
  h.agents.get(h.ledger().lanes.L1!.lead!)!.status = "idle";
  await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: true });
  assert.equal(h.ledger().lanes.L2!.status, "waiting");
  assert.match(h.ledger().lanes.L2!.held?.why ?? "", /it carries on main, and the project's own copy is on elsewhere now/);

  h.git(h.root, "switch", "-q", "main");
  await h.tick(Date.now());
  assert.equal(h.ledger().lanes.L2!.status, "open", "the Human switching back is enough, no lane has to close");
  h.runtime.dispose();
});

test("an amendment changes what an open lane is asked, keeps what it was asked, and tells its Lead what moved and that its READY no longer stands", async () => {
  const { h, sup, lane } = await laneWithPeer("outbox-amend-lane.json");
  const amended = await h.call(sup, "supervisor", "amend_lane", { lane: "L1", why: "the Human wants an upsert too", acceptance: ["a", "upserts an item"] });
  assert.equal(amended.ok, true, amended.text);
  assert.match(amended.text, /its Lead has the change; a READY it reported before no longer stands/);
  const now = h.ledger().lanes.L1!;
  assert.deepEqual(now.acceptance, ["a", "upserts an item"]);
  assert.deepEqual(now.amended?.map((entry) => [entry.by, entry.why, entry.was]), [[sup, "the Human wants an upsert too", { acceptance: ["a"] }]]);
  assert.equal(h.agents.get(lane.lead!)!.sent.some((text) => text.startsWith("AMENDED")), false, "held while it is mid-turn, not pushed into it");
  await h.idle(lane.lead!);
  const letter = h.agents.get(lane.lead!)!.sent.find((text) => text.startsWith("AMENDED L1"))!;
  assert.match(letter, /AMENDED L1 \(Build\): the Human wants an upsert too\n\nacceptance, was:\n- a\nacceptance, now:\n- a\n- upserts an item\n\nCarry it into the tasks it touches: amend_task/);
  assert.match(letter, /A READY you reported before this no longer stands/);
  assert.doesNotMatch(letter, /supervisor/i, "a Lead is not shown the word its role hides");

  assert.match((await h.call(sup, "supervisor", "amend_lane", { lane: "L1", why: "again", acceptance: ["a", "upserts an item"] })).text, /Nothing about lane L1 would change/);
  assert.match((await h.call(sup, "supervisor", "amend_lane", { lane: "L1", why: "x", acceptance: [] })).text, /at least one acceptance line/);
  await h.call(sup, "supervisor", "open_lane", { title: "Bees", outcome: "bees", acceptance: ["a"], outOfScope: ["the rest"], writeSet: ["b.txt"], isolate: true });
  assert.match((await h.call(sup, "supervisor", "amend_lane", { lane: "L1", why: "x", writeSet: ["a.txt", "b.txt"] })).text, /(overlaps lane L2 at b\.txt|L2 may already be writing b\.txt)[^]*Leave those paths out of this lane/, "a lane that takes on more paths is checked against the lanes open now");
  h.runtime.dispose();
});

test("a waiting lane is amended in place and opens as it is asked then; a closed one is not amended", async () => {
  const h = harness("outbox-amend-waiting.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", outcome: "a cart", ...scope, isolate: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Order", outcome: "orders", ...scope, after: ["L1"], isolate: true });
  const amended = await h.call(sup, "supervisor", "amend_lane", { lane: "L2", why: "orders need an upserted cart", outcome: "orders from an upserted cart" });
  assert.match(amended.text, /Lane L2 is amended; it opens as it is now/);

  await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: true });
  const order = h.ledger().lanes.L2!;
  assert.equal(order.status, "open");
  assert.match(h.agents.get(order.lead!)!.prompt ?? "", /Outcome: orders from an upserted cart/, "its Lead is briefed on what it is asked now");
  assert.match((await h.call(sup, "supervisor", "amend_lane", { lane: "L1", why: "x", outcome: "y" })).text, /Lane L1 is closed/);
  h.runtime.dispose();
});

test("a Lead amends a task its Peer is on: the Peer is told at its next turn, and the watch reads it against what it asks now", async (t) => {
  const { h, lane, peer } = await laneWithPeer("outbox-amend-task.json");
  const amended = await h.call(lane.lead!, "lead", "amend_task", { task: "L1-T1", why: "the lane now wants an upsert", goal: "upsert into the cart" });
  assert.equal(amended.ok, true, amended.text);
  assert.match(amended.text, /L1-T1 is amended; its Peer has it at its next turn/);
  const task = h.ledger().tasks["L1-T1"]!;
  assert.deepEqual([task.goal, task.amended?.[0]?.was], ["upsert into the cart", { goal: "g" }]);
  await h.idle(peer);
  const letter = h.agents.get(peer)!.sent.find((text) => text.startsWith("AMENDED L1-T1"))!;
  assert.match(letter, /goal, was:\ng\ngoal, now:\nupsert into the cart\n\nWork to it as it stands now/);
  assert.doesNotMatch(letter, /seat|supervisor|paseo/i, "a Peer is not shown the words its role hides");

  const states: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { state: Record<string, unknown>; questions: Record<string, unknown> };
    states.push(body.state);
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((n) => [n, { type: "noul", noul: 0.1 }])), model: "m", id: "g", usage: { cost: 0 } }), { status: 200 });
  });
  const timeline = h.timelineOf(peer);
  timeline.beat("turn_started", "t1");
  timeline.add({ type: "user_message", text: "build it" }, "t1");
  timeline.beat("turn_completed", "t1");
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(JSON.stringify(states.find((state) => "role" in state) ?? {}), /Goal: upsert into the cart/, "not flagged for drifting off the goal it was given before");

  await h.call(lane.lead!, "lead", "cut", { task: "L1-T1", reason: "done with it" });
  assert.match((await h.call(lane.lead!, "lead", "amend_task", { task: "L1-T1", why: "x", goal: "y" })).text, /L1-T1 is cut; start a task for what is asked now/);
  h.runtime.dispose();
});

test("a lane a stop left half-open gives back what it took: one that waited waits again and opens, one never answered is closed and told", async () => {
  const h = harness("outbox-half-open.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", ...scope, isolate: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Order", ...scope, after: ["L1"], isolate: true });
  // The desk stopped after L1 landed, with L2 claimed and a copy reserved for it, and with L3 mid-open in the Human's copy.
  h.git(h.root, "switch", "-qc", "lane/l3-aside");
  const ledger = h.ledger();
  Object.assign(ledger.lanes.L1!, { status: "closed", landed: true });
  ledger.lanes.L2!.status = "open";
  ledger.slots.S9 = { id: "S9", path: join(h.project.state, "gone-S9"), createdAt: Date.now(), lane: "L2" };
  ledger.lanes.L3 = { ...ledger.lanes.L1!, id: "L3", title: "Aside", branch: "lane/l3-aside", status: "open", landed: undefined, lead: undefined, slot: undefined, worktree: undefined, workspaceId: undefined };
  ledger.seq.lane = 3;
  saveLedger(h.project.state, ledger);

  await h.tick(Date.now());
  const after = h.ledger();
  assert.equal(after.slots.S9, undefined, "the copy reserved before the stop is given back");
  assert.equal(after.lanes.L2!.status, "open");
  assert.ok(after.lanes.L2!.lead, "and the lane that waited is opened again, with a Lead");
  assert.equal(after.lanes.L3!.status, "closed", "a lane whose opening was never answered is not opened behind its Supervisor");
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), "main", "the Human's copy is back on its base");
  assert.equal(h.git(h.root, "branch", "--list", "lane/l3-aside").trim(), "");
  assert.match(h.agents.get(sup)!.sent.join("\n"), /NOT OPENED L3 \(Aside\): the desk stopped while its Lead was being started/);
  h.runtime.dispose();
});

test("a round while a lane's Lead is still being started leaves that lane alone", async () => {
  const h = harness("outbox-half-open-live.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const paseo = h.paseo as unknown as { workspaces: { ref(id: string): { agents: { create(options: unknown): Promise<unknown> } } } };
  const ref = paseo.workspaces.ref;
  let go!: () => void;
  const held = new Promise<void>((resolve) => (go = resolve));
  paseo.workspaces.ref = (id) => {
    const workspace = ref(id);
    const create = workspace.agents.create;
    workspace.agents.create = async (options) => (await held, create(options));
    return workspace;
  };
  const opening = h.call(sup, "supervisor", "open_lane", { title: "Slow", outcome: "x", acceptance: ["a"], outOfScope: ["the rest"], isolate: true });
  const starting = () => Object.values(h.ledger().slots).some((slot) => slot.lane === "L1" && slot.workspaceId);
  for (let i = 0; i < 200 && !starting(); i++) await settle();
  assert.ok(starting(), "its Lead is being started in a copy of its own");
  await h.tick(Date.now());
  assert.equal(h.ledger().lanes.L1!.status, "open", "not taken for one a stop left half-open");
  go();
  assert.equal((await opening).ok, true);
  assert.ok(h.ledger().lanes.L1!.lead);
  h.runtime.dispose();
});

test("a Lead Paseo started before a stop kept the desk from recording it is taken on, not left writing in a copy given back", async () => {
  const h = harness("outbox-half-open-lead.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", outcome: "x", acceptance: ["a"], outOfScope: ["the rest"] });
  const opened = h.ledger().lanes.L1!;
  // The desk stopped after Paseo seated the Lead in the Human's copy and before the ledger said so.
  const ledger = h.ledger();
  delete ledger.lanes.L1!.lead;
  delete ledger.agents[opened.lead!];
  saveLedger(h.project.state, ledger);

  const agents = (h.paseo as unknown as { agents: { list: () => Promise<unknown> } }).agents;
  const list = agents.list;
  agents.list = async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
  await h.tick(Date.now());
  assert.deepEqual([h.ledger().lanes.L1!.status, h.git(h.root, "branch", "--show-current").trim()], ["open", opened.branch], "a daemon that listed nothing is no word that no Lead was started");
  agents.list = list;
  await h.tick(Date.now());
  const lane = h.ledger().lanes.L1!;
  assert.deepEqual([lane.status, lane.lead, h.ledger().agents[opened.lead!]?.lane], ["open", opened.lead, "L1"]);
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), opened.branch, "the copy its Lead writes in is left where it is");
  assert.equal([...h.agents.values()].filter((agent) => agent.title.startsWith("L1 ")).length, 1, "and no second Lead is started");
  assert.match(h.agents.get(sup)!.sent.join("\n"), /OPENED L1 \(Cart\): the desk stopped while its Lead was being started, and that Lead, [^,]+, is kept on it/);
  h.runtime.dispose();
});

test("a waiting lane asked to open by a round and a close at once opens once, with one Lead", async () => {
  const h = harness("outbox-after-race.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", ...scope, isolate: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Order", ...scope, after: ["L1"], isolate: true });
  const ledger = h.ledger();
  Object.assign(ledger.lanes.L1!, { status: "closed", landed: true });
  saveLedger(h.project.state, ledger);

  await Promise.all([h.runtime.desk.openWaiting(h.project), h.runtime.desk.openWaiting(h.project)]);
  assert.equal(h.ledger().lanes.L2!.status, "open");
  assert.equal([...h.agents.values()].filter((agent) => agent.title.startsWith("L2 ")).length, 1, "both passed the checks, and only one claimed it");
  assert.equal(Object.values(h.ledger().slots).filter((slot) => slot.lane === "L2").length, 1, "and only one copy was taken for it");
  h.runtime.dispose();
});

test("a lane whose Lead is gone gets a new one where it stands, with the asks that waited on the old one, and its Supervisor is told once", async () => {
  const { h, sup, lane, peer } = await laneWithPeer("outbox-replace-lead.json");
  assert.match((await h.call(sup, "supervisor", "replace_lead", { lane: "L1" })).text, /still seated; message it instead/);
  assert.equal((await h.call(peer, "peer", "ask", { question: "Which rounding?" })).ok, true);
  h.agents.get(lane.lead!)!.archivedAt = new Date().toISOString();

  const replaced = await h.call(sup, "supervisor", "replace_lead", { lane: "L1" });
  assert.equal(replaced.ok, true, replaced.text);
  const now = h.ledger().lanes.L1!;
  assert.notEqual(now.lead, lane.lead);
  assert.notEqual(now.lead, peer, "a Peer carries the lane's label too, and is not taken for its Lead");
  const seated = h.agents.get(now.lead!)!;
  assert.equal(seated.cwd, lane.worktree, "in the copy the lane already has, on its branch");
  assert.match(seated.prompt ?? "", new RegExp(`^You take over L1 from its Lead ${lane.lead}, which is gone\\.[^]*OWNER DIRECTIVE L1: Build`));
  assert.doesNotMatch(seated.prompt ?? "", /supervisor/i, "a Lead is not shown the word its role hides");
  assert.deepEqual(Object.values(h.ledger().asks).map((ask) => ask.to), [now.lead], "the ask that waited on the old Lead waits on the new one");
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "running", "and the lane's task carries on");

  h.agents.get(now.lead!)!.archivedAt = new Date().toISOString();
  await h.tick(Date.now());
  // Past the half hour the mail itself counts a letter as new again.
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 31 * 60_000 });
  try {
    await h.tick(Date.now());
  } finally {
    mock.timers.reset();
  }
  const mail = h.agents.get(sup)!.sent.join("\n---\n");
  assert.equal(mail.match(/LEAD GONE L1/g)?.length, 1, mail);
  assert.match(mail, /LEAD GONE L1 \(Build\): its Lead [^ ]+ is no longer seated[^]*replace_lead puts a new Lead on it where it stands/);
  assert.match(mail, /\[Project [^\]]+\]\nLEAD GONE L1/, "the letter names its project, so the chat can say which");
  h.runtime.dispose();
});

test("a Lead Paseo seated for a lane but the ledger never recorded is taken on rather than seating a second", async () => {
  const { h, sup, lane } = await laneWithPeer("outbox-replace-adopt.json");
  h.agents.get(lane.lead!)!.archivedAt = new Date().toISOString();
  const orphan = h.add("sw2-lead-claude/claude-opus-5", lane.worktree!, "L1 Build", "idle", undefined, { "seatworks.project": h.project.slug, "seatworks.lane": "L1", "seatworks.role": "lead" });
  const before = h.agents.size;
  const replaced = await h.call(sup, "supervisor", "replace_lead", { lane: "L1" });
  assert.match(replaced.text, new RegExp(`the Lead ${orphan} that Paseo already had seated for it`));
  assert.deepEqual([h.ledger().lanes.L1!.lead, h.agents.size], [orphan, before]);
  h.runtime.dispose();
});

test("a task that waits for another starts by itself once that one is accepted, as it was amended, and its Lead is told", async () => {
  const { h, lane, peer } = await laneWithPeer("outbox-task-after.json");
  const lead = lane.lead!;
  const queued = await h.call(lead, "lead", "start_task", { title: "Receipt", goal: "show the total", acceptance: ["a"], owned: ["b.txt"], outOfScope: ["the rest"], after: ["l1-t1"] });
  assert.equal(queued.ok, true, queued.text);
  assert.match(queued.text, /L1-T2 waits for L1-T1 \(running\)/);
  assert.deepEqual([h.ledger().tasks["L1-T2"]!.status, h.ledger().tasks["L1-T2"]!.peer], ["waiting", undefined], "recorded, with no Peer started");
  assert.match((await h.call(lead, "lead", "status", {})).text, /- L1-T2 Receipt: waiting, after L1-T1/);
  assert.match((await h.call(lead, "lead", "accept", { task: "L1-T2" })).text, /L1-T2 is waiting/);
  assert.match((await h.call(lead, "lead", "amend_task", { task: "L1-T2", why: "the Human wants tax on it", goal: "show the total with tax" })).text, /L1-T2 is amended; it starts as it is now/);

  h.commit(lane.worktree!, "a.txt", "T1\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "done" });
  h.agents.get(peer)!.status = "idle";
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T1" })).ok, true);

  const started = h.ledger().tasks["L1-T2"]!;
  assert.equal(started.status, "running");
  assert.equal(h.agents.get(started.peer!)!.cwd, lane.worktree, "in the lane's working copy, now that L1-T1 has left it");
  assert.equal(started.startSha, h.git(lane.worktree!, "rev-parse", "HEAD").trim(), "and it starts from the lane as L1-T1 left it");
  assert.match(h.agents.get(started.peer!)!.prompt ?? "", /show the total with tax/);
  await h.idle(lead);
  assert.match(h.agents.get(lead)!.sent.join("\n"), /WAITING L1-T2 \(Receipt\), the task you started to wait for L1-T1: Started L1-T2 in the lane's working copy/);
  h.runtime.dispose();
});

test("a task waits only for tasks of its own lane, one waiting for a cut task is held and its Lead told, and closing the lane cuts it", async () => {
  const { h, sup, lane } = await laneWithPeer("outbox-task-after-cut.json");
  const lead = lane.lead!;
  const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Other", outcome: "x", ...scope, isolate: true });
  const other = h.ledger().lanes.L2!;
  await h.call(other.lead!, "lead", "start_task", { title: "Theirs", goal: "g", ...scope, owned: ["c.txt"] });
  assert.match((await h.call(lead, "lead", "start_task", { title: "T", goal: "g", ...scope, owned: ["b.txt"], after: ["L2-T1"] })).text, /There is no task in this lane L2-T1 to wait for/);

  await h.call(lead, "lead", "start_task", { title: "Receipt", goal: "g", ...scope, owned: ["b.txt"], after: ["L1-T1"] });
  await h.call(lead, "lead", "cut", { task: "L1-T1", reason: "wrong approach" });
  const held = h.ledger().tasks["L1-T2"]!;
  assert.equal(held.status, "waiting");
  assert.match(held.held?.why ?? "", /L1-T1 was cut, so nothing of it is there to build on/);
  await h.tick(Date.now());
  await h.idle(lead);
  const mail = h.agents.get(lead)!.sent.join("\n---\n");
  assert.equal(mail.match(/WAITING L1-T2/g)?.length, 1, mail);
  assert.match((await h.call(lead, "lead", "start_task", { title: "Again", goal: "g", ...scope, owned: ["b.txt"], after: ["L1-T1"] })).text, /L1-T1 was cut[^]*Start this task without waiting for it/);

  h.agents.get(lead)!.status = "idle";
  await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: false });
  assert.equal(h.ledger().tasks["L1-T2"]!.status, "cut", "a task still waiting when its lane closes goes with it");
  h.runtime.dispose();
});

test("a task whose turn comes while another holds the lane's copy is held with why, and starts once that one is accepted", async () => {
  const { h, lane, peer } = await laneWithPeer("outbox-task-after-held.json");
  const lead = lane.lead!;
  const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
  await h.call(lead, "lead", "start_task", { title: "Beside", goal: "g", ...scope, owned: ["b.txt"], parallel: true });
  await h.call(lead, "lead", "start_task", { title: "After beside", goal: "g", ...scope, owned: ["c.txt"], after: ["L1-T2"] });
  const beside = h.ledger().tasks["L1-T2"]!;
  h.commit(beside.worktree!, "b.txt", "B\n");
  await h.call(beside.peer!, "peer", "done", { outcome: "complete", summary: "b" });
  h.agents.get(beside.peer!)!.status = "idle";
  await h.tick(Date.now());
  assert.deepEqual([h.ledger().tasks["L1-T3"]!.status, h.ledger().tasks["L1-T3"]!.held], ["waiting", undefined], "handed back is not accepted, so its turn has not come");
  await h.call(lead, "lead", "accept", { task: "L1-T2" });
  await h.runtime.desk.settled(h.project);
  await h.tick(Date.now());

  const waiting = h.ledger().tasks["L1-T3"]!;
  assert.equal(h.ledger().tasks["L1-T2"]!.status, "merged");
  assert.equal(waiting.status, "waiting", "a round finds its turn has come, but L1-T1 still writes in the lane's copy");
  assert.match(waiting.held?.why ?? "", /L1-T1 is still writing in the lane's working copy[^]*It starts by itself once that clears/);

  h.commit(lane.worktree!, "a.txt", "A\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "a" });
  h.agents.get(peer)!.status = "idle";
  await h.call(lead, "lead", "accept", { task: "L1-T1" });
  assert.equal(h.ledger().tasks["L1-T3"]!.status, "running", "accepting what held the copy starts it");
  assert.equal(h.ledger().tasks["L1-T3"]!.held, undefined);
  h.runtime.dispose();
});

test("an idle Lead is flagged to its Supervisor, unless it reported its lane ready and waits for the Human", async () => {
  const h = harness("outbox-idle-ready.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { acceptance: ["a"], outOfScope: ["anything else in the repository"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Quiet", outcome: "q", ...scope, writeSet: ["q.txt"], isolate: true });
  await h.call(sup, "supervisor", "open_lane", { title: "Done", outcome: "d", ...scope, writeSet: ["d.txt"], isolate: true });
  const [quiet, done] = [h.ledger().lanes.L1!, h.ledger().lanes.L2!];
  assert.equal((await h.call(done.lead!, "lead", "report", { summary: "done", ready: true })).ok, true);
  const long = new Date(Date.now() - 3 * 3600_000).toISOString();
  for (const lane of [quiet, done]) Object.assign(h.agents.get(lane.lead!)!, { status: "idle", updatedAt: long });
  await h.tick();
  await h.idle(sup);
  const told = h.agents.get(sup)!.sent.join("\n");
  assert.match(told, /LANE IDLE L1 \(Quiet\)/);
  assert.doesNotMatch(told, /LANE IDLE L2/, "ready for the Human is not stalled");
  h.runtime.dispose();
});

test("a project is not detached while a seat still works in it, since that seat would put it back on record", async () => {
  const h = harness("outbox-detach-live.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.tick(Date.now());
  const refused = (await h.runtime.control.removeProject(h.project.slug)) as { error?: string };
  assert.match(refused.error ?? "", new RegExp(`1 seat is still working in it \\(${sup}\\): archive it first`));
  h.agents.get(sup)!.archivedAt = new Date().toISOString();
  assert.deepEqual(await h.runtime.control.removeProject(h.project.slug), { removed: h.project.slug });
  h.runtime.dispose();
});

test("a task left running with no Peer by a stop starts again if it waited, and is cut with its Lead told if not", async () => {
  const { h, lane } = await laneWithPeer("outbox-half-started.json");
  const ledger = h.ledger();
  const base = { lane: "L1", kind: "code" as const, mode: "lane" as const, goal: "g", acceptance: ["a"], owned: ["b.txt"], outOfScope: [], branch: lane.branch, worktree: lane.worktree, status: "running" as const, openedAt: Date.now(), updatedAt: Date.now(), silent: 0 };
  ledger.tasks["L1-T1"]!.status = "merged";
  ledger.tasks["L1-T2"] = { ...base, id: "L1-T2", title: "Waited", opening: { role: "peer" }, after: ["L1-T1"] };
  ledger.tasks["L1-T3"] = { ...base, id: "L1-T3", title: "Straight" };
  ledger.lanes.L1!.tasks = 3;
  saveLedger(h.project.state, ledger);
  await h.tick(Date.now());
  const after = h.ledger().tasks;
  assert.equal(after["L1-T2"]!.status, "running");
  assert.ok(after["L1-T2"]!.peer, "a task that waited goes back to waiting and starts again");
  assert.equal(after["L1-T3"]!.status, "cut");
  await h.idle(lane.lead!);
  assert.match(h.agents.get(lane.lead!)!.sent.join("\n"), /NOT STARTED L1-T3 \(Straight\): the desk stopped while its Peer was being started, so it is cut\. Start it again if you still want it/);
  h.runtime.dispose();
});

test("a task whose Peer Paseo had started before a stop is taken on, not started twice", async () => {
  const { h, lane } = await laneWithPeer("outbox-half-seated.json");
  const ledger = h.ledger();
  ledger.tasks["L1-T1"]!.status = "merged";
  ledger.tasks["L1-T2"] = { id: "L1-T2", title: "Seated", lane: "L1", kind: "code", mode: "lane", goal: "g", acceptance: ["a"], owned: ["b.txt"], outOfScope: [], branch: lane.branch, worktree: lane.worktree, status: "running", opening: { role: "peer" }, openedAt: Date.now(), updatedAt: Date.now(), silent: 0 };
  ledger.lanes.L1!.tasks = 2;
  saveLedger(h.project.state, ledger);
  const already = h.add("sw2-peer-claude/claude-opus-5", lane.worktree!, "L1-T2 Seated", "running", "brief", { "seatworks.project": h.project.slug, "seatworks.lane": "L1", "seatworks.task": "L1-T2", "seatworks.role": "peer" });
  const seats = h.agents.size;
  await h.tick(Date.now());
  assert.equal(h.ledger().tasks["L1-T2"]!.peer, already);
  assert.equal(h.agents.size, seats, "no second Peer");
  h.runtime.dispose();
});

test("a round while a task's Peer is being started leaves it to start, rather than taking it for one a stop left", async () => {
  const { h, lane } = await laneWithPeer("outbox-task-race.json");
  h.agents.get(h.ledger().tasks["L1-T1"]!.peer!)!.status = "idle";
  // The round runs while Paseo is still creating the Peer: the task is recorded running and has no Peer yet.
  const workspaces = (h.paseo as unknown as { workspaces: { ref(id: string): { agents: { create(options: unknown): Promise<unknown> } } } }).workspaces;
  const ref = workspaces.ref.bind(workspaces);
  workspaces.ref = (id) => {
    const found = ref(id);
    const create = found.agents.create.bind(found.agents);
    found.agents.create = async (options) => {
      await h.tick(Date.now());
      return create(options);
    };
    return found;
  };
  const started = await h.call(lane.lead!, "lead", "start_task", { title: "Beside", goal: "g", acceptance: ["a"], owned: ["c.txt"], outOfScope: ["the rest"], parallel: true });
  assert.equal(started.ok, true, started.text);
  const task = h.ledger().tasks["L1-T2"]!;
  assert.deepEqual([task.status, Boolean(task.peer)], ["running", true]);
  h.runtime.dispose();
});
