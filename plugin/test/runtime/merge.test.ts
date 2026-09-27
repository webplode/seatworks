import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../tempdir.ts";
import { harness, laneWithPeer } from "./harness.ts";

type Harness = ReturnType<typeof harness>;

const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
const beside = (key: string, title: string, holds: string[]) => ({
  tasks: [{ key, title, goal: "g", ...scope, holds, parallel: true }],
});
const heard = (h: Harness, id: string) => h.heard(id).join("\n");
const named = (h: Harness, title: string) => Object.values(h.ledger().tasks).find((task) => task.title === title)!;

/** A task beside others added under `lead`, with `text` committed to `file` in its copy and handed back. */
async function handedBack(h: Harness, lead: string, title: string, holds: string, file = holds, text = `${title}\n`) {
  await h.call(lead, "lead", "add_tasks", beside(title.slice(0, 1), title, [holds]));
  const task = named(h, title);
  h.commit(task.worktree!, file, text);
  const done = await h.call(task.peer!, "peer", "done", { outcome: "complete", summary: title });
  assert.equal(done.ok, true, done.text);
  await h.idle(task.peer!);
  return task;
}

/** Whether `check` comes true within `ms`, looked at every 20 ms. */
async function within(ms: number, check: () => boolean): Promise<boolean> {
  for (const end = Date.now() + ms; !check(); await new Promise((resolve) => setTimeout(resolve, 20)))
    if (Date.now() > end) return false;
  return true;
}

test("a task beside others hands back what its lane would become: the lane brought in, its own changes, and a conflict left to its Peer", async () => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  await h.call(sup, "supervisor", "set_project", { gate: "test -f shared.txt", gateOn: "task" });
  for (const [title, holds] of [
    ["Side", "c.txt"],
    ["Quotes", "d.txt"],
    ["Else", "e.txt"],
  ] as const)
    await h.call(lead, "lead", "add_tasks", beside(title.slice(0, 1), title, [holds]));
  const [side, quotes, other] = ["L1-T2", "L1-T3", "L1-T4"].map((id) => h.ledger().tasks[id]!);
  h.commitTo(lane.branch, "shared.txt", "from the lane\n");
  h.commit(side!.worktree!, "c.txt", "prices\n");
  assert.equal((await h.call(side!.peer!, "peer", "done", { outcome: "complete", summary: "c" })).ok, true);
  const handback = heard(h, lead).split("HANDBACK L1-T2")[1] ?? "";
  assert.match(heard(h, lead), /HANDBACK L1-T2 \(Side\) from the Peer on L1-T2\n/, "who its Lead reads, by its work");
  assert.match(handback, new RegExp(`\\nBrought up to date with ${lane.branch} at [0-9a-f]{7}\\.\\n`));
  assert.match(handback, /\nChanged: c\.txt\n/, "only what the task changed, not what came in with the lane");
  assert.match(
    handback,
    /\nAcceptance:\n- a\nChecks: not given\n/,
    "each acceptance line beside the proof offered for it",
  );
  assert.doesNotMatch(handback, /Note:/, "shared.txt moved on the lane, not in this task's copy");
  assert.match(handback, /Gate: test -f shared\.txt passed/, "the gate ran on what the lane would become");
  h.git(side!.worktree!, "merge-base", "--is-ancestor", lane.branch, "HEAD");
  assert.equal(h.ledger().tasks["L1-T2"]!.handback!.gate!.sha, h.git(side!.worktree!, "rev-parse", "HEAD").trim());

  // Side merges, then Else: the lane's side of c.txt is Side's, though Else merged last.
  await h.idle(side!.peer!);
  await h.call(lead, "lead", "accept", { task: "L1-T2" });
  await h.runtime.desk.settled(h.project);
  h.commit(other!.worktree!, "e.txt", "else\n");
  await h.call(other!.peer!, "peer", "done", { outcome: "complete", summary: "e" });
  await h.call(lead, "lead", "accept", { task: "L1-T4" });
  await h.runtime.desk.settled(h.project);
  assert.deepEqual(
    ["L1-T2", "L1-T4"].map((id) => h.ledger().tasks[id]!.status),
    ["merged", "merged"],
  );

  h.commit(quotes!.worktree!, "c.txt", "quotes\n");
  const refused = await h.call(quotes!.peer!, "peer", "done", { outcome: "complete", summary: "d, and c" });
  assert.equal(
    refused.text,
    `Not handed back yet: ${lane.branch} has moved on since your branch left it, and bringing it in conflicts in c.txt, changed there by L1-T2. The merge is left in your copy: settle it so both changes stand, commit it with git commit --no-edit (an editor would wait forever here), then call done again.`,
  );
  assert.equal(h.ledger().tasks["L1-T3"]!.status, "running", "nothing is handed back");
  assert.match(
    heard(h, lead),
    new RegExp(
      `SETTLING L1-T3 \\(Quotes\\): bringing ${lane.branch} into its branch conflicts in c\\.txt, changed there by L1-T2\\. Its Peer settles it in its own copy before it hands back\\.`,
    ),
  );
  writeFileSync(join(quotes!.worktree!, "c.txt"), "prices and quotes\n");
  h.git(quotes!.worktree!, "add", "c.txt");
  h.git(quotes!.worktree!, "commit", "-q", "--no-edit");
  assert.equal((await h.call(quotes!.peer!, "peer", "done", { outcome: "complete", summary: "settled" })).ok, true);
  assert.equal(h.ledger().tasks["L1-T3"]!.status, "done");

  h.commitTo(lane.branch, "c.txt", "lane\n");
  assert.equal((await h.call(lead, "lead", "rework", { task: "L1-T3", text: "Shorter, please." })).ok, true);
  assert.throws(
    () => h.git(quotes!.worktree!, "rev-parse", "-q", "--verify", "MERGE_HEAD"),
    "sent back before its merge, it is left as its Peer had it",
  );

  await h.call(lead, "lead", "add_tasks", beside("l", "Loose", ["f.txt"]));
  const loose = named(h, "Loose");
  h.commitTo(lane.branch, "g.txt", "moved again\n");
  writeFileSync(join(loose.worktree!, "f.txt"), "not committed\n");
  assert.equal((await h.call(loose.peer!, "peer", "done", { outcome: "partial", summary: "f" })).ok, true);
  assert.match(
    heard(h, lead),
    new RegExp(`\\nNot brought up to date with ${lane.branch}: its copy has work uncommitted\\.\\n`),
    "it hands back as it stands, and says so",
  );
});

