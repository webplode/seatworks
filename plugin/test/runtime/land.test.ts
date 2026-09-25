import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { harness, laneWithPeer } from "./harness.ts";
import { settle } from "./fake-timeline.ts";

const runs = (state: string) =>
  existsSync(join(state, "checkpoints.log"))
    ? readFileSync(join(state, "checkpoints.log"), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { checkpoint: string; decision: string; findings: string[]; mode: string })
    : [];

/** A lane with a gate that passes, one commit of `files` on it and a READY from its Lead between turns, in a project set as `settings` says. */
async function laneWith(outbox: string, files: Record<string, string>, settings?: Record<string, unknown>, isolate = false) {
  const h = harness(outbox);
  if (settings) {
    mkdirSync(h.project.state, { recursive: true });
    writeFileSync(join(h.project.state, "settings.json"), JSON.stringify(settings));
  }
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", { gate: "true" });
  const opened = await h.call(sup, "supervisor", "open_lane", { title: "Cart", outcome: "a cart", acceptance: ["a"], outOfScope: ["the rest"], writeSet: ["a.txt", "src/**"], isolate });
  assert.equal(opened.ok, true, opened.text);
  const lane = h.ledger().lanes.L1!;
  const work = (more: Record<string, string>) => {
    for (const [path, text] of Object.entries(more)) {
      mkdirSync(dirname(join(lane.worktree!, path)), { recursive: true });
      writeFileSync(join(lane.worktree!, path), text);
    }
    h.git(lane.worktree!, "add", "-A");
    h.git(lane.worktree!, "commit", "-qm", "work");
  };
  work(files);
  // As a lane lands in the flow: after its Lead reports it ready.
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  h.agents.get(lane.lead!)!.status = "idle";
  const land = () => h.call(sup, "supervisor", "close_lane", { lane: "L1", land: true });
  return { h, sup, lane, work, land, onMain: (path: string) => h.git(h.root, "ls-tree", "--name-only", "-r", "main").split("\n").includes(path) };
}

const risky = { "src/auth/login.ts": "export const login = 1;\n" };

test("in shadow a lane lands as it always has, and the check keeps what it would have asked with the evidence", async () => {
  const { h, land, onMain } = await laneWith("outbox-land-shadow.json", risky);
  const landed = await land();
  assert.equal(landed.ok, true, landed.text);
  assert.ok(onMain("src/auth/login.ts"));
  assert.match(landed.text, /Land check \(shadow\): the Human would have been asked, because src\/auth\/login\.ts is a path this project counts as risky\./);
  assert.match(landed.text, /1 commit; 1 file, 1 line changed\. Gate: passed on the lane\./);
  assert.deepEqual(runs(h.project.state).map((run) => [run.checkpoint, run.mode, run.decision]), [["land", "shadow", "ask"]]);
  h.runtime.dispose();
});

