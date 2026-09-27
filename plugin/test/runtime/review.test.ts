import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness } from "./harness.ts";
import { heldGit } from "./lane-gates.ts";

type Harness = ReturnType<typeof harness>;

const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
const finding = { severity: "P1", where: "a.txt:1", failure: "rounds half down", fix: "round half up" };
const reviews = (h: Harness) => Object.values(h.ledger().tasks).filter((entry) => entry.kind === "review");

/** A lane opened by a supervising seat, with its Lead. */
async function opened(title: string, more: Record<string, unknown> = {}) {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title, outcome: "money rounds correctly", ...scope, ...more });
  const lane = h.ledger().lanes.L1!;
  return { h, sup, lane, lead: lane.lead! };
}

test("a review hands back a verdict and its findings, answers what the project's risk rules ask, and the Lead is told all of it", async (t) => {
  const { h, sup, lane, lead } = await opened("Rounding");
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title: "Round", goal: "g", ...scope, hints: ["a.txt"] }],
  });
  h.commit(lane.worktree!, "a.txt", "rounded\n");
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "rounded" });
  await h.idle(peer);

  const wrongLens = await h.call(lead, "lead", "start_review", { focus: "Is the rounding right?", role: "peer" });
  assert.equal(wrongLens.ok, false, "a role that writes does not stand in for one that reads");
  assert.match(wrongLens.text, /no peer that can review/i);
  assert.match(wrongLens.text, /reviewer/, "the refusal names what there is to choose from");

  const started = await h.call(lead, "lead", "start_review", {
    task: "L1-T1",
    focus: "Is half-up right for money here?",
  });
  assert.equal(started.ok, true, started.text);
  const reviewer = h.ledger().tasks["L1-R1"]!.peer!;
  const unnamed = await h.call(reviewer, "reviewer", "done", { verdict: "changes", answer: "Half-up is wrong here." });
  assert.equal(unnamed.ok, true, `a verdict is evidence its Lead weighs, findings or none: ${unnamed.text}`);
  const handed = await h.call(reviewer, "reviewer", "done", {
    verdict: "accept",
    answer: "Half-up is right for money here.",
    findings: [
      {
        severity: "P3",
        where: "a.txt:1",
        failure: "banker's rounding would be safer at the boundary",
        fix: "none needed: half-up matches the spec",
      },
      { severity: "P2", failure: "the brief assumes totals in cents", fix: "confirm the unit with the Lead" },
    ],
    read: ["the diff"],
    ran: ["npm test -- rounding"],
  });
  assert.equal(handed.ok, true, handed.text);
  const verdict = h.ledger().tasks["L1-R1"]!.handback;
  assert.deepEqual([verdict?.outcome, verdict?.summary], ["accept", "Half-up is right for money here."]);
  assert.match(
    h.heard(lead).join("\n"),
    /Verdict: accept\n\nHalf-up is right for money here\.\n\nFindings:\n- P3 a\.txt:1: banker's rounding would be safer at the boundary Fix: none needed: half-up matches the spec\n- P2 the brief assumes totals in cents Fix: confirm the unit with the Lead\n\nRead: the diff\nRan: npm test -- rounding/,
    "the review itself reaches the Lead rather than being dropped",
  );

  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T1" })).ok, true);
  await h.runtime.desk.settled(h.project);
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "m", title: "Move", goal: "g", ...scope, hints: ["db/migrations"] }],
  });
  mkdirSync(join(lane.worktree!, "db", "migrations"), { recursive: true });
  h.commit(lane.worktree!, "db/migrations/001.sql", "update invoices set total = total * 100;\n");
  await h.call(h.ledger().tasks["L1-T2"]!.peer!, "peer", "done", { outcome: "complete", summary: "moved" });
  await h.call(lead, "lead", "start_review", { task: "L1-T2", focus: "Is the move safe?" });
  const risky = reviews(h).at(-1)!;
  assert.match(
    h.agents.get(risky.peer!)!.prompt ?? "",
    /The project asks every review of a change like this, answered in order in answers:\n1\. What does running this a second time do to data it already changed, and how is the data from before got back if it goes wrong\?/,
  );
  const bare = await h.call(risky.peer!, "reviewer", "done", { verdict: "accept", answer: "Safe." });
  assert.match(
    bare.text,
    /The project's risk rules ask this review a question; give answers, one per question, in this order:\n1\. What does running this a second time/,
  );
  const answered = await h.call(risky.peer!, "reviewer", "done", {
    verdict: "changes",
    answer: "Not safe twice.",
    answers: ["A second run multiplies totals by 100 again; there is no backup."],
    findings: [
      { severity: "P0", where: "db/migrations/001.sql:1", failure: "totals grow on every run", fix: "a version table" },
    ],
  });
  assert.equal(answered.ok, true, answered.text);
  assert.match(
    h.heard(lead).join("\n"),
    /Asked by the project's risk rules:\n1\. What does running this a second time[^\n]*\n {3}A second run multiplies totals by 100 again; there is no backup\./,
  );

  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T2" })).ok, true);
  await h.runtime.desk.settled(h.project);
  const ofLane = async () => {
    await h.call(lead, "lead", "start_review", { focus: "And the lane?" });
    return reviews(h).at(-1)!.asked;
  };
  assert.match(String(await ofLane()), /What does running this a second time/, "the lane's change reaches the rule");
  const rules = (riskRules: unknown[]) => h.call(sup, "supervisor", "set_project", { riskRules });
  assert.match(
    (await rules([{ paths: ["db"], invariant: "", reviewQuestion: "q" }])).text,
    /invariant must not be empty in each of riskRules/,
  );
  assert.match((await rules([])).text, /0 risk rules of its own/);
  assert.equal(await ofLane(), undefined, "a project's own list, even an empty one, replaces the kit's");

  // A lane put on hold while its review is being set up gets none: it is read again where the review is written.
  const count = reviews(h).length;
  const gate = heldGit("rev-parse");
  t.after(gate.release);
  const asking = h.call(lead, "lead", "start_review", { focus: "Anything left?" });
  await gate.reached;
  assert.equal(
    (await h.call(sup, "supervisor", "hold_lane", { lane: lane.id, reason: "wait for the Human" })).ok,
    true,
  );
  gate.release();
  const held = await asking;
  assert.equal(held.ok, false, held.text);
  assert.match(held.text, /on hold/);
  assert.equal(reviews(h).length, count, "and nothing recorded or seated for it");
});

