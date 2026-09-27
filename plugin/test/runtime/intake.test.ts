import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness, laneWithPeer } from "./harness.ts";
import { laneWith } from "./landable.ts";

const lane = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  outcome: "x",
  acceptance: ["a"],
  outOfScope: ["anything else in the repository"],
  ...extra,
});

const oneTask = (key: string, title: string, extra: Record<string, unknown> = {}) => ({
  tasks: [{ key, title, goal: "g", acceptance: ["a"], outOfScope: ["the rest"], ...extra }],
});

test("a lane that waits is recorded, amended, opened off a base holding the work it waited for, or dropped", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const open = (title: string, extra: Record<string, unknown> = {}) =>
    h.call(sup, "supervisor", "open_lane", lane(title, extra));
  await h.call(sup, "supervisor", "set_project", { gate: "true" });
  await open("Cart", { outcome: "a cart", writeSet: ["a.txt"] });
  const cart = h.ledger().lanes.L1!;
  assert.match((await open("T", { after: ["L9"] })).text, /There is no lane L9 to wait for/);
  assert.match(
    (await open("T", { after: ["L1"], onBranch: true, newBranch: "x" })).text,
    /A lane that waits cannot start a branch/,
  );

  const queued = await open("Order", { outcome: "orders from the cart", writeSet: ["a.txt"], after: ["l1"] });
  assert.match(queued.text, /Lane L2 waits for L1 \(open\)/);
  const waiting = h.ledger().lanes.L2!;
  assert.deepEqual([waiting.status, waiting.lead, waiting.after], ["waiting", undefined, ["L1"]]);
  assert.equal(h.git(h.root, "branch", "--list", waiting.branch).trim(), "");
  assert.match(
    (await h.call(sup, "supervisor", "status", {})).text,
    /## Waiting lanes\n\n- L2 Order: after L1 open\n {2}Outcome: orders from the cart/,
  );
  const amended = { lane: "L2", why: "orders need an upserted cart", outcome: "orders from an upserted cart" };
  assert.match(
    (await h.call(sup, "supervisor", "amend_lane", amended)).text,
    /Lane L2 is amended; it opens as it is now/,
  );

  await open("Aside", { isolate: true });
  await open("Other", { after: ["L3"] });
  await h.call(sup, "supervisor", "drop_lane", { lane: "L3", reason: "no longer wanted" });
  await h.tick(Date.now());
  await h.tick(Date.now());
  assert.equal(h.ledger().lanes.L4!.status, "waiting");
  const told = h
    .heard(sup)
    .flatMap((text) => text.split("\n\n---\n\n"))
    .filter((text) => text.includes("WAITING L4"));
  assert.equal(told.length, 1, told.join("\n---\n"));
  assert.match(told[0]!, /Lane L3 closed without landing, so nothing of it is there to build on/);
  assert.equal(h.events("lane.held").filter((event) => event.lane === "L4").length, 1);
  assert.match(
    (await h.call(sup, "supervisor", "status", {})).text,
    /- L4 Other: after L3 closed without landing\. Not open: Lane L3 closed without landing/,
  );
  assert.match(
    (await open("T", { after: ["L3"] })).text,
    /Lane L3 closed without landing[^]*Open this lane without waiting for it/,
  );
  assert.match((await h.call(sup, "supervisor", "land_lane", { lane: "L4" })).text, /never opened/);
  assert.match(
    (await h.call(sup, "supervisor", "drop_lane", { lane: "L4", reason: "gone" })).text,
    /was waiting and is dropped/,
  );
  assert.equal(h.ledger().lanes.L4!.status, "closed");

  h.commit(h.root, "a.txt", "cart\n");
  h.agents.get(cart.lead!)!.status = "idle";
  await h.endTurn(cart.lead!, "done");
  assert.equal((await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).ok, true);
  const order = h.ledger().lanes.L2!;
  assert.deepEqual([order.status, h.ledger().lanes.L1!.landed], ["open", true]);
  assert.ok(order.lead);
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), order.branch);
  assert.equal(readFileSync(join(h.root, "a.txt"), "utf-8"), "cart\n");
  assert.match(
    h.heard(sup).join("\n"),
    /OPENED L2 \(Order\), the lane you opened to wait for L1: Lane L2 is open on lane\/l2-order/,
  );
  assert.match(h.agents.get(order.lead)!.prompt ?? "", /Outcome: orders from an upserted cart/);
  assert.match((await h.call(sup, "supervisor", "amend_lane", { ...amended, lane: "L1" })).text, /Lane L1 is closed/);
  assert.match((await open("Receipt", { after: ["L1"], isolate: true })).text, /is open on lane\//);
});

