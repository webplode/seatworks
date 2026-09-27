import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../server/desk/project/project.ts";
import type { DeskServices } from "../../server/desk/services.ts";
import { contracts } from "../../shared/rpc.ts";
import { harness, ideCalls } from "./harness.ts";

const scope = { acceptance: ["a"], outOfScope: ["anything else in the repository"] };
const work = (title: string, hint: string) => ({
  tasks: [{ key: "t", title, goal: "g", acceptance: ["a"], hints: [hint], outOfScope: ["the rest of the repository"] }],
});

test("a lane works in the project's own copy from open to landing, and hands it back on its base", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const root = h.project.root;
  const branch = () => h.git(root, "branch", "--show-current").trim();
  await h.call(sup, "supervisor", "set_project", { gate: "test ! -f BROKEN", gateOn: "lane" });
  const numbers = { title: "Numbers", outcome: "a.txt gains words", acceptance: ["four"] };
  const opened = await h.call(sup, "supervisor", "open_lane", numbers);
  assert.equal(opened.ok, true, `limits the outcome does not hold are the Supervisor's to give or not: ${opened.text}`);
  const lane = h.ledger().lanes.L1!;
  const lead = lane.lead!;
  assert.deepEqual(Object.keys(h.ledger().slots), []);
  assert.equal(h.agents.get(lead)!.cwd, root);
  assert.equal(branch(), lane.branch);
  assert.deepEqual(
    ideCalls.filter((call) => call.path === root),
    [
      { kind: "open", path: root },
      { kind: "sync", path: root },
    ],
  );
  assert.match(readFileSync(join(root, ".git", "info", "exclude"), "utf-8"), /^\.idea\/$/m);
  assert.equal(h.git(root, "status", "--porcelain"), "");

  const unbounded = await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title: "Add four", goal: "g", acceptance: ["a"], hints: ["a.txt"] }],
  });
  assert.equal(unbounded.ok, true, `limits the goal does not hold are the Lead's to give or not: ${unbounded.text}`);
  const first = h.ledger().tasks["L1-T1"]!;
  assert.deepEqual(first.outOfScope, []);
  assert.equal(h.agents.get(first.peer!)!.cwd, root);
  assert.match(first.branch!, /^task\/l1-t1-/);
  assert.equal(branch(), first.branch);
  const blocked = await h.call(lead, "lead", "add_tasks", work("More", "a.txt"));
  assert.match(
    blocked.text,
    /L1-T2 More: held: L1-T1 is still writing in the lane's working copy, and it holds one writer at a time/,
  );
  assert.equal(h.ledger().tasks["L1-T2"]!.peer, undefined);
  assert.equal((await h.call(lead, "lead", "cut", { task: "L1-T2", reason: "not now" })).ok, true);

  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
  assert.equal((await h.call(first.peer!, "peer", "done", { outcome: "complete", summary: "four" })).ok, true);
  h.agents.get(first.peer!)!.status = "idle";
  const dirty = await h.call(lead, "lead", "accept", { task: "L1-T1" });
  assert.equal(dirty.ok, false);
  assert.match(dirty.text, /uncommitted/);
  h.git(root, "commit", "-qam", "add four");
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T1" })).ok, true);
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "merged");
  assert.equal(h.agents.get(first.peer!)!.archivedAt, null);

  await h.call(lead, "lead", "add_tasks", work("Break it", "BROKEN"));
  const broken = h.ledger().tasks["L1-T3"]!;
  h.commit(root, "BROKEN", "x\n");
  assert.equal((await h.call(lead, "lead", "cut", { task: "L1-T3", reason: "wrong" })).ok, true);
  assert.equal(existsSync(join(root, "BROKEN")), false);
  assert.ok(h.agents.get(broken.peer!)!.archivedAt);
  await h.call(lead, "lead", "add_tasks", work("Late break", "BROKEN"));
  const late = h.ledger().tasks["L1-T4"]!;
  h.commit(root, "BROKEN", "late\n");
  await h.call(late.peer!, "peer", "done", { outcome: "complete", summary: "late" });
  h.agents.get(late.peer!)!.status = "idle";
  await h.call(lead, "lead", "accept", { task: "L1-T4" });
  assert.equal((await h.call(lead, "lead", "report", { summary: "the lane is done", ready: true })).ok, true);
  h.git(root, "rm", "-q", "BROKEN");
  h.git(root, "commit", "-qm", "unbreak");
  assert.equal((await h.call(lead, "lead", "report", { summary: "done, and green this time", ready: true })).ok, true);
  await h.idle(sup);
  const reports = h.agents.get(sup)!.sent.join("\n");
  assert.match(reports, /Gate: .*failed with exit/);
  assert.match(reports, /Gate: .*passed on the lane branch/);

  const closed = await h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  assert.equal(closed.ok, true, closed.text);
  assert.equal(h.git(root, "show", "main:a.txt"), "one\ntwo\nthree\nfour\n");
  assert.equal(branch(), lane.branch);
  assert.match(
    closed.text,
    new RegExp(`The project's own copy goes back to main once ${lead} finish the turn they are in\\.`),
  );
  assert.match(closed.text, new RegExp(`Its Peers are archived, and its Lead ${lead} stays until you release it\\.`));
  assert.ok(h.agents.get(first.peer!)!.archivedAt);
  h.agents.get(lead)!.status = "idle";
  await h.endTurn(lead, "closing up");
  assert.equal(branch(), "main");
  assert.equal(h.git(root, "branch", "--list", lane.branch).trim(), "");
  assert.equal(h.agents.get(lead)!.archivedAt, null);
  assert.equal(
    h.git(root, "log", "-1", "--format=%B", "main").trim(),
    ["Numbers (L1)", "", lane.outcome, "", "- L1-T1 Add four", "- L1-T4 Late break"].join("\n"),
  );

  const next = { title: "Next", outcome: "b.txt changes", acceptance: ["z"], outOfScope: scope.outOfScope };
  assert.equal((await h.call(sup, "supervisor", "open_lane", next)).ok, true);
  assert.equal(h.ledger().lanes.L2!.slot, undefined);
  assert.equal(h.workspaces.size, 1);
  assert.deepEqual(
    ideCalls.filter((call) => call.path === root).map((call) => call.kind),
    ["open", "sync", "open", "sync"],
  );
  assert.equal(branch(), h.ledger().lanes.L2!.branch);
  assert.match(
    (await h.call(sup, "supervisor", "release", { lane: "L1" })).text,
    new RegExp(`^Lane L1's Lead ${lead} is released\\.$`),
  );
  assert.equal(
    ideCalls.some((call) => call.kind === "close" && call.path === root),
    false,
  );
});