test("the lane's last task merging wakes its Lead, a review that came back being no work left, and says what the lane still needs", async () => {
  const { h, lane, lead } = await opened("Rounding");
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title: "Round", goal: "g", ...scope, hints: ["round.js"] }],
  });
  h.commit(lane.worktree!, "round.js", "export const round = Math.round;\n");
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "rounded" });
  await h.idle(peer);
  await h.call(lead, "lead", "start_review", { task: "L1-T1", focus: "Is the rounding right?" });
  const reviewer = reviews(h).at(-1)!.peer!;
  assert.equal((await h.call(reviewer, "reviewer", "done", { verdict: "accept", answer: "Right." })).ok, true);
  await h.idle(lead);
  // It accepts mid-turn, and the merge's word waits for that turn to end.
  h.agents.get(lead)!.status = "running";
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T1" })).ok, true);
  await h.runtime.desk.settled(h.project);
  const merged = h.runtime.outbox.pending(lead).find((letter) => letter.text.startsWith("MERGED L1-T1"));
  assert.ok(merged);
  assert.notEqual(merged.wakes, false, "it asks something of the Lead, so its turn ending sends it");
  assert.match(
    merged.text,
    /Every task of the lane is settled\.\n\nNext: If its outcome is met, have the whole lane reviewed if it needs it \(start_review with scope lane\), then report it ready\./,
  );
  assert.doesNotMatch(merged.text, /hand-back arrives/, "no hand-back is coming");
});