test("a waiting lane held at its turn is told why once, retried by each close and round, and opens when what held it clears", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const open = (title: string, extra: Record<string, unknown> = {}) =>
    h.call(sup, "supervisor", "open_lane", lane(title, extra));
  const now = () => h.ledger().lanes;
  const branch = () => h.git(h.root, "branch", "--show-current").trim();
  h.git(h.root, "branch", "gone-base");
  await open("First");
  const first = now().L1!;
  await open("Bees", { writeSet: ["b.txt"], isolate: true });
  await open("Own", { after: ["L1"] });
  await open("Overlap", { writeSet: ["b.txt"], after: ["L1"], isolate: true });
  await open("Unled", { after: ["L1"], isolate: true, role: "peer" });
  await open("Baseless", { after: ["L1"], isolate: true, base: "gone-base" });
  h.git(h.root, "branch", "-D", "gone-base");
  assert.equal((await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).ok, true);

  assert.match(now().L3!.held?.why ?? "", /its Lead is still ending a turn in the project's own copy/);
  assert.equal(branch(), first.branch);
  const letters = h
    .heard(sup)
    .flatMap((text) => text.split("\n\n---\n\n"))
    .filter((text) => text.includes("WAITING L3"));
  assert.equal(letters.length, 1);
  assert.match(
    letters[0]!,
    /its Lead is still ending a turn in the project's own copy[^]*\n\nNext: It opens by itself once that clears; amend_lane it, or drop_lane it\./,
  );
  assert.equal(now().L4!.status, "open");
  assert.match(
    h.heard(now().L2!.lead!).join("\n"),
    /LANE BESIDE L4 \(Overlap\) works beside your lane and may write what yours does: b\.txt\./,
  );
  assert.match(now().L5!.held?.why ?? "", /can lead a lane/);
  assert.match(now().L6!.held?.why ?? "", /its base branch gone-base no longer exists/);
  const taken = () => h.events("slot.taken").length;
  const before = taken();
  await h.tick(Date.now());
  await h.tick(Date.now());
  assert.equal(taken(), before);
  assert.deepEqual(
    ["L3", "L5", "L6"].map((id) => now()[id]!.status),
    ["waiting", "waiting", "waiting"],
  );

  h.agents.get(first.lead!)!.status = "idle";
  await h.endTurn(first.lead!, "stopping");
  await h.tick(Date.now());
  assert.deepEqual([now().L3!.status, now().L3!.slot], ["open", undefined]);
  assert.equal(branch(), now().L3!.branch);
  h.git(h.root, "branch", "gone-base", "main");
  await h.tick(Date.now());
  assert.deepEqual([now().L6!.status, now().L6!.held], ["open", undefined]);
  assert.equal(taken(), before + 1);

  await open("Mine", { after: ["L6"] });
  await open("Aside", { isolate: true });
  h.agents.get(now().L6!.lead!)!.status = "idle";
  assert.equal((await h.call(sup, "supervisor", "land_lane", { lane: "L6" })).ok, true);
  assert.match(now().L7!.held?.why ?? "", /Lane L3 is working in the project's own copy/);
  h.agents.get(now().L8!.lead!)!.status = "idle";
  await h.call(sup, "supervisor", "drop_lane", { lane: "L8", reason: "no longer wanted" });
  assert.equal(now().L7!.status, "waiting");
  assert.equal(h.events("lane.held").filter((event) => event.lane === "L7").length, 1);
  h.agents.get(now().L3!.lead!)!.status = "idle";
  await h.call(sup, "supervisor", "drop_lane", { lane: "L3", reason: "no longer wanted" });
  assert.deepEqual([now().L7!.status, now().L7!.held], ["open", undefined]);
  assert.equal(now().L5!.status, "waiting");
});

test("a lane waiting to carry on a branch carries on the branch the lane before it carries, and is held while the Human's copy is elsewhere", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const open = (title: string, extra: Record<string, unknown> = {}) =>
    h.call(sup, "supervisor", "open_lane", lane(title, extra));
  await h.call(sup, "supervisor", "set_project", { gate: "true" });
  await open("First", { onBranch: true });
  assert.match(
    (await open("Then", { after: ["L1"] })).text,
    /Lane L1 carries on main and merges nowhere, so a lane waiting for it carries on that branch too/,
  );
  assert.equal((await open("Then", { onBranch: true, after: ["L1"] })).ok, true);
  assert.deepEqual([h.ledger().lanes.L2!.status, h.ledger().lanes.L2!.branch], ["waiting", "main"]);
  h.git(h.root, "switch", "-qc", "elsewhere");
  h.agents.get(h.ledger().lanes.L1!.lead!)!.status = "idle";
  await h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  assert.equal(h.ledger().lanes.L2!.status, "waiting");
  assert.match(
    h.ledger().lanes.L2!.held?.why ?? "",
    /it carries on main, and the project's own copy is on elsewhere now/,
  );
  h.git(h.root, "switch", "-q", "main");
  await h.tick(Date.now());
  assert.equal(h.ledger().lanes.L2!.status, "open");
});