test("a lane whose base moved lands only once nobody writes in its copy: the desk lands it itself when their turn ends, main brought in there as one commit, and a project may land by merge", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const land = (lane: string) => h.call(sup, "supervisor", "land_lane", { lane });
  const numbers = { title: "Numbers", outcome: "a.txt gains words", ...scope };
  await h.call(sup, "supervisor", "open_lane", numbers);
  const lane = h.ledger().lanes.L1!;
  h.commit(h.root, "a.txt", "one\ntwo\nthree\nfour\n");
  h.commitTo("main", "other.txt", "main moved\n");
  const moved = h.git(h.root, "rev-parse", "main").trim();
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  await h.idle(sup);
  assert.match(h.heard(sup).join("\n"), /REPORT L1 \(Numbers\)[^]*- 1 commit; 1 file, 1 line changed\./);

  const head = h.git(h.root, "rev-parse", "HEAD");
  const ordered = await land("L1");
  assert.equal(ordered.ok, true, `a turn in the way is no failure to call again over: ${ordered.text}`);
  assert.match(ordered.text, new RegExp(`^Lane L1 lands once ${lane.lead!}'s turn ends:`));
  assert.equal(h.git(h.root, "rev-parse", "HEAD"), head);
  assert.doesNotMatch(h.git(h.root, "show", "main:a.txt"), /four/);
  assert.equal(h.ledger().lanes.L1!.status, "open");
  // A project's own hooks, as husky or commitlint install them, judge its people's commits, not the desk's merges.
  const hooks = join(h.git(h.root, "rev-parse", "--absolute-git-dir").trim(), "hooks");
  for (const hook of ["pre-merge-commit", "commit-msg"])
    writeFileSync(join(hooks, hook), "#!/bin/sh\necho refused by the project >&2\nexit 1\n", { mode: 0o755 });
  await h.idle(sup);
  h.agents.get(lane.lead!)!.status = "idle";
  await h.endTurn(lane.lead!, "reported");
  await h.runtime.desk.settled(h.project);
  for (const hook of ["pre-merge-commit", "commit-msg"]) rmSync(join(hooks, hook));
  assert.equal(h.ledger().lanes.L1!.status, "closed");
  assert.match(
    h.agents.get(sup)!.sent.join("\n"),
    /LANDED L1 \(Numbers\): Lane L1 closed; [^]*Gate: none set, so nothing ran the lane's checks\./,
    "whoever ordered it hears at once, since it acts on what landed",
  );
  assert.match(h.git(h.root, "show", "main:a.txt"), /four/);
  assert.equal(h.git(h.root, "rev-parse", "main^").trim(), moved);
  assert.equal(
    h.git(h.root, "log", "-1", "--format=%s", "refs/seatworks/lanes/L1").trim(),
    `Bring main into ${lane.branch}`,
  );
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), "main");
  assert.equal(h.git(h.root, "branch", "--list", lane.branch).trim(), "");

  assert.match((await h.call(sup, "supervisor", "set_project", { landAs: "merge" })).text, /land as merge/);
  assert.match((await h.call(sup, "supervisor", "status", {})).text, /Lanes land as merge\./);
  await h.call(sup, "supervisor", "open_lane", { ...numbers, title: "More" });
  const more = h.ledger().lanes.L2!;
  const before = h.git(h.root, "rev-parse", "main").trim();
  h.commit(h.root, "a.txt", "one\nfour\n");
  const tip = h.git(h.root, "rev-parse", "HEAD").trim();
  h.agents.get(more.lead!)!.status = "idle";
  assert.match((await land("L2")).text, /merged lane\/l2-more into main/);
  assert.deepEqual(h.git(h.root, "log", "-1", "--format=%P", "main").trim().split(" "), [before, tip]);
});