test("a task in the lane's copy is read from where its branch meets the lane's, not with what a task beside it merged into the lane meanwhile", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  await h.call(sup, "supervisor", "set_project", {
    riskRules: [{ paths: ["c.txt"], invariant: "c stays c", reviewQuestion: "Does c stay c?" }],
  });
  h.commit(lane.worktree!, "a.txt", "A\n");
  const side = await handedBack(h, lead, "Side", "c.txt", "c.txt", "C\nC\nC\n");
  assert.equal((await h.call(lead, "lead", "accept", { task: side.id })).ok, true);
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks[side.id]!.status, "merged", "merged into the lane's copy, where L1-T1 still works");
  h.commit(lane.worktree!, "a.txt", "A2\n");

  assert.equal((await h.call(peer, "peer", "done", { outcome: "complete", summary: "a" })).ok, true);
  assert.match(
    heard(h, lead).split("HANDBACK L1-T1")[1] ?? "",
    /\nChanged: a\.txt\n/,
    "c.txt came in with L1-T2's merge, not from this Peer",
  );
  assert.equal((await h.call(lead, "lead", "start_review", { task: "L1-T1", focus: "Is a right?" })).ok, true);
  assert.equal(h.ledger().tasks["L1-R1"]!.asked, undefined, "the rule on c.txt asks L1-T2's reviews, not this one's");
  const commit = h.ledger().tasks["L1-T1"]!.handback!.commit!;
  assert.match(
    h.agents.get(h.ledger().tasks["L1-R1"]!.peer!)!.prompt ?? "",
    new RegExp(`see it with git diff ${lane.branch}\\.\\.\\.${commit}\\.`),
    "read from where its branch meets the lane's, L1-T2's lines are not this task's",
  );

  await h.idle(peer);
  assert.match((await h.call(lead, "lead", "accept", { task: "L1-T1" })).text, /^L1-T1 is in the merge queue/);
  await h.runtime.desk.settled(h.project);
  const merged = heard(h, lead).split("MERGED L1-T1")[1] ?? "";
  assert.match(merged, /Lines changed: source 0, tests 0, docs 4\./, "a.txt's three lines out and one in");
  assert.doesNotMatch(merged, /Note: (in what|outside)/);
});