test("tasks that wait are recorded, amended, held while the lane's copy is taken, started on a branch of their own from the lane as merged, or cut with their lane", async () => {
  const { h, sup, lane: build, peer } = await laneWithPeer();
  const lead = build.lead!;
  const add = (key: string, title: string, extra: Record<string, unknown> = {}) =>
    h.call(lead, "lead", "add_tasks", oneTask(key, title, extra));
  await add("s", "Side", { holds: ["b.txt"], parallel: true });
  const queued = await add("r", "Receipt", { hints: ["c.txt"], after: ["l1-t2"] });
  assert.match(queued.text, /is L1-T3 Receipt: waits for L1-T2/);
  assert.deepEqual([h.ledger().tasks["L1-T3"]!.status, h.ledger().tasks["L1-T3"]!.peer], ["waiting", undefined]);
  assert.match((await h.call(lead, "lead", "status", {})).text, /- L1-T3 Receipt: waiting, after L1-T2/);
  assert.match((await h.call(lead, "lead", "accept", { task: "L1-T3" })).text, /L1-T3 is waiting/);
  const taxed = { task: "L1-T3", why: "the Human wants tax on it", goal: "show the total with tax" };
  assert.match((await h.call(lead, "lead", "amend_task", taxed)).text, /L1-T3 is amended; it starts as it is now/);
  await h.call(sup, "supervisor", "open_lane", lane("Other", { isolate: true }));
  await h.call(h.ledger().lanes.L2!.lead!, "lead", "add_tasks", oneTask("t", "Theirs", { hints: ["c.txt"] }));
  assert.match(
    (await add("t", "T", { hints: ["b.txt"], after: ["L2-T1"] })).text,
    /There is no task in this lane L2-T1 to wait for/,
  );

  const side = h.ledger().tasks["L1-T2"]!;
  h.commit(side.worktree!, "b.txt", "B\n");
  await h.call(side.peer!, "peer", "done", { outcome: "complete", summary: "b" });
  h.agents.get(side.peer!)!.status = "idle";
  await h.tick(Date.now());
  assert.deepEqual([h.ledger().tasks["L1-T3"]!.status, h.ledger().tasks["L1-T3"]!.startHeld], ["waiting", undefined]);
  await h.call(lead, "lead", "accept", { task: "L1-T2" });
  await h.runtime.desk.settled(h.project);
  await h.tick(Date.now());
  assert.equal(h.ledger().tasks["L1-T2"]!.status, "merged");
  assert.match(
    h.ledger().tasks["L1-T3"]!.startHeld?.why ?? "",
    /L1-T1 is still writing in the lane's working copy[^]*It starts by itself once that clears/,
  );

  h.commit(build.worktree!, "a.txt", "A\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "a" });
  h.agents.get(peer)!.status = "idle";
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T1" })).ok, true);
  await h.runtime.desk.settled(h.project);
  const started = h.ledger().tasks["L1-T3"]!;
  assert.deepEqual([started.status, started.startHeld], ["running", undefined]);
  assert.equal(h.git(build.worktree!, "branch", "--show-current").trim(), started.branch);
  assert.equal(h.agents.get(started.peer!)!.cwd, build.worktree);
  assert.equal(started.startSha, h.git(build.worktree!, "rev-parse", build.branch).trim());
  assert.deepEqual(
    ["a.txt", "b.txt"].map((file) => h.git(build.worktree!, "show", `HEAD:${file}`)),
    ["A\n", "B\n"],
  );
  assert.match(h.agents.get(started.peer!)!.prompt ?? "", /TASK L1-T3: Receipt[^]*show the total with tax/);
  await h.idle(lead);
  assert.match(
    h.agents.get(lead)!.sent.join("\n"),
    /STARTED L1-T3 \(Receipt\), the task you started to wait for L1-T2: Started L1-T3 in the lane's working copy/,
  );

  await add("p", "Probe", { holds: ["d.txt"], parallel: true });
  await add("a", "After probe", { hints: ["d.txt"], after: ["L1-T4"] });
  await h.call(lead, "lead", "cut", { task: "L1-T4", reason: "wrong approach" });
  assert.match(h.ledger().tasks["L1-T5"]!.startHeld?.why ?? "", /L1-T4 was cut, so nothing of it is there to build on/);
  await h.tick(Date.now());
  await h.idle(lead);
  const mail = h.agents.get(lead)!.sent.join("\n---\n");
  assert.equal(mail.match(/^WAITING L1-T5/gm)?.length, 1, mail);
  assert.match(
    (await add("g", "Again", { hints: ["d.txt"], after: ["L1-T4"] })).text,
    /L1-T4 was cut[^]*Take it out of after/,
  );
  // The lane works in the Human's own checkout: cutting its task undoes the task's edits, never the Human's own files.
  const own = build.worktree!;
  assert.equal(build.slot, undefined, "no copy of the desk's own");
  writeFileSync(join(own, "a.txt"), "half done\n");
  writeFileSync(join(own, "mine.txt"), "the Human's own note\n");
  assert.equal((await h.call(lead, "lead", "cut", { task: "L1-T3", reason: "not now" })).ok, true);
  assert.equal(h.git(own, "branch", "--show-current").trim(), build.branch);
  assert.equal(readFileSync(join(own, "a.txt"), "utf-8"), "A\n");
  assert.equal(readFileSync(join(own, "mine.txt"), "utf-8"), "the Human's own note\n");
  await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "no longer wanted" });
  assert.equal(h.ledger().tasks["L1-T5"]!.status, "cut");
});