test("a landing ordered while a turn was in the way is not carried out on a lane that changed since, and whoever ordered it hears what changed", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Numbers", outcome: "a.txt gains words", ...scope });
  const lane = h.ledger().lanes.L1!;
  h.commit(h.root, "a.txt", "one\ntwo\nthree\nfour\n");
  h.commitTo("main", "other.txt", "main moved\n");
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  assert.equal((await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).ok, true);
  // Its Lead's turn goes on after the order, and a Peer's work reaches the lane meanwhile.
  h.commit(h.root, "a.txt", "one\ntwo\nthree\nfour\nfive\n");
  await h.idle(sup);
  h.agents.get(lane.lead!)!.status = "idle";
  await h.endTurn(lane.lead!, "went on");
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().lanes.L1!.status, "open");
  assert.doesNotMatch(h.git(h.root, "show", "main:a.txt"), /four/);
  assert.equal(h.ledger().lanes.L1!.landing, undefined, "an order is carried out or called off once");
  assert.match(
    h.agents.get(sup)!.sent.join("\n"),
    /NOT LANDED L1 \(Numbers\): the turn in its way ended, but its branch moved since your land_lane, so the desk did not land it\.\n\nNext: land_lane it again to land it as it is now, or drop_lane it\./,
  );
});

test("a landing ordered while a turn was in the way that its gate then refuses is told NOT LANDED, with why", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", { gate: "test -f NEVER", gateOn: "lane" });
  await h.call(sup, "supervisor", "open_lane", { title: "Numbers", outcome: "a.txt gains words", ...scope });
  const lane = h.ledger().lanes.L1!;
  h.commit(h.root, "a.txt", "one\ntwo\nthree\nfour\n");
  h.commitTo("main", "other.txt", "main moved\n");
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  assert.match((await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).text, /^Lane L1 lands once /);
  await h.idle(sup);
  h.agents.get(lane.lead!)!.status = "idle";
  await h.endTurn(lane.lead!, "reported");
  await h.runtime.desk.settled(h.project);
  await h.idle(sup);
  assert.equal(h.ledger().lanes.L1!.status, "open");
  const sent = h.agents.get(sup)!.sent.join("\n");
  assert.match(
    sent,
    /NOT LANDED L1 \(Numbers\): Lane L1 was not closed: test -f NEVER failed with exit 1 on the lane branch\./,
  );
  assert.doesNotMatch(sent, /^LANDED L1/m);
});