test("a merge that cannot take its lane safely waits, says why, and goes round again", async (t) => {
  const signals = tempDir("sw3-merge-waits-");
  const [armed, go] = [join(signals, "armed"), join(signals, "go")];
  t.after(() => writeFileSync(go, ""));
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Beside only", outcome: "c", ...scope });
  const lane = h.ledger().lanes.L1!;
  const lead = lane.lead!;
  /** A gate that runs `then` once, the first time it runs after the test arms it. */
  const gate = (then: string) =>
    h.call(sup, "supervisor", "set_project", {
      gate: `if [ -f ${armed} ]; then rm ${armed}; ${then}; fi`,
      gateOn: "task",
    });
  const merge = async (id: string) => {
    writeFileSync(armed, "");
    await h.call(lead, "lead", "accept", { task: id });
    await h.runtime.desk.settled(h.project);
    return h.ledger().tasks[id]!;
  };
  const again = async (id: string) => {
    await h.runtime.desk.resumeMerges(h.project);
    await h.runtime.desk.settled(h.project);
    return h.ledger().tasks[id]!.status;
  };

  await gate(`printf 'half\\n' >> ${join(lane.worktree!, "a.txt")}`);
  const side = await handedBack(h, lead, "Side", "c.txt");
  // No task holds the lane's copy, so the lane branch is checked out there and moves with it.
  h.commit(lane.worktree!, "shared.txt", "moved\n");
  const dirty = await merge(side.id);
  assert.equal(dirty.status, "queued");
  assert.match(dirty.mergeHeld?.why ?? "", /^the lane's working copy has uncommitted changes/);
  h.git(lane.worktree!, "checkout", "--", "a.txt");
  assert.equal(await again(side.id), "merged");

  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "w", title: "Writer", goal: "g", ...scope, hints: ["a.txt"] }],
  });
  const move = `git update-ref refs/heads/${lane.branch} $(git -c user.name=t -c user.email=t@x commit-tree ${lane.branch}^{tree} -p ${lane.branch} -m race)`;
  await gate(`cd ${lane.worktree} && ${move}`);
  const second = await handedBack(h, lead, "Two", "d.txt", "d.txt", "side\n");
  // The lane moves, so the merge gates again, and the gate's run sees the lane branch move under it.
  h.commitTo(lane.branch, "shared.txt", "moved again\n");
  const raced = await merge(second.id);
  assert.equal(raced.status, "queued");
  assert.equal(
    raced.mergeHeld?.why,
    `${lane.branch} moved while it was gated, so it goes round again with that brought in`,
  );
  assert.equal(h.git(h.root, "log", "-1", "--format=%s", lane.branch).trim(), "race", "the lane took nothing of it");
  assert.equal(await again(second.id), "merged");
  assert.equal(h.git(h.root, "show", `${lane.branch}:d.txt`), "side\n");

  await gate(`until [ -f ${go} ]; do sleep 0.05; done`);
  const prices = await handedBack(h, lead, "Prices", "p.txt", "p.txt", "prices\n");
  const quotes = await handedBack(h, lead, "Quotes", "q.txt", "p.txt", "quotes\n");
  // The lane moves, so Prices' merge gates again and is held there while Quotes' copy is left with work in it.
  h.commitTo(lane.branch, "shared.txt", "moved a third time\n");
  writeFileSync(armed, "");
  await h.call(lead, "lead", "accept", { task: prices.id });
  assert.equal((await h.call(lead, "lead", "accept", { task: quotes.id })).ok, true);
  writeFileSync(join(quotes.worktree!, "scratch.txt"), "left behind\n");
  writeFileSync(go, "");
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks[quotes.id]!.status, "queued");
  assert.match(
    h.ledger().tasks[quotes.id]!.mergeHeld?.why ?? "",
    new RegExp(`^its own copy cannot take ${lane.branch} in: its copy has work uncommitted$`),
  );
  rmSync(join(quotes.worktree!, "scratch.txt"));
  assert.equal(await again(quotes.id), "done");
  assert.match(
    heard(h, lead),
    new RegExp(
      `MERGE CONFLICT ${quotes.id} \\(Quotes\\) with ${lane.branch}\\.\\nFiles: p\\.txt, changed there by ${prices.id}\\n`,
    ),
  );
});