test("with the check on, a lane with nothing to worry about lands at once, and a project that approves every landing holds it too", async () => {
  const quiet = await laneWith("outbox-land-quiet.json", { "a.txt": "one\ntwo\nthree\nfour\n" }, { checkpoints: { land: "on" } });
  assert.equal((await quiet.land()).ok, true);
  assert.equal(quiet.h.ledger().lanes.L1!.status, "closed");
  assert.deepEqual(runs(quiet.h.project.state).map((run) => run.decision), ["pass"]);
  quiet.h.runtime.dispose();

  const every = await laneWith("outbox-land-every.json", { "a.txt": "one\ntwo\nthree\nfour\n" }, { checkpoints: { land: "on", landApprove: "every" } });
  assert.match((await every.land()).text, /waits for the Human's approval, on its card in Seatworks, because this project approves every landing\./);
  assert.equal(every.h.ledger().lanes.L1!.status, "open");
  every.h.runtime.dispose();
});

test("with the check on, a risky lane waits for the Human: nothing lands, its Lead is told to hold still, and only the panel approves it", async () => {
  const { h, sup, lane, land, onMain } = await laneWith("outbox-land-held.json", risky, { checkpoints: { land: "on" } });
  const held = await land();
  assert.match(held.text, /Lane L1 was not landed: it waits for the Human's approval, on its card in Seatworks, because src\/auth\/login\.ts is a path this project counts as risky\.[^]*1 commit; 1 file[^]*You cannot approve it/);
  assert.equal(onMain("src/auth/login.ts"), false);
  assert.equal(h.ledger().lanes.L1!.status, "open");
  await h.idle(lane.lead!);
  const toLead = h.agents.get(lane.lead!)!.sent.join("\n");
  assert.match(toLead, /LAND HELD L1 \(Cart\): the owner looks at it before it lands, because src\/auth\/login\.ts is a path this project counts as risky\. Commit nothing more on the lane/);
  assert.doesNotMatch(toLead, /supervisor/i);
  assert.match((await land()).text, /Lane L1 still waits for the Human's approval to land, since \d+ min ago/);
  assert.match((await h.call(sup, "supervisor", "status", {})).text, /Landing waits \d+ min for the Human's approval: src\/auth\/login\.ts is a path this project counts as risky\./);
  const flow = (await h.runtime.control.flow(h.project.slug)) as { lanes: { id: string; landApproval?: unknown }[] };
  assert.deepEqual(flow.lanes.find((entry) => entry.id === "L1")!.landApproval, {
    minutes: 0,
    approved: false,
    signals: ["src/auth/login.ts is a path this project counts as risky."],
    evidence: ["1 commit; 1 file, 1 line changed.", "Gate: passed on the lane."],
  });

  const decided = (await h.runtime.control.decideLand(h.project.slug, "L1", true, "fine, it only renames")) as { decided?: string };
  assert.match(decided.decided ?? "", /Approved: Lane L1 closed and its agents archived; squashed lane\/l1-cart into one commit on main[^]*Land check \(on\): the Human approved it\./);
  assert.ok(onMain("src/auth/login.ts"));
  assert.deepEqual([h.ledger().lanes.L1!.status, h.ledger().lanes.L1!.landed, h.ledger().lanes.L1!.landApproval], ["closed", true, undefined]);
  await h.idle(sup);
  assert.match(h.agents.get(sup)!.sent.join("\n"), /LANDED L1 \(Cart\) after the Human approved it: fine, it only renames\. Lane L1 closed/);
  assert.deepEqual(runs(h.project.state).map((run) => run.decision), ["ask", "approved"]);
  h.runtime.dispose();
});

test("a landing the Human sends back leaves the lane open with their note for its Lead, and landing it again asks again", async () => {
  const { h, sup, lane, land } = await laneWith("outbox-land-back.json", risky, { checkpoints: { land: "on" } });
  await land();
  const back = (await h.runtime.control.decideLand(h.project.slug, "L1", false, "put the login change behind a flag.")) as { decided?: string };
  assert.match(back.decided ?? "", /Lane L1 is sent back to its Lead/);
  assert.deepEqual([h.ledger().lanes.L1!.status, h.ledger().lanes.L1!.landApproval], ["open", undefined]);
  await h.idle(lane.lead!);
  assert.match(h.agents.get(lane.lead!)!.sent.join("\n"), /LAND SENT BACK L1 \(Cart\): put the login change behind a flag\. The lane stays open; report it ready again/);
  await h.idle(sup);
  assert.match(h.agents.get(sup)!.sent.join("\n"), /SENT BACK L1 \(Cart\) by the Human: put the login change behind a flag/);
  assert.match((await land()).text, /waits for the Human's approval/);
  assert.deepEqual(runs(h.project.state).map((run) => run.decision), ["ask", "sent back", "ask"]);
  h.runtime.dispose();
});

test("an approval is for the lane as it was held: a commit after it means the lane is looked at again", async () => {
  const { h, land, work, onMain } = await laneWith("outbox-land-stale.json", risky, { checkpoints: { land: "on" } });
  await land();
  work({ "src/auth/session.ts": "export const session = 1;\n" });
  const late = (await h.runtime.control.decideLand(h.project.slug, "L1", true, "")) as { decided?: string };
  assert.match(late.decided ?? "", /Lane L1 changed after it was held, so this approval is not for what it holds now/);
  assert.equal(onMain("src/auth/login.ts"), false);
  assert.equal(h.ledger().lanes.L1!.landApproval, undefined);
  assert.match((await land()).text, /src\/auth\/session\.ts is a path this project counts as risky/);
  h.runtime.dispose();
});

test("an approved landing that cannot happen yet stays approved, and lands when the Supervisor closes the lane again", async () => {
  const { h, sup, land, onMain } = await laneWith("outbox-land-blocked.json", risky, { checkpoints: { land: "on" } }, true);
  await land();
  // main moves on, so landing merges it in first; that merge is the desk's own and does not undo the approval.
  writeFileSync(join(h.root, "b.txt"), "main moved\n");
  h.git(h.root, "commit", "-qam", "main moved");
  writeFileSync(join(h.root, "a.txt"), "the Human is editing\n");
  const blocked = (await h.runtime.control.decideLand(h.project.slug, "L1", true, "")) as { decided?: string };
  assert.equal(blocked.decided, "Approved. It could not land yet: the main working copy on main has uncommitted changes. The Supervisor lands it once that is cleared.");
  assert.equal(h.ledger().lanes.L1!.landApproval?.approved !== undefined, true);
  await h.idle(sup);
  const told = h.agents.get(sup)!.sent.join("\n");
  assert.match(told, /APPROVED L1 \(Cart\) for landing by the Human, but it could not land yet: the main working copy on main has uncommitted changes\. The approval stands/);
  assert.doesNotMatch(told, /land false/, "the Human approved it: dropping the lane is not the way out offered");
  assert.match((await h.call(sup, "supervisor", "status", {})).text, /Landing approved by the Human \d+ min ago; close_lane with land true lands it\./);
  h.git(h.root, "checkout", "--", "a.txt");
  const landed = await land();
  assert.equal(landed.ok, true, landed.text);
  assert.doesNotMatch(landed.text, /waits/);
  assert.ok(onMain("src/auth/login.ts"));
  assert.deepEqual(runs(h.project.state).map((run) => run.decision), ["ask", "approved"]);
  h.runtime.dispose();
});

test("a landing held over a red gate lands over it once approved, as the Supervisor asked", async () => {
  const { h, sup, onMain } = await laneWith("outbox-land-overgate.json", { "a.txt": "one\nfour\n" }, { checkpoints: { land: "on" } });
  await h.call(sup, "supervisor", "set_project", { gate: "false" });
  const held = await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: true, overGate: true });
  assert.match(held.text, /because The gate failed on the lane, and landing was asked for over it\./);
  const decided = (await h.runtime.control.decideLand(h.project.slug, "L1", true, "")) as { decided?: string };
  assert.match(decided.decided ?? "", /Approved: Lane L1 closed[^]*over a red gate/);
  assert.ok(onMain("a.txt"));
  assert.equal(h.git(h.root, "show", "main:a.txt"), "one\nfour\n");
  h.runtime.dispose();
});

test("an approval that could not land yet does not cover a commit made after it", async () => {
  const { h, land, work, onMain } = await laneWith("outbox-land-approved-stale.json", risky, { checkpoints: { land: "on" } }, true);
  await land();
  writeFileSync(join(h.root, "a.txt"), "the Human is editing\n");
  await h.runtime.control.decideLand(h.project.slug, "L1", true, "");
  h.git(h.root, "checkout", "--", "a.txt");
  work({ "a.txt": "one\nfour\n" });
  assert.match((await land()).text, /waits for the Human's approval/);
  assert.equal(onMain("src/auth/login.ts"), false);
  h.runtime.dispose();
});

test("settings the desk cannot read hold every landing for the Human rather than falling to shadow", async () => {
  const { h, land } = await laneWith("outbox-land-unread.json", { "a.txt": "one\nfour\n" });
  writeFileSync(join(h.project.state, "settings.json"), "{ not json");
  assert.match((await land()).text, /waits for the Human's approval, on its card in Seatworks, because this project approves every landing\./);
  h.runtime.dispose();
});

test("a Peer that hands back complete after its last test run failed is named to its Lead, and the lane does not land past it unasked", async () => {
  const { h, sup, lane, peer, timeline } = await laneWithPeer("outbox-land-claim.json", { attention: { watch: true }, checkpoints: { land: "on" } });
  await h.call(sup, "supervisor", "set_project", { gate: "npm test" });
  const worktree = h.ledger().tasks["L1-T1"]!.worktree!;
  timeline.beat("turn_started", "t1");
  timeline.add({ type: "user_message", text: "Clean the build" }, "t1");
  timeline.add({ type: "tool_call", callId: "w1", name: "Edit", status: "completed", detail: { type: "edit", filePath: join(worktree, "a.txt"), oldString: "one", newString: "uno" } }, "t1");
  timeline.add({ type: "tool_call", callId: "g1", name: "Bash", status: "completed", detail: { type: "shell", command: "npm test", output: "1 failing", exitCode: 1 } }, "t1");
  await settle();
  assert.equal((await h.call(peer, "peer", "done", { outcome: "complete", summary: "done", checks: "npm test passes" })).ok, true);
  timeline.beat("turn_completed", "t1");
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await h.idle(lane.lead!);
  assert.match(h.agents.get(lane.lead!)!.sent.join("\n"), /INCIDENT I\d+ \(claim-contradicted, attend\) on the Peer on L1-T1[^]*handed back as complete, but `npm test` failed the last time it ran, after the last edit/);
  const held = await h.call(sup, "supervisor", "close_lane", { lane: "L1", land: true, overGate: true });
  assert.match(held.text, /Incident I\d+ on this lane is still open: claim-contradicted\./);
  h.runtime.dispose();
});

test("once a shadow check has run enough to judge, the Supervisor is told once, and status shows it", async () => {
  const h = harness("outbox-digest.json");
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const day = 86_400_000;
  const lines = Array.from({ length: 30 }, (_, index) =>
    JSON.stringify({ at: new Date(Date.now() - (30 - index) * day / 3).toISOString(), checkpoint: "land", mode: "shadow", lane: `L${index}`, by: sup, decision: index % 10 === 0 ? "ask" : "pass", findings: index % 10 === 0 ? [`src/auth/f${index}.ts is a path this project counts as risky.`] : [] }),
  );
  mkdirSync(h.project.state, { recursive: true });
  writeFileSync(join(h.project.state, "checkpoints.log"), `${lines.join("\n")}\n`);
  await h.tick();
  // Past the outbox's own half hour of keeping a letter from being posted twice.
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 31 * 60_000 });
  try {
    await h.tick(Date.now());
  } finally {
    mock.timers.reset();
  }
  await h.idle(sup);
  const told = h.agents.get(sup)!.sent.join("\n");
  assert.equal(told.match(/CHECK DIGEST/g)?.length, 1, "once, not every round");
  assert.match(told, /CHECK DIGEST land: the check running in shadow has run enough to judge\. Turned on, it would have stopped work 3 times in 30 runs over 10 days \(0\.3 a day\)\.[^]*L20: src\/auth\/f20\.ts is a path[^]*Tell the Human in two lines/);
  assert.match((await h.call(sup, "supervisor", "status", {})).text, /- land: shadow\.[^\n]*\n  Turned on, it would have stopped work 3 times/);
  assert.doesNotMatch((await h.call(sup, "supervisor", "status", {})).text, /\.\./, "a reason that ends in a full stop is not given a second");
  h.runtime.dispose();
});

test("a READY stands until the lane is amended: status says so, and the Lead must report again", async () => {
  const { h, sup, lane } = await laneWith("outbox-land-ready.json", { "a.txt": "one\nfour\n" });
  assert.equal((await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true })).ok, true);
  assert.ok(h.ledger().lanes.L1!.ready);
  assert.match((await h.call(sup, "supervisor", "status", {})).text, /Reported ready \d+ min ago\./);
  await h.call(sup, "supervisor", "amend_lane", { lane: "L1", acceptance: ["four", "five"], why: "the Human added five" });
  assert.equal(h.ledger().lanes.L1!.ready, undefined, "what it was ready against has changed");
  assert.doesNotMatch((await h.call(sup, "supervisor", "status", {})).text, /Reported ready/);
  h.runtime.dispose();
});

test("an approval stands when all a landing still lacks is its Lead's READY, and the lane lands once the Lead reports again", async () => {
  const { h, sup, lane, land, onMain } = await laneWith("outbox-land-ready-approved.json", risky, { checkpoints: { land: "on" } });
  await land();
  // As seen live: the Supervisor amends the lane while the Human reads the held landing, which undoes the READY.
  await h.call(sup, "supervisor", "amend_lane", { lane: "L1", writeSet: ["a.txt", "src/**", ".gitignore"], why: "the lane ignores its backups" });
  const decided = (await h.runtime.control.decideLand(h.project.slug, "L1", true, "")) as { decided?: string };
  assert.match(decided.decided ?? "", /^Approved\. It could not land yet: its Lead has not reported it ready as it now stands/);
  assert.ok(h.ledger().lanes.L1!.landApproval?.approved, "the Human looked at this lane as it is; only the Lead's word is missing");
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  const landed = await land();
  assert.equal(landed.ok, true, landed.text);
  assert.ok(onMain("src/auth/login.ts"));
  assert.deepEqual(runs(h.project.state).map((run) => run.decision), ["ask", "approved"]);
  h.runtime.dispose();
});

test("a held landing is read again when it is asked about, so it waits only on what still holds it", async () => {
  const { h, sup, lane, land } = await laneWith("outbox-land-held-again.json", risky, { checkpoints: { land: "on" } });
  await h.call(sup, "supervisor", "amend_lane", { lane: "L1", acceptance: ["a", "b"], why: "the Human added b" });
  assert.match((await land()).text, /Its Lead has not reported it ready/);
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  const again = await land();
  assert.match(again.text, /Lane L1 still waits for the Human's approval to land, since \d+ min ago, because src\/auth\/login\.ts is a path this project counts as risky\./);
  assert.doesNotMatch(again.text, /not reported it ready/);
  assert.deepEqual(h.ledger().lanes.L1!.landApproval!.signals, ["src/auth/login.ts is a path this project counts as risky."]);
  h.runtime.dispose();
});

test("a landing held only for a missing READY lands once the Lead reports, with nothing left for the Human to look at", async () => {
  const { h, sup, lane, land, onMain } = await laneWith("outbox-land-held-ready-only.json", { "a.txt": "one\nfour\n" }, { checkpoints: { land: "on" } });
  await h.call(sup, "supervisor", "amend_lane", { lane: "L1", acceptance: ["a", "b"], why: "the Human added b" });
  assert.match((await land()).text, /waits for the Human's approval[^]*Its Lead has not reported it ready/);
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  const landed = await land();
  assert.equal(landed.ok, true, landed.text);
  assert.doesNotMatch(landed.text, /waits/);
  assert.equal(h.ledger().lanes.L1!.status, "closed");
  assert.ok(onMain("a.txt"));
  assert.deepEqual(runs(h.project.state).map((run) => run.decision), ["ask", "pass"]);
  h.runtime.dispose();
});
