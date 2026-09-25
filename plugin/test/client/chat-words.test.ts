import assert from "node:assert/strict";
import { test } from "node:test";
import { plainLetter, plainStep, teamTool } from "../../shared/chat-words.ts";
import { letters } from "../../server/desk/letters.ts";

test("a desk letter reads as one plain line in the chat, with its project and the original kept", () => {
  const ask = "[Delivery dee8e889]\n[Project prj_4c44]\nASK A1 (blocked) from the Lead of L1 (Add greet(name) with node test)\nPeer on task L1-T1 cannot run git commit.\nTheir default: let the Lead commit.\n\nReply with answer, ask A1.";
  const letter = plainLetter(ask)!;
  assert.equal(letter.project, "prj_4c44");
  assert.deepEqual(letter.lines, ['A teammate asks: "Peer on task L1-T1 cannot run git commit."']);
  assert.equal(letter.raw, ask);
  assert.equal(plainLetter("[Delivery x]\n[Project p]\nREPORT L1 (Add greet(name) with node test): ready to land\nGate: npm test passed")!.lines[0], 'Work is ready for your approval: "Add greet(name) with node test".');
  assert.match(plainLetter("[Delivery x]\n[Project p]\nINCIDENT I1 (destructive, page) on the Lead of L1 (x), agent 75fe.\nWhat was seen: rm -f a.lock")!.lines[0]!, /^The watcher flagged something to check: "rm -f a.lock"$/);
  assert.equal(plainLetter("[Delivery x]\nThe Human selected supervision revision 29. Read status for current project IDs.")!.lines[0], "Your project list or permissions changed.");
});

test("letters the desk writes today all have a plain line, and batches keep one line each", () => {
  const lane = { id: "L1", title: "Add greet", branch: "lane/l1", base: "main", lead: "lead-1", after: ["L0"] } as never;
  const task = { id: "L1-T1", title: "Write greet", lane: "L1" } as never;
  const ask = { id: "A1", kind: "question", text: "Which file?", from: "peer", answer: "src/greet.mjs" } as never;
  const texts = [letters.handback(task, "/tmp/h.md", "done", "peer-1"), letters.askTo(ask, "the Peer"), letters.answered(ask), letters.message("the Supervisor", "Carry on."),
    letters.mergeFailed(task, "dirty tree", ""), letters.conflict(task, ["a.js"], "lane/l1"), letters.rework("Fix it"), letters.cut("Not needed"), letters.nudge("done"),
    letters.failed("the Peer", "Model not found"), letters.laneIdle(lane, 20, ""), letters.report(lane, "ok", false, undefined), letters.canLand(lane), letters.leadGone(lane),
    letters.takeover(lane, "lead-0"), letters.halfOpen(lane), letters.waited(lane, "it opens once L0 lands"), letters.reminder(ask, 10), letters.escalated(ask, 10, "L1"),
    letters.planHeld(lane, 1, "it has 3 tasks.", true), letters.planHeld(lane, 1, "it has 3 tasks.", false), letters.planApproved(lane, 1, ""), letters.planSentBack(lane, 1, "Split T2", ["L1-T2"]),
    letters.landHeld(lane, "it touches package.json."), letters.landSentBack(lane, "Add a test"), ...(["landed", "blocked", "again", "changed", "sent back"] as const).map((how) => letters.landDecided(lane, how, "text")),
    letters.checkDigest("land", "ready", ["It held 3 of 10."]), letters.notStarted(task), letters.critique(lane, [{ kind: "missing", human: "add greet", lane: "", why: "No test.", question: "Test it?" }]),
    letters.critiqueBrief("L1", ["Add greet"], undefined, "lane text")];
  for (const text of texts) assert.ok(plainLetter(`[Delivery 1]\n[Project p]\n${text}`), `no plain line for: ${text.split("\n")[0]}`);
  const batch = letters.mailbox([`[Delivery 1]\n${letters.canLand(lane)}`, letters.failed("the Peer", "Model not found")], [ask]);
  assert.deepEqual(plainLetter(batch)!.lines, ['Work can be merged now: "Add greet".', 'An agent stopped with an error: "Model not found"', "1 question is still waiting for an answer."]);
});

test("what the Human typed stays as typed, and the UI's own requests read as the Human's words", () => {
  assert.equal(plainLetter("hello"), null);
  assert.equal(plainLetter("TASK list: what is left?"), null);
  const objective = plainLetter("Human objective for project prj_1 (/Users/me/app):\nAdd a greet function.\n\nInspect current activity. Reuse a suitable existing Lead.")!;
  assert.deepEqual([objective.mine, objective.project, objective.lines], [true, "prj_1", ["Add a greet function."]]);
  assert.deepEqual(plainLetter("The Human approved landing these lanes. Close each with land: true now, one at a time:\n- L1 in project p (b → main)\n- L2 in project q (c → main)\nIf the tests fail…")!.lines, ["You approved merging 2 pieces of work."]);
});

test("the team's own tools read as plain steps; other tools are left alone", () => {
  assert.equal(teamTool("mcp__team__status"), "status");
  assert.equal(teamTool("team.open_lane"), "open_lane");
  assert.equal(teamTool("mcp__team__nope"), null);
  assert.equal(teamTool("Bash"), null);
  assert.equal(plainStep("mcp__team__status", "completed", { project: "p" })!.label, "Checked on the team");
  assert.equal(plainStep("mcp__team__close_lane", "running", { land: true })!.label, "Merging finished work");
  assert.equal(plainStep("mcp__team__answer", "failed", {})!.label, "Answering a teammate: didn't go through");
  assert.equal(plainStep("mcp__team__plan_tasks", "completed", {})!.label, "Laid out the plan");
  assert.equal(plainStep("Shell", "completed", {}), null);
});