test("a merge while another task of the lane is still open asks nothing of the Lead, and says nothing of what the lane still needs", async () => {
  const { h, lane, lead } = await opened("Rounding");
  await h.call(lead, "lead", "add_tasks", {
    tasks: [
      { key: "t", title: "Round", goal: "g", ...scope, hints: ["round.js"] },
      { key: "u", title: "Floor", goal: "g", ...scope, hints: ["floor.js"] },
    ],
  });
  h.commit(lane.worktree!, "round.js", "export const round = Math.round;\n");
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "rounded" });
  await h.idle(peer);
  h.agents.get(lead)!.status = "running";
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T1" })).ok, true);
  await h.runtime.desk.settled(h.project);
  assert.notEqual(h.ledger().tasks["L1-T2"]!.status, "merged");
  const merged = h.runtime.outbox.pending(lead).find((letter) => letter.text.startsWith("MERGED L1-T1"));
  assert.ok(merged);
  assert.equal(merged.wakes, false, "L1-T2 is still open, so this merge is not the lane's last");
  assert.doesNotMatch(merged.text, /Every task of the lane is settled/);
});

test("the lane's last task merging where its base now conflicts asks the Lead to take the base in before the whole-lane review", async () => {
  const { h, lane, lead } = await opened("Rounding");
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title: "Round", goal: "g", ...scope, hints: ["a.txt"] }],
  });
  h.commit(lane.worktree!, "a.txt", "rounded on the lane\n");
  h.commitTo("main", "a.txt", "rounded on main\n");
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "rounded" });
  await h.idle(peer);
  h.agents.get(lead)!.status = "running";
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T1" })).ok, true);
  await h.runtime.desk.settled(h.project);
  const merged = h.runtime.outbox.pending(lead).find((letter) => letter.text.startsWith("MERGED L1-T1"));
  assert.ok(merged);
  assert.match(
    merged.text,
    /Every task of the lane is settled\.\nmain conflicts with it in a\.txt, so it does not land as it is: [^]*\n\nNext: Have a task take main in first; then have the whole lane reviewed if it needs it/,
  );
});

test("the review of the whole lane is marked so, and reads the lane's change from its base against the lane's acceptance", async () => {
  const { h, lane, lead } = await opened("Rounding");
  h.commit(lane.worktree!, "round.js", "export const round = Math.round;\n");
  const both = await h.call(lead, "lead", "start_review", { task: "L1-T9", scope: "lane", focus: "Does it hold?" });
  assert.equal(both.ok, false, "a task's review is not the lane's");
  const started = await h.call(lead, "lead", "start_review", { scope: "lane", focus: "Does the lane hold?" });
  assert.equal(started.ok, true, started.text);
  const review = h.ledger().tasks["L1-R1"]!;
  assert.deepEqual([review.scope, review.acceptance], ["lane", ["a"]]);
  const tip = h.git(h.root, "rev-parse", lane.branch).trim();
  assert.match(
    h.agents.get(review.peer!)!.prompt!,
    new RegExp(
      `^REVIEW L1-R1 of lane L1: Rounding\\n\\nYour working copy holds ${lane.branch} at ${tip.slice(0, 7)}; see its change with git diff main\\.\\.\\.${tip}\\.\\n\\nAcceptance it must meet:\\n- a\\n`,
    ),
  );
  await h.call(lead, "lead", "start_review", { focus: "What would break the rounding?" });
  assert.equal(
    h.ledger().tasks["L1-R2"]!.scope,
    undefined,
    "a scout's or a council seat's question is not the lane's review",
  );
});

