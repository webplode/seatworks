import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness } from "./harness.ts";

type Harness = ReturnType<typeof harness>;

const scope = { acceptance: ["a"], outOfScope: ["the rest"] };

const underWay = (h: Harness, copy: string) =>
  existsSync(join(h.git(copy, "rev-parse", "--absolute-git-dir").trim(), "MERGE_HEAD"));

test("a base that conflicts with a lane leaves nothing in its copy, its Lead has the facts and the Supervisor chooses who takes the base in, and the lane lands once a task has", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const land = (lane: string) => h.call(sup, "supervisor", "land_lane", { lane });
  await h.call(sup, "supervisor", "set_project", { gate: "true" });
  await h.call(sup, "supervisor", "open_lane", {
    title: "Cart",
    outcome: "x",
    ...scope,
    writeSet: ["a.txt"],
    isolate: true,
  });
  await h.call(sup, "supervisor", "open_lane", { title: "Bees", outcome: "x", ...scope, writeSet: ["b.txt"] });
  const [cart, bees] = [h.ledger().lanes.L1!, h.ledger().lanes.L2!];
  for (const [lane, file, text] of [
    [cart, "a.txt", "one\nlane side\nthree\n"],
    [bees, "b.txt", "lane side\n"],
  ] as const) {
    h.commit(lane.worktree!, file, text);
    await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
    h.agents.get(lane.lead!)!.status = "idle";
  }
  h.commitTo("main", "a.txt", "one\nmain side\nthree\n");
  h.commitTo("main", "b.txt", "main side\n");

  const refused = await land("L1");
  assert.equal(refused.ok, false, refused.text);
  assert.match(
    refused.text,
    /^Lane L1 was not closed: main has moved on and conflicts with lane\/l1-cart in a\.txt\. Nothing was left in the lane's copy, and its Lead has the facts\. Who takes main in is yours to choose: message its Lead to have a task take it in on its own branch, or open a lane whose task does; land_lane it again once the Lead reports it ready, or drop_lane it\.$/,
  );
  assert.equal(underWay(h, cart.worktree!), false);
  assert.equal(h.git(cart.worktree!, "status", "--porcelain"), "");
  assert.equal(h.ledger().lanes.L1!.ready, undefined);
  await h.idle(cart.lead!);
  assert.doesNotMatch(h.agents.get(cart.lead!)!.sent.join("\n"), /BASE CONFLICT/, "a fact wakes nobody");
  assert.match(
    h.heard(cart.lead!).join("\n"),
    /BASE CONFLICT L1 \(Cart\): main moved on, and merging it into lane\/l1-cart stops on conflicts in a\.txt\. Nothing was left in your working copy[^]*A Peer that takes it in runs git merge --no-edit main and commits what it settles with git commit --no-edit, since an editor would wait forever in its session\.\n\nNext: Nothing now: who takes main in is chosen by the Supervisor, who tells you if it is this lane\./,
  );

  assert.match((await land("L2")).text, /conflicts with lane\/l2-bees in b\.txt/);
  assert.equal(underWay(h, h.root), false);
  assert.equal((await h.call(sup, "supervisor", "drop_lane", { lane: "L2", reason: "not wanted after all" })).ok, true);
  await h.idle(bees.lead!);
  await h.runtime.desk.settled(h.project);
  await h.tick();
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), "main");
  assert.equal(h.git(h.root, "status", "--porcelain"), "");
  assert.equal(h.git(h.root, "show", "lane/l2-bees:b.txt"), "lane side\n");

  const task = { key: "base", title: "Take main in", goal: "g", ...scope, hints: ["a.txt"] };
  await h.call(cart.lead!, "lead", "add_tasks", { tasks: [task] });
  const taking = h.ledger().tasks["L1-T1"]!;
  const copy = taking.worktree ?? cart.worktree!;
  assert.equal(
    h.git(copy, "branch", "--show-current").trim(),
    taking.branch,
    "on its own branch, where the merge is its own",
  );
  assert.notEqual(spawnSync("git", ["-C", copy, "merge", "main"]).status, 0, "the same conflict, now the task's");
  writeFileSync(join(copy, "a.txt"), "one\nboth sides\nthree\n");
  h.git(copy, "commit", "-qam", "Take main in");
  await h.call(taking.peer!, "peer", "done", { outcome: "complete", summary: "main taken in" });
  h.agents.get(taking.peer!)!.status = "idle";
  await h.call(cart.lead!, "lead", "accept", { task: "L1-T1" });
  await h.runtime.desk.settled(h.project);
  await h.call(cart.lead!, "lead", "report", { summary: "settled", ready: true });
  h.agents.get(cart.lead!)!.status = "idle";
  const landed = await land("L1");
  assert.equal(landed.ok, true, landed.text);
  assert.equal(h.git(h.root, "show", "main:a.txt"), "one\nboth sides\nthree\n");
});