test("an amendment changes what a lane is asked and keeps what it was; its Lead hears it, its READY goes, and landing without one says so", async () => {
  const { h, sup, lane: cart, land } = await laneWith({ "a.txt": "one\nfour\n" });
  const status = async () => (await h.call(sup, "supervisor", "status", {})).text;
  const amend = (extra: Record<string, unknown>) => h.call(sup, "supervisor", "amend_lane", { lane: "L1", ...extra });
  assert.match(await status(), /Reported ready \d+ min ago\./);
  h.agents.get(cart.lead!)!.status = "running";
  const amended = await amend({ why: "the Human wants an upsert too", acceptance: ["a", "upserts an item"] });
  assert.match(amended.text, /its Lead has the change; a READY it reported before no longer stands/);
  const now = h.ledger().lanes.L1!;
  assert.deepEqual(now.acceptance, ["a", "upserts an item"]);
  assert.deepEqual(
    now.amended?.map((entry) => [entry.by, entry.why, entry.was]),
    [[sup, "the Human wants an upsert too", { acceptance: ["a"] }]],
  );
  assert.equal(now.ready, undefined);
  assert.doesNotMatch(await status(), /Reported ready/);
  assert.equal(
    h.agents.get(cart.lead!)!.sent.some((text) => text.startsWith("AMENDED")),
    false,
  );
  await h.idle(cart.lead!);
  const letter = h.agents.get(cart.lead!)!.sent.find((text) => text.startsWith("AMENDED L1"))!;
  assert.match(
    letter,
    /AMENDED L1 \(Cart\): the Human wants an upsert too\n\nacceptance, was:\n- a\nacceptance, now:\n- a\n- upserts an item\n\nA READY you reported before this no longer stands\.\n\nNext: Carry it into the tasks it touches \(amend_task/,
  );

  assert.match(
    (await amend({ why: "again", acceptance: ["a", "upserts an item"] })).text,
    /Nothing about lane L1 would change/,
  );
  assert.match((await amend({ why: "x", acceptance: [] })).text, /at least one acceptance line/);
  await h.call(sup, "supervisor", "open_lane", lane("Bees", { writeSet: ["b.txt"], isolate: true }));
  assert.match(
    (await amend({ why: "x", writeSet: ["a.txt", "src/**", "b.txt"] })).text,
    /It now works beside lanes that may write what it does: L2 \(b\.txt\)\. Their Leads and its own are told/,
  );
  assert.match(
    h.heard(h.ledger().lanes.L2!.lead!).join("\n"),
    /LANE BESIDE L1 \(Cart\) works beside your lane and may write what yours does: b\.txt\./,
  );
  assert.match(
    h.heard(cart.lead!).join("\n"),
    /LANE BESIDE L2 \(Bees\) works beside your lane and may write what yours does: b\.txt\./,
  );
  const landed = await land();
  assert.equal(landed.ok, true, landed.text);
  assert.match(
    landed.text,
    /Evidence: Its Lead has not reported it ready as it now stands: never, or the lane was amended since\. 1 commit/,
  );
  assert.match(h.git(h.root, "show", "main:a.txt"), /four/);
});

test("a Lead amends a task: its Peer hears at its next turn, and only a task beside others holds paths", async () => {
  const { h, lane: build, peer } = await laneWithPeer();
  const amend = (extra: Record<string, unknown>) =>
    h.call(build.lead!, "lead", "amend_task", { task: "L1-T1", why: "the lane now wants an upsert", ...extra });
  assert.match(
    (await amend({ goal: "upsert into the cart" })).text,
    /L1-T1 is amended; its Peer has it at its next turn/,
  );
  const task = h.ledger().tasks["L1-T1"]!;
  assert.deepEqual([task.goal, task.amended?.[0]?.was], ["upsert into the cart", { goal: "g" }]);
  await h.idle(peer);
  const letter = h.agents.get(peer)!.sent.find((text) => text.startsWith("AMENDED L1-T1"))!;
  assert.match(letter, /goal, was:\ng\ngoal, now:\nupsert into the cart\n\nNext: Work to it as it stands now/);
  assert.doesNotMatch(letter, /seat|supervisor|paseo/i);

  assert.equal((await amend({ hints: ["a.txt", "b.txt"], context: "The header parser is in b.txt." })).ok, true);
  await h.idle(peer);
  assert.match(
    h.agents.get(peer)!.sent.join("\n"),
    /context, was:\nnone\ncontext, now:\nThe header parser is in b\.txt\./,
  );
  assert.deepEqual(h.ledger().tasks["L1-T1"]!.amended?.[1]?.was, { context: "", hints: ["a.txt"] });
  const hinted =
    /L1-T1 runs in the lane's copy, which has one writer at a time, so it holds nothing: it keeps c\.txt as a hint of where to start\./;
  assert.match((await amend({ holds: ["c.txt"] })).text, hinted);
  assert.deepEqual(
    [h.ledger().tasks["L1-T1"]!.hints, h.ledger().tasks["L1-T1"]!.holds],
    [["a.txt", "b.txt", "c.txt"], []],
  );
  await h.call(build.lead!, "lead", "add_tasks", oneTask("s", "Side", { holds: ["c.txt"], parallel: true }));
  assert.match((await amend({ task: "L1-T2", holds: [] })).text, /keeps at least one held path/);
  assert.deepEqual(h.ledger().tasks["L1-T2"]!.holds, ["c.txt"]);
  const listed = await h.call(build.lead!, "lead", "add_tasks", oneTask("n", "Next", { holds: ["b.txt"] }));
  assert.match(
    listed.text,
    /N runs in the lane's copy, which has one writer at a time, so it holds nothing: it keeps b\.txt as a hint/,
  );
  assert.deepEqual([h.ledger().tasks["L1-T3"]!.hints, h.ledger().tasks["L1-T3"]!.holds], [["b.txt"], []]);
  const emptied = await amend({ task: "L1-T3", acceptance: [] });
  assert.equal(emptied.ok, true, "what a task must say is its Lead's call");
  assert.deepEqual(h.ledger().tasks["L1-T3"]!.acceptance, []);
  await h.call(build.lead!, "lead", "cut", { task: "L1-T1", reason: "done with it" });
  assert.match((await amend({ goal: "y" })).text, /L1-T1 is cut; start a task for what is asked now/);
});