test("a lane reported ready carries what its reviews leave standing, and each fact goes once the record settles it", async () => {
  const { h, sup, lane, lead } = await opened("Rounding");
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title: "Round", goal: "g", ...scope, hints: ["a.txt"] }],
  });
  h.commit(lane.worktree!, "a.txt", "rounded\n");
  await h.call(h.ledger().tasks["L1-T1"]!.peer!, "peer", "done", { outcome: "complete", summary: "rounded" });
  await h.idle(h.ledger().tasks["L1-T1"]!.peer!);
  const start = async (task?: string) => {
    const which = task ? { task } : { scope: "lane" };
    await h.call(lead, "lead", "start_review", { ...which, focus: "Is the rounding right?" });
    return reviews(h).at(-1)!.peer!;
  };
  const handBack = async (reviewer: string, verdict: string) => {
    const findings = verdict === "accept" ? {} : { findings: [finding] };
    const handed = await h.call(reviewer, "reviewer", "done", { verdict, answer: "Read the diff.", ...findings });
    assert.equal(handed.ok, true, handed.text);
    await new Promise((resolve) => setTimeout(resolve, 2));
  };
  const ready = async (summary: string) => (await h.call(lead, "lead", "report", { summary, ready: true })).text;
  const told = () => {
    const heard = h.heard(sup).join("\n");
    return /\nNext: (.*)/.exec(heard.slice(heard.lastIndexOf("REPORT L1")))![1]!;
  };

  await handBack(await start("L1-T1"), "changes");
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T1" })).ok, true);
  assert.match(
    await ready("first"),
    /^What the record has of the lane's reviews went with it: No review of the whole lane is on record\. The lane's latest review, L1-R1, ended in changes; L1-T1 was accepted after it, with no review since\. L1-T1 was accepted over L1-R1, a review of it that ended in changes\./,
  );
  assert.match(
    h.heard(sup).join("\n"),
    /REPORT L1 \(Rounding\): ready to land[^]*What the desk read of it:\n[^]*- No review of the whole lane is on record\.\n- The lane's latest review, L1-R1/,
  );
  assert.match(
    told(),
    /^Its reviews asked for changes that nothing on record answers/,
    "accepted on the very hand-back its review asked changes to",
  );

  // Latest by when it came back, not by when it was asked for.
  const [asked, second] = [await start(), await start()];
  const withdrawn = h.runtime.outbox.pending(sup).find((letter) => letter.text.startsWith("READY WITHDRAWN L1"));
  assert.equal(withdrawn?.wakes, false, "a READY taken back asks nothing of whoever supervises");
  assert.match(
    await ready("while they read"),
    /^What the record has of the lane's reviews went with it: L1-R2 and L1-R3 are still reading: their verdicts come to you after this report\./,
  );
  await handBack(second, "accept");
  await handBack(asked, "changes");
  const again = await ready("second");
  assert.doesNotMatch(again, /No review of the whole lane/);
  assert.match(
    again,
    /The lane's latest review, L1-R2, ended in changes, and nothing was accepted after it\. L1-T1 was accepted over L1-R1/,
  );
  assert.match(told(), /^Its reviews asked for changes that nothing on record answers/);

  await handBack(await start(), "accept");
  const third = await ready("third");
  assert.doesNotMatch(third, /latest review/);
  assert.match(
    third,
    /^What the record has of the lane's reviews went with it: L1-T1 was accepted over L1-R1, a review of it that ended in changes\. Reported to agent-1\. Stay quiet/,
    "the Lead's own acceptance stands on the record, for whoever lands it to weigh",
  );
  assert.match(told(), /^land_lane it if acceptance is met/, "a review of the whole lane accepted it since");
});

test("only the lane's own review counts as the review of the whole lane, and only one that read it after its last merge", async () => {
  const { h, lane, lead } = await opened("Rounding");
  const merge = async (key: string, file: string) => {
    await h.call(lead, "lead", "add_tasks", { tasks: [{ key, title: key, goal: "g", ...scope, hints: [file] }] });
    const task = Object.values(h.ledger().tasks).find((entry) => entry.title === key)!;
    h.commit(lane.worktree!, file, `${key}\n`);
    await h.call(task.peer!, "peer", "done", { outcome: "complete", summary: key });
    await h.idle(task.peer!);
    await h.call(lead, "lead", "accept", { task: task.id });
    await h.runtime.desk.settled(h.project);
    return task.id;
  };
  const review = async (which: Record<string, unknown>) => {
    await h.call(lead, "lead", "start_review", { ...which, focus: "Does it hold?" });
    await h.call(reviews(h).at(-1)!.peer!, "reviewer", "done", { verdict: "accept", answer: "It holds." });
    await new Promise((resolve) => setTimeout(resolve, 2));
  };
  const ready = async () => (await h.call(lead, "lead", "report", { summary: "done", ready: true })).text;

  await merge("one", "one.js");
  await review({});
  assert.match(
    await ready(),
    /No review of the whole lane is on record\./,
    "a scout's question is not the lane's review",
  );
  await review({ scope: "lane" });
  assert.doesNotMatch(await ready(), /No review of the whole lane/);
  const last = await merge("two", "two.js");
  assert.match(
    await ready(),
    new RegExp(`No review of the whole lane after its last merge, ${last}\\.`),
    "a review of the lane before its last merge read a lane it no longer is",
  );
});