test("an ordered landing that fails when the desk carries it out wakes whoever ordered it with NOT LANDED and the error, and is not ordered again", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Numbers", outcome: "a.txt gains words", ...scope });
  const lane = h.ledger().lanes.L1!;
  h.commit(h.root, "a.txt", "one\ntwo\nthree\nfour\n");
  h.commitTo("main", "other.txt", "main moved\n");
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  assert.match((await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).text, /^Lane L1 lands once /);
  // The landing itself breaks, as a git that dies mid-merge would: closeLane throws rather than answering.
  const { landings } = (h.runtime.desk as unknown as { services: DeskServices }).services;
  const run = landings.run.bind(landings);
  landings.run = <T>(key: string, work: () => Promise<T>): Promise<T> =>
    key.endsWith(":land") ? Promise.reject(new Error("git merge died")) : run(key, work);
  await h.idle(sup);
  h.agents.get(lane.lead!)!.status = "idle";
  await h.endTurn(lane.lead!, "reported");
  await h.runtime.desk.settled(h.project);
  await h.idle(sup);
  assert.equal(h.ledger().lanes.L1!.status, "open");
  assert.equal(h.ledger().lanes.L1!.landing, undefined, "a failed order is not left to be carried out again");
  assert.match(
    h.agents.get(sup)!.sent.join("\n"),
    /NOT LANDED L1 \(Numbers\): the turn in its way ended, but the desk's landing of it failed: git merge died\./,
    "whoever ordered it waits on LANDED or NOT LANDED, so a failure is told too",
  );
});

test("a review already reading when a landing was ordered is new evidence once it comes back, so the landing waits for the Supervisor's word again", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Numbers", outcome: "a.txt gains words", ...scope });
  const lane = h.ledger().lanes.L1!;
  h.commit(h.root, "a.txt", "one\ntwo\nthree\nfour\n");
  await h.call(lane.lead!, "lead", "start_review", { focus: "Does the whole lane hold?" });
  const reviewer = h.ledger().tasks["L1-R1"]!.peer!;
  h.commitTo("main", "other.txt", "main moved\n");
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  assert.match((await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).text, /^Lane L1 lands once /);
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal((await h.call(reviewer, "reviewer", "done", { verdict: "changes", answer: "four is wrong" })).ok, true);
  await h.idle(sup);
  for (const id of [reviewer, lane.lead!]) {
    h.agents.get(id)!.status = "idle";
    await h.endTurn(id, "done");
  }
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().lanes.L1!.status, "open");
  assert.match(
    h.agents.get(sup)!.sent.join("\n"),
    /NOT LANDED L1 \(Numbers\): the turn in its way ended, but L1-R1 came back, ending in changes since your land_lane/,
  );
});