test("the merge queue hands a conflict to its Peer, merges nothing as nothing, waits out a busy copy or a hold, fails a task on a crash, and is tried once more by landing", async (t) => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Two", outcome: "x", ...scope, writeSet: ["*.txt"] });
  const lane = h.ledger().lanes.L1!;
  const lead = lane.lead!;
  const copy = lane.worktree!;
  const status = (id: string) => h.ledger().tasks[id]!.status;
  /** A task beside the lane's copy, holding `file`, handed back with `text` committed there unless it is undefined. */
  const beside = async (key: string, title: string, file: string, text?: string) => {
    const tasks = [{ key, title, goal: "g", ...scope, holds: [file], parallel: true }];
    await h.call(lead, "lead", "add_tasks", { tasks });
    const task = Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
    if (text !== undefined) h.commit(task.worktree!, file, text);
    await h.call(task.peer!, "peer", "done", { outcome: "complete", summary: title });
    h.agents.get(task.peer!)!.status = "idle";
    return task;
  };
  const accept = async (task: string) => {
    await h.call(lead, "lead", "accept", { task });
    await h.runtime.desk.settled(h.project);
  };

  const first = await beside("b", "B", "b.txt", "task side\n");
  h.commit(copy, "b.txt", "lane side\n");
  await accept("L1-T1");
  assert.equal(status("L1-T1"), "done");
  assert.doesNotMatch(h.heard(first.peer!).join("\n"), /MERGE CONFLICT|REWORK/);
  assert.equal(h.git(copy, "show", "HEAD:b.txt"), "lane side\n");
  assert.ok(underWay(h, first.worktree!));
  assert.deepEqual(
    h.events("merge.conflict").map((event) => event.task),
    ["L1-T1"],
    "the record says a conflict stopped it",
  );
  await h.idle(lead);
  assert.match(
    h.agents.get(lead)!.sent.join("\n"),
    /MERGE CONFLICT L1-T1 \(B\) with lane\/l1-two\.\nFiles: b\.txt\nThe lane branch is unchanged\. The desk began merging lane\/l1-two into the task's branch in its own copy and left the conflicts there\.\n\nNext: Send rework asking its Peer to settle them and commit the merge with git commit --no-edit, since an editor would wait forever in its session/,
  );
  writeFileSync(join(first.worktree!, "b.txt"), "both sides\n");
  h.git(first.worktree!, "commit", "-qam", "Settle the lane into the task");
  await h.call(first.peer!, "peer", "done", { outcome: "complete", summary: "settled" });
  await accept("L1-T1");
  assert.equal(status("L1-T1"), "merged");
  assert.equal(h.git(copy, "show", "HEAD:b.txt"), "both sides\n");
  await h.idle(lead);
  assert.match(
    h.agents.get(lead)!.sent.at(-1) ?? "",
    /MERGED L1-T1 \(B\) into the lane branch\.[^]*Every task of the lane is settled\.\n\nNext: If its outcome is met/,
  );

  const look = await beside("l", "Look", "d.txt");
  const tip = h.git(copy, "rev-parse", lane.branch);
  await accept("L1-T2");
  assert.equal(status("L1-T2"), "merged");
  assert.equal(h.git(copy, "rev-parse", lane.branch), tip);
  await h.idle(lead);
  assert.match(
    h.agents.get(lead)!.sent.at(-1) ?? "",
    /MERGED L1-T2 \(Look\): it changed no files, so there was nothing to merge\./,
  );
  assert.equal(h.agents.get(look.peer!)!.archivedAt, null);

  const merges = (h.runtime.desk as unknown as { services: { merges: { merge: { run: () => Promise<void> } } } })
    .services.merges;
  const crashing = t.mock.method(merges.merge, "run", () => Promise.reject(new Error("the disk is full")));
  await beside("c", "Crash", "e.txt", "E\n");
  await accept("L1-T3");
  crashing.mock.restore();
  assert.equal(status("L1-T3"), "failed");
  assert.match(
    h.heard(lead).join("\n"),
    /MERGE FAILED L1-T3 \(Crash\): the merge stopped on an error: the disk is full\.\nThe lane branch is unchanged\./,
  );
  assert.deepEqual(
    h.events("merge.failed").map((event) => event.task),
    ["L1-T3"],
  );
  const crashed = h.ledger().tasks["L1-T3"]!.peer!;
  const heard = h.ledger().agents[crashed]!;
  while (Date.now() <= Math.max(heard.recordedAt ?? 0, heard.spokeAt ?? 0)) await sleep(1);
  for (const words of ["Waiting on the merge.", "Still waiting."]) {
    await h.beginTurn(crashed);
    await h.endTurn(crashed, words);
  }
  assert.equal(status("L1-T3"), "failed", "a failed merge waits on its Lead, however quiet its Peer is meanwhile");
  assert.doesNotMatch(h.heard(crashed).join("\n"), /Your turn ended without calling done/);

  const side = await beside("s", "Side", "c.txt", "C\n");
  writeFileSync(join(copy, "a.txt"), "half written\n");
  await accept("L1-T4");
  assert.equal(status("L1-T4"), "queued");
  const waits = () =>
    h
      .heard(lead)
      .join("\n")
      .match(/^MERGE WAITS L1-T4/gm)?.length;
  assert.match(
    h.heard(lead).join("\n"),
    /MERGE WAITS L1-T4 \(Side\): the lane's working copy has uncommitted changes \(M a\.txt\)\. It merges by itself once that clears, tried again as each turn ends\.\n\nNext: Have what is left there committed or cleared, or cut the task to withdraw it\./,
  );
  await h.endTurn(lead, "nothing yet");
  await h.runtime.desk.settled(h.project);
  assert.deepEqual([status("L1-T4"), waits()], ["queued", 1]);
  await h.call(sup, "supervisor", "hold_lane", { lane: "L1", reason: "a page came in" });
  h.git(copy, "checkout", "--", "a.txt");
  await h.endTurn(side.peer!, "nothing");
  await h.runtime.desk.settled(h.project);
  assert.equal(status("L1-T4"), "queued");
  await h.call(sup, "supervisor", "resume_lane", { lane: "L1" });
  await h.runtime.desk.settled(h.project);
  assert.deepEqual([status("L1-T4"), h.ledger().tasks["L1-T4"]!.mergeHeld], ["merged", undefined]);
  assert.equal(h.git(copy, "show", "HEAD:c.txt"), "C\n");

  await beside("f", "Last", "f.txt", "F\n");
  writeFileSync(join(copy, "a.txt"), "half written\n");
  await accept("L1-T5");
  assert.equal(status("L1-T5"), "queued");
  h.git(copy, "checkout", "--", "a.txt");
  const landed = await h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  assert.equal(landed.ok, true, landed.text);
  assert.equal(status("L1-T5"), "merged");
  assert.equal(h.git(h.root, "show", "main:f.txt"), "F\n");
});