test("a review's changes stand until a hand-back after them or a review accepting the task answers them, and only then does the report stop asking", async () => {
  const { h, sup, lane, lead } = await opened("Rounding");
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
  const handBack = async (task: string, file: string, text: string) => {
    h.commit(lane.worktree!, file, `${text}\n`);
    await h.call(h.ledger().tasks[task]!.peer!, "peer", "done", { outcome: "complete", summary: text });
    await h.idle(h.ledger().tasks[task]!.peer!);
    await tick();
  };
  const review = async (task: string, verdict: string) => {
    await h.call(lead, "lead", "start_review", { task, focus: "Is the rounding right?" });
    const reviewer = reviews(h).at(-1)!.peer!;
    const findings = verdict === "accept" ? {} : { findings: [finding] };
    assert.equal(
      (await h.call(reviewer, "reviewer", "done", { verdict, answer: "Read the diff.", ...findings })).ok,
      true,
    );
    await tick();
  };
  const accept = async (task: string) => {
    assert.equal((await h.call(lead, "lead", "accept", { task })).ok, true);
    await tick();
  };
  const ready = async () => {
    const reply = (await h.call(lead, "lead", "report", { summary: "done", ready: true })).text;
    const heard = h.heard(sup).join("\n");
    return { reply, next: /\nNext: (.*)/.exec(heard.slice(heard.lastIndexOf("REPORT L1")))![1]! };
  };
  const add = (key: string, hint: string) =>
    h.call(lead, "lead", "add_tasks", { tasks: [{ key, title: "Round", goal: "g", ...scope, hints: [hint] }] });

  await add("t", "a.txt");
  await handBack("L1-T1", "a.txt", "rounded");
  await review("L1-T1", "changes");
  await h.call(lead, "lead", "rework", { task: "L1-T1", text: "Round half up, as L1-R1 asks." });
  await handBack("L1-T1", "a.txt", "rounds half up now");
  await accept("L1-T1");
  const reworked = await ready();
  assert.match(
    reworked.reply,
    /L1-T1 was handed back again after L1-R1, a review of it that ended in changes, and accepted with no review since\./,
  );
  assert.doesNotMatch(reworked.reply, /accepted over L1-R1/);
  assert.match(
    reworked.next,
    /^land_lane it if acceptance is met/,
    "the rework answered the review, though no review read it",
  );

  await add("u", "b.txt");
  await handBack("L1-T2", "b.txt", "rounded totals");
  await review("L1-T2", "changes");
  await accept("L1-T2");
  const over = await ready();
  assert.equal(
    h.heard(sup).join("\n").split("REPORT L1 ").length - 1,
    2,
    "the same summary again still reaches the Supervisor once what the desk read of the lane changed",
  );
  assert.match(
    over.next,
    /^Its reviews asked for changes that nothing on record answers/,
    "accepted on the very hand-back its review asked changes to",
  );
  await review("L1-T1", "accept");
  assert.match(
    (await ready()).next,
    /^Its reviews asked for changes that nothing on record answers/,
    "a review of another task accepting answers nothing of L1-T2's",
  );
  await review("L1-T2", "accept");
  assert.match((await ready()).next, /^land_lane it if acceptance is met/, "its own review accepted it since");
});