test("a lane carrying on the Human's branch is refused where there is none, started as a new branch that takes their work along, drawn without a base, and landed where it is", async () => {
  const h = harness();
  h.projectSettings({ hitl: { on: true } });
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const open = (title: string, extra: Record<string, unknown>) =>
    h.call(sup, "supervisor", "open_lane", { title, outcome: "the login fix is finished", ...scope, ...extra });
  const branch = () => h.git(h.root, "branch", "--show-current").trim();
  const bee = () => readFileSync(join(h.root, "b.txt"), "utf-8");
  await h.call(sup, "supervisor", "set_project", { gate: "test ! -f BROKEN" });
  h.git(h.root, "switch", "-qc", "fix/login");
  h.commit(h.root, "a.txt", "one\ntwo\nthree\nhalf a fix\n");
  writeFileSync(join(h.root, "b.txt"), "bee, still being edited\n");
  const main = h.git(h.root, "rev-parse", "main").trim();
  for (const extra of [{ isolate: true }, { base: "main" }])
    assert.match((await open("Odd", { onBranch: true, ...extra })).text, /so it takes no base and no isolate/);
  assert.match((await open("Alone", { newBranch: "fix/login-2" })).text, /newBranch goes with onBranch/);
  assert.match(
    (await open("Taken", { onBranch: true, newBranch: "main" })).text,
    /^The branch main already exists: pick another name, or carry it on once the project's own copy is on it\.$/,
  );
  h.git(h.root, "switch", "-q", "--detach");
  assert.match((await open("Nowhere", { onBranch: true })).text, /not on a branch/);
  assert.match(
    (await open("Loose", {})).text,
    /^Nothing names the base this lane starts from: none is on record, and the project's own copy is not on a branch\. Pass base, or set_project names one\.$/,
  );
  h.git(h.root, "switch", "-q", "fix/login");

  assert.equal((await open("Finish the fix", { onBranch: true })).ok, true);
  const lane = h.ledger().lanes.L1!;
  assert.deepEqual([lane.branch, branch(), bee()], ["fix/login", "fix/login", "bee, still being edited\n"]);
  assert.deepEqual(h.git(h.root, "branch", "--format=%(refname:short)").trim().split("\n").sort(), [
    "fix/login",
    "main",
  ]);
  assert.equal(h.agents.get(lane.lead!)!.cwd, h.project.root);
  assert.match(
    h.agents.get(lane.lead!)!.prompt ?? "",
    /fix\/login, the Human's own[\s\S]*have the first task working there commit it as found, in a commit of its own/,
  );
  assert.notEqual(loadConfig(h.project.state).base, "fix/login");
  const flow = await h.rpc(contracts.flow, { project: h.project.slug });
  assert.ok("lanes" in flow);
  assert.deepEqual(
    flow.lanes.map((entry) => [entry.id, entry.branch, entry.base]),
    [["L1", "fix/login", undefined]],
  );
  assert.match((await open("Also here", { onBranch: true })).text, /L1/);
  h.commit(h.root, "b.txt", "bee, done\n");
  await h.call(sup, "supervisor", "set_project", { askFirst: ["a.txt", "b.txt"] });
  assert.match(
    (await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).text,
    /waits for the Human's approval, on a card in your chat\. It changes b\.txt, under b\.txt, which the Human asked to be asked about first\.\n/,
  );
  h.humanSays(sup, "Stop asking me about a.txt and b.txt.");
  await h.call(sup, "supervisor", "set_project", { askFirst: [], humanSaid: "Stop asking me about a.txt and b.txt." });
  const closed = await h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  assert.equal(closed.ok, true, closed.text);
  assert.match(closed.text, /the work stays on fix\/login, the branch it carried on; nothing was merged anywhere/);
  assert.deepEqual([h.git(h.root, "rev-parse", "main").trim(), branch(), bee()], [main, "fix/login", "bee, done\n"]);
  h.agents.get(lane.lead!)!.status = "idle";
  await h.endTurn(lane.lead!, "done");

  writeFileSync(join(h.root, "b.txt"), "bee, half done\n");
  assert.equal((await open("Split off", { onBranch: true, newBranch: "fix/login-2" })).ok, true);
  const split = h.ledger().lanes.L2!;
  assert.equal(split.branch, "fix/login-2");
  assert.match(
    (await h.call(sup, "supervisor", "status", {})).text,
    /## L2 Split off\n\nBranch fix\/login-2, carried on in the project's own copy\./,
  );
  assert.deepEqual([branch(), bee()], ["fix/login-2", "bee, half done\n"]);
  assert.equal(h.git(h.root, "rev-parse", "fix/login").trim(), h.git(h.root, "rev-parse", "fix/login-2").trim());
  assert.equal((await h.call(sup, "supervisor", "drop_lane", { lane: "L2", reason: "no longer wanted" })).ok, true);
  assert.equal(h.ledger().lanes.L2!.restoring, undefined);
  assert.deepEqual([branch(), bee()], ["fix/login-2", "bee, half done\n"]);

  h.git(h.root, "stash", "-q");
  h.git(h.root, "switch", "-q", "main");
  await h.call(sup, "supervisor", "set_project", { base: "main" });
  assert.match(
    (await open("Straight on main", { onBranch: true })).text,
    /carries on main [^,]*, which is the project's base: nothing separates this work from it/,
  );
});