/** Two lanes, each with a task beside others handed back green; the first lane has moved, and its merge's gate waits on `go`. */
async function heldLanes(t: { after(fn: () => void): void }) {
  const signals = tempDir("sw3-queues-");
  const [armed, go] = [join(signals, "armed"), join(signals, "go")];
  // Let go of the held gate whatever the test found, or it would wait out the gate's timeout.
  t.after(() => writeFileSync(go, ""));
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", {
    gate: `if [ -f ${armed} ]; then while [ ! -f ${go} ]; do sleep 0.05; done; fi`,
    gateOn: "task",
  });
  for (const title of ["One", "Two"])
    await h.call(sup, "supervisor", "open_lane", { title, outcome: title, ...scope, isolate: true });
  const lanes = ["L1", "L2"].map((id) => h.ledger().lanes[id]!);
  for (const [index, lane] of lanes.entries()) await handedBack(h, lane.lead!, `Side ${index}`, `s${index}.txt`);
  h.commit(lanes[0]!.worktree!, "moved.txt", "moved\n");
  writeFileSync(armed, "");
  await h.call(lanes[0]!.lead!, "lead", "accept", { task: "L1-T1" });
  assert.ok(await within(5000, () => h.ledger().tasks["L1-T1"]!.status === "merging"));
  return { h, lanes, go, armed };
}

test("each lane merges in its own queue, and a merge under way is neither cut nor released nor taken for one a stop cut off", async (t) => {
  const { h, lanes, go, armed } = await heldLanes(t);
  const [one, two] = lanes.map((lane) => lane.lead!);
  const cut = await h.call(one!, "lead", "cut", { task: "L1-T1", reason: "changed my mind" });
  assert.equal(cut.ok, false);
  assert.match(cut.text, /^L1-T1 is being merged/, "a cut would not stop its work landing");
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "merging");
  assert.equal(
    (await h.call(one!, "lead", "release", { task: "L1-T1" })).text,
    "L1-T1 is in the merge queue: release its Peer once MERGED arrives.",
  );

  writeFileSync(join(lanes[1]!.worktree!, "a.txt"), "being written\n");
  await h.call(two!, "lead", "accept", { task: "L2-T1" });
  assert.ok(
    await within(5000, () => h.ledger().tasks["L2-T1"]!.mergeHeld !== undefined),
    "the second lane's merge ran while the first lane's gate ran, and waits for its own copy",
  );
  h.git(lanes[1]!.worktree!, "checkout", "--", "a.txt");
  void h.runtime.desk.resumeMerges(h.project);
  assert.ok(await within(5000, () => h.ledger().tasks["L2-T1"]!.status === "merged"));
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "merging", "the first lane's merge is still its own, running");
  rmSync(armed);
  const report = h.call(two!, "lead", "report", { summary: "Two is done.", ready: true });
  const reported = await Promise.race([report, new Promise((resolve) => setTimeout(resolve, 5000, undefined))]);
  assert.ok(reported, "the second lane reports ready without waiting on the first lane's gate");
  assert.equal(h.ledger().lanes.L2!.ready !== undefined, true);
  writeFileSync(go, "");
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "merged");
});