test("a review reads the commit it covers in a copy of its own, where it may write, which goes with the review", async () => {
  const { h, sup, lane, lead } = await opened("Reviewed", { writeSet: ["a.txt", "b.txt"] });
  const beside = async (title: string, file: string) => {
    await h.call(lead, "lead", "add_tasks", {
      tasks: [{ key: "t", title, goal: "g", ...scope, holds: [file], parallel: true }],
    });
    return Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
  };
  const head = (where: string) => h.git(where, "rev-parse", "HEAD").trim();
  const task = await beside("A", "a.txt");
  h.commit(task.worktree!, "a.txt", "A\n");
  await h.call(task.peer!, "peer", "done", { outcome: "complete", summary: "a" });
  assert.equal((await h.call(lead, "lead", "rework", { task: "L1-T1", text: "Say more." })).ok, true);
  const committed = head(task.worktree!);
  assert.equal((await h.call(lead, "lead", "start_review", { task: "L1-T1", focus: "Is this right?" })).ok, true);
  const first = reviews(h).at(-1)!;
  assert.notEqual(first.slot, task.slot, "not in the copy its Peer works in");
  assert.equal(h.agents.get(first.peer!)!.cwd, first.worktree, "seated in its own copy");
  assert.equal(
    head(first.worktree!),
    committed,
    "at the commit it reviews: sent back, as far as its Peer has committed",
  );
  assert.match(
    h.agents.get(first.peer!)!.prompt ?? "",
    new RegExp(
      `Your working copy holds ${task.branch} at ${committed.slice(0, 7)}; see it with git diff ${lane.branch}\\.\\.\\.${committed}\\.`,
    ),
  );
  h.commit(task.worktree!, "a.txt", "A\nmore\n");
  assert.equal(head(first.worktree!), committed, "what its Peer commits after does not move under it");
  writeFileSync(join(first.worktree!, "coverage.out"), "what a check it ran left behind\n");
  assert.equal((await h.call(lead, "lead", "cut", { task: first.id, reason: "read" })).ok, true);
  assert.equal(existsSync(first.worktree!), false, "cut, its copy goes, with whatever it wrote there");
  assert.equal(h.ledger().slots[first.slot!], undefined);
  assert.ok(existsSync(task.worktree!), "and the task's own copy stays");

  await h.call(task.peer!, "peer", "done", { outcome: "complete", summary: "a, and more" });
  await h.idle(task.peer!);
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T1" })).ok, true);
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "merged");
  assert.equal((await h.call(lead, "lead", "start_review", { task: "L1-T1", focus: "At the boundary?" })).ok, true);
  const late = reviews(h).at(-1)!;
  const merge = h.ledger().tasks["L1-T1"]!.mergeSha!;
  const brief = h.agents.get(late.peer!)!.prompt!;
  assert.match(brief, new RegExp(`Your working copy holds ${lane.branch} at the merge ${merge.slice(0, 7)}`));
  assert.match(brief, new RegExp(`git diff ${merge}\\^1\\.\\.${merge}`), "a range that shows nothing reviews nothing");
  assert.equal(head(late.worktree!), merge);

  assert.equal((await h.call(lead, "lead", "start_review", { focus: "Does the lane hold together?" })).ok, true);
  const whole = reviews(h).at(-1)!;
  const tip = h.git(h.root, "rev-parse", lane.branch).trim();
  assert.equal(head(whole.worktree!), tip);
  assert.match(
    h.agents.get(whole.peer!)!.prompt!,
    new RegExp(`Your working copy holds ${lane.branch} at ${tip.slice(0, 7)}\\.`),
  );
  // A task cut before it committed leaves neither a copy nor a branch, and there is nothing to read.
  const empty = await beside("B", "b.txt");
  const cut = await h.call(lead, "lead", "cut", { task: empty.id, reason: "wrong shape" });
  assert.equal(cut.ok, true, cut.text);
  assert.equal(h.git(h.root, "branch", "--list", empty.branch!).trim(), "", "no commits of its own, no branch");
  const nothing = await h.call(lead, "lead", "start_review", { task: empty.id, focus: "anything?" });
  assert.equal(nothing.ok, false);
  assert.match(nothing.text, /neither a merge nor a branch is left to read it from/);

  assert.equal((await h.call(sup, "supervisor", "drop_lane", { lane: lane.id, reason: "read enough" })).ok, true);
  assert.ok(existsSync(whole.worktree!), "not under a reviewer still in its turn");
  for (const review of [late, whole]) {
    h.agents.get(review.peer!)!.status = "idle";
    await h.endTurn(review.peer!, "verdict sent");
  }
  assert.deepEqual(
    [late, whole].map((review) => existsSync(review.worktree!)),
    [false, false],
    "a closing lane takes its reviews' copies with it",
  );
});