test("a landing tells each lane still open on its base what now conflicts with it, and whoever landed it which lanes", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", { gate: "true" });
  const open = (title: string) =>
    h.call(sup, "supervisor", "open_lane", { title, outcome: "x", ...scope, writeSet: ["a.txt"], isolate: true });
  await open("First");
  await open("Second");
  await open("Third");
  const [first, second, third] = ["L1", "L2", "L3"].map((id) => h.ledger().lanes[id]!);
  h.commit(first!.worktree!, "a.txt", "first\n");
  h.commit(second!.worktree!, "a.txt", "second\n");
  h.commit(third!.worktree!, "c.txt", "third\n");
  await h.call(first!.lead!, "lead", "report", { summary: "done", ready: true });
  h.agents.get(first!.lead!)!.status = "idle";
  const landed = await h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  assert.equal(landed.ok, true, landed.text);
  assert.match(
    landed.text,
    /main now conflicts with lanes still open: L2 \(a\.txt\)\. Their Leads have the facts; who takes main in for each is yours to choose\./,
  );
  assert.match(
    h.heard(second!.lead!).join("\n"),
    /BASE MOVED L2 \(Second\): L1 \(First\) landed on main, which now conflicts with lane\/l2-second in a\.txt\. Nothing was merged\.\n\nNext: Nothing now: who takes main in before the lane lands is chosen by the Supervisor; ask if your lane's work needs it sooner\./,
  );
  assert.doesNotMatch(
    h.heard(third!.lead!).join("\n"),
    /BASE MOVED/,
    "a lane the landing does not touch hears nothing",
  );
  assert.equal(h.git(second!.worktree!, "status", "--porcelain"), "", "and no copy was touched");
});

test("a base that git says conflicts with a lane without naming a file is a conflict too, told as git words it", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", { gate: "true" });
  mkdirSync(join(h.root, "d"));
  writeFileSync(join(h.root, "d", "a.txt"), "a\n");
  h.commit(h.root, "d/b.txt", "b\n");
  const open = (title: string) =>
    h.call(sup, "supervisor", "open_lane", { title, outcome: "x", ...scope, writeSet: ["**"], isolate: true });
  await open("Adds");
  await open("Splits");
  const [adds, splits] = ["L1", "L2"].map((id) => h.ledger().lanes[id]!);
  h.commit(adds!.worktree!, "d/c.txt", "c\n");
  const copy = splits!.worktree!;
  mkdirSync(join(copy, "x"));
  mkdirSync(join(copy, "y"));
  h.git(copy, "mv", "d/a.txt", "x/a.txt");
  h.git(copy, "mv", "d/b.txt", "y/b.txt");
  h.git(copy, "commit", "-qm", "split d in two");
  await h.call(adds!.lead!, "lead", "report", { summary: "done", ready: true });
  h.agents.get(adds!.lead!)!.status = "idle";
  const landed = await h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  assert.equal(landed.ok, true, landed.text);
  assert.match(landed.text, /main now conflicts with lanes still open: L2 \(CONFLICT \(directory rename split\)/);
  assert.match(
    h.heard(splits!.lead!).join("\n"),
    /BASE MOVED L2 \(Splits\): L1 \(Adds\) landed on main, which now conflicts with lane\/l2-splits in CONFLICT \(directory rename split\): Unclear where to rename d to/,
  );
});