test("a verdict names the commit it read, and accepting or landing says how far the work has moved past it", async () => {
  const { h, sup, lane, lead } = await opened("Rounding");
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title: "Round", goal: "g", ...scope, hints: ["a.txt"] }],
  });
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  h.commit(lane.worktree!, "a.txt", "rounded\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "rounded" });
  const read = h.git(lane.worktree!, "rev-parse", "HEAD").trim();
  await h.call(lead, "lead", "start_review", { task: "L1-T1", focus: "Is the rounding right?" });
  await h.call(reviews(h).at(-1)!.peer!, "reviewer", "done", { verdict: "accept", answer: "Right." });
  assert.match(h.heard(lead).join("\n"), new RegExp(`\\nCommit reviewed: ${read.slice(0, 7)}\\n`));

  await h.call(lead, "lead", "rework", { task: "L1-T1", text: "Round the tax too." });
  h.commit(lane.worktree!, "a.txt", "rounded, tax too\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "and tax" });
  await h.idle(peer);
  assert.match(
    (await h.call(lead, "lead", "accept", { task: "L1-T1" })).text,
    new RegExp(`Its latest review, L1-R1, read it at ${read.slice(0, 7)}; its branch has 1 commit since\\.`),
  );
  await h.runtime.desk.settled(h.project);

  await h.call(lead, "lead", "start_review", { scope: "lane", focus: "Does the lane hold together?" });
  const tip = h.git(h.root, "rev-parse", lane.branch).trim();
  await h.call(reviews(h).at(-1)!.peer!, "reviewer", "done", { verdict: "accept", answer: "It does." });
  h.commit(lane.worktree!, "b.txt", "after the review\n");
  await h.call(lead, "lead", "report", { summary: "ready", ready: true });
  assert.match(
    h.heard(sup).join("\n"),
    new RegExp(
      `\\n- The lane's latest review of the whole lane, L1-R2, read ${lane.branch} at ${tip.slice(0, 7)}; 1 commit came after it\\.\\n`,
    ),
    "whoever lands it reads how far the lane moved past the verdict",
  );
});

test("a review of work an earlier review sent back marks each earlier finding, and the Report counts how many were resolved", async () => {
  const { h, lane, lead } = await opened("Rounding");
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title: "Round", goal: "g", ...scope, hints: ["a.txt"] }],
  });
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  h.commit(lane.worktree!, "a.txt", "rounded\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "rounded" });
  await h.call(lead, "lead", "start_review", { task: "L1-T1", focus: "Is the rounding right?" });
  const second = { severity: "P2", failure: "totals in cents are assumed", fix: "say the unit" };
  await h.call(reviews(h).at(-1)!.peer!, "reviewer", "done", {
    verdict: "changes",
    answer: "Two problems.",
    findings: [finding, second],
  });
  await h.call(lead, "lead", "rework", { task: "L1-T1", text: "Round half up, and say the unit." });
  h.commit(lane.worktree!, "a.txt", "rounded half up\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "half up" });

  await h.call(lead, "lead", "start_review", { task: "L1-T1", focus: "Is it right now?" });
  const again = reviews(h).at(-1)!;
  assert.match(
    h.agents.get(again.peer!)!.prompt!,
    /L1-R1, an earlier review of this work, found these; say in earlier, in this order, whether each is resolved, still open, or wrong:\n1\. P1 a\.txt:1: rounds half down\n2\. P2 totals in cents are assumed\n/,
  );
  const marked = await h.call(again.peer!, "reviewer", "done", {
    verdict: "accept",
    answer: "Right now.",
    earlier: ["resolved", "wrong"],
  });
  assert.equal(marked.ok, true, marked.text);
  assert.match(
    h.heard(lead).join("\n"),
    /Earlier findings, of L1-R1:\n1\. P1 a\.txt:1: rounds half down: resolved\n2\. P2 totals in cents are assumed: wrong\n/,
  );
  const report = await h.report();
  assert.ok("numbers" in report);
  assert.deepEqual(
    report.numbers.find((row) => row.title === "Findings re-checked"),
    { title: "Findings re-checked", value: "1 of 2 resolved", detail: "Reviewer: 1 resolved, 0 still open, 1 wrong" },
  );
});

test("a Lead seats the reading Peer its question needs: an Architect for a hard design decision, an Auditor for the lane's proof", async () => {
  const { h, lead } = await opened("Brakes");
  for (const role of ["architect", "auditor"]) {
    const started = await h.call(lead, "lead", "start_review", { focus: "Parachute or rim brakes?", role });
    assert.equal(started.ok, true, started.text);
    const seat = reviews(h).at(-1)!.peer!;
    assert.match(h.agents.get(seat)!.provider, new RegExp(`^sw3-${role}-`));
  }
});
