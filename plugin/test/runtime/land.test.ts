import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../tempdir.ts";
import { settle } from "./fake-timeline.ts";
import { harness, laneWithPeer } from "./harness.ts";
import { heldLook } from "./lane-gates.ts";
import { laneWith, risky } from "./landable.ts";

type Harness = ReturnType<typeof harness>;

const scope = { acceptance: ["done"], outOfScope: ["anything else in the repository"] };

/** Writes and commits `files` where `cwd` has its branch checked out. */
function commitAll(h: Harness, cwd: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  h.git(cwd, "add", "-A");
  h.git(cwd, "commit", "-qm", Object.keys(files).join(", "));
}

test("a lane lands after another moved main, gated with main's newer work in it, even while a third holds the project's copy", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", { gate: "test ! -f b/b.txt || test -f c/c.txt" });
  for (const [title, path] of [
    ["Part A", "a/**"],
    ["Part B", "b/**"],
    ["Part C", "c/**"],
  ] as const) {
    const lane = { title, outcome: title, ...scope, writeSet: [path], isolate: title !== "Part A" };
    assert.equal((await h.call(sup, "supervisor", "open_lane", lane)).ok, true);
  }
  const lanes = h.ledger().lanes;
  for (const lane of Object.values(lanes)) h.agents.get(lane.lead!)!.status = "idle";
  assert.equal(lanes.L1!.slot, undefined);
  commitAll(h, lanes.L2!.worktree!, { "b/b.txt": "b/b.txt\n" });
  commitAll(h, lanes.L3!.worktree!, { "c/c.txt": "c/c.txt\n" });
  assert.equal((await h.call(sup, "supervisor", "land_lane", { lane: "L3" })).ok, true);
  const second = await h.call(sup, "supervisor", "land_lane", { lane: "L2" });
  assert.equal(second.ok, true, second.text);
  assert.doesNotMatch(second.text, /not landed/);
  assert.deepEqual(
    ["b/b.txt", "c/c.txt"].map((path) => h.git(h.root, "show", `main:${path}`)),
    ["b/b.txt\n", "c/c.txt\n"],
  );
  for (const id of ["L2", "L3"]) assert.equal((await h.call(sup, "supervisor", "release", { lane: id })).ok, true);
  assert.equal(h.git(h.root, "branch", "--list", lanes.L2!.branch, lanes.L3!.branch).trim(), "");
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), lanes.L1!.branch);
  assert.equal(h.ledger().lanes.L1!.status, "open");
});

test("a red gate or a red rehearsal holds a landing until the Supervisor lands over it with a reason", async () => {
  const { h, sup, lane, land, onMain } = await laneWith({ "src/db/001.sql": "create table t (id int);\n" });
  const rule = (paths: string[]) => ({
    paths,
    invariant: "running it twice changes nothing",
    reviewQuestion: "What does a second run do?",
    rehearse: "false",
  });
  const ready = async () => {
    await h.call(lane.lead!, "lead", "report", { summary: `ready ${Date.now()}`, ready: true });
    await h.idle(sup);
    return h
      .heard(sup)
      .filter((text) => text.startsWith("REPORT"))
      .at(-1)!;
  };
  await h.call(sup, "supervisor", "set_project", { riskRules: [rule(["migrations"])] });
  assert.doesNotMatch(await ready(), /rehearsing/);
  await h.call(sup, "supervisor", "set_project", { riskRules: [rule(["src/db"])] });
  assert.match(
    await ready(),
    /Gate: true passed on the lane branch in \d+s\n\nfalse, rehearsing that running it twice changes nothing, failed with exit 1 on the lane branch\./,
  );
  const refused = await land();
  assert.equal(refused.ok, false);
  assert.match(
    refused.text,
    /false, rehearsing that running it twice changes nothing, failed with exit 1[^]*land_lane it over the gate with overGate true and your reason/,
  );
  const bare = await h.call(sup, "supervisor", "land_lane", { lane: "L1", overGate: true });
  assert.equal(bare.ok, false);
  assert.match(bare.text, /needs its reason/);
  assert.equal(onMain("src/db/001.sql"), false);
  const over = await h.call(sup, "supervisor", "land_lane", {
    lane: "L1",
    overGate: true,
    reason: "the rehearsal is known broken",
  });
  assert.equal(over.ok, true, over.text);
  assert.ok(onMain("src/db/001.sql"));
});

test("work nobody committed in a lane's copy never lands, over the gate or not, and the desk never deletes it: READY waits for it, landing stops, a drop keeps the copy", async () => {
  const { h, sup, lane, land, onMain } = await laneWith({ "a.txt": "cart\n" }, [], { isolate: true });
  const copy = lane.worktree!;
  writeFileSync(join(copy, "notes.txt"), "half a thought\n");
  const ready = await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  assert.equal(ready.ok, false, ready.text);
  assert.match(ready.text, /working copy has work uncommitted \(\?\? notes\.txt\)/);
  const over = await h.call(sup, "supervisor", "land_lane", { lane: "L1", overGate: true, reason: "judged safe" });
  assert.equal(over.ok, false, over.text);
  assert.match(
    over.text,
    /^Lane L1 was not closed: its working copy has work uncommitted \(\?\? notes\.txt\)\. Only what is committed lands, so overGate does not pass it/,
  );
  assert.equal(onMain("a.txt"), true, "main keeps its own a.txt");
  assert.equal(h.git(h.root, "show", "main:a.txt"), "one\ntwo\nthree\n");
  assert.equal((await land()).ok, false);

  h.agents.get(lane.lead!)!.status = "closed";
  Object.assign(h.agents.get(lane.lead!)!, { archivedAt: new Date().toISOString() });
  const dropped = await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "not wanted" });
  assert.equal(dropped.ok, true, dropped.text);
  assert.match(
    dropped.text,
    new RegExp(
      `Its working copy S\\d+ holds work nobody committed, so it stays at ${copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
  await h.tick();
  assert.equal(readFileSync(join(copy, "notes.txt"), "utf-8"), "half a thought\n", "the desk never deletes work");
  const left = `## Copies left for their uncommitted work\n\n- ${copy}, once S`;
  assert.ok((await h.call(sup, "supervisor", "status", {})).text.includes(left), "and status keeps naming it");
  rmSync(copy, { recursive: true, force: true });
  await h.tick();
  assert.ok(!(await h.call(sup, "supervisor", "status", {})).text.includes(left), "until it is gone");
  assert.deepEqual(h.ledger().left ?? {}, {});
});

test("a gate that could not run because work nobody committed turned up while the lane was landing is no verdict overGate passes", async (t) => {
  const { h, sup, lane, onMain } = await laneWith({ "a.txt": "cart\n" }, [], { isolate: true });
  const copy = lane.worktree!;
  // main moved on, so landing first takes it into the lane's copy, asking who is at work there first.
  h.commit(h.root, "b.txt", "main moved\n");
  const { roster } = (h.runtime.desk as unknown as { services: { roster: { look(id: string): Promise<unknown> } } })
    .services;
  const look = roster.look.bind(roster);
  // Asked by the landing's merge of main, after the landing found the copy clean and before the gate looks.
  t.mock.method(roster, "look", async (id: string) => {
    if (new Error().stack?.includes("writing.ts")) writeFileSync(join(copy, "notes.txt"), "written while it landed\n");
    return look(id);
  });
  const over = await h.call(sup, "supervisor", "land_lane", { lane: "L1", overGate: true, reason: "judged safe" });
  assert.equal(over.ok, false, over.text);
  assert.match(
    over.text,
    /^Lane L1 was not closed: the gate did not run: the lane's working copy has work uncommitted \(\?\? notes\.txt\)\nland_lane it again once it can run, or drop_lane it\./,
  );
  assert.equal(h.ledger().lanes.L1!.status, "open");
  assert.equal(h.git(h.root, "show", "main:a.txt"), "one\ntwo\nthree\n", "nothing landed");
  assert.equal(onMain("b.txt"), true);
});

test("in the Human's own checkout, files git does not track are theirs: a fact for whoever lands, never a stop, while changes to tracked files still stop READY and landing", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", { gate: "true" });
  writeFileSync(join(h.root, "notes.txt"), "the Human's own notes\n");
  const opened = await h.call(sup, "supervisor", "open_lane", { title: "Cart", outcome: "a cart", ...scope });
  assert.equal(opened.ok, true, opened.text);
  const lane = h.ledger().lanes.L1!;
  assert.equal(lane.slot, undefined, "it opened in the project's own copy");
  writeFileSync(join(h.root, "a.txt"), "cart\n");
  h.git(h.root, "commit", "-qam", "cart");
  writeFileSync(join(h.root, "b.txt"), "the Human is editing\n");
  const report = () => h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  assert.match((await report()).text, /working copy has work uncommitted \(M b\.txt\)/);
  h.git(h.root, "checkout", "--", "b.txt");
  const ready = await report();
  assert.equal(ready.ok, true, ready.text);
  h.agents.get(lane.lead!)!.status = "idle";
  const landed = await h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  assert.equal(landed.ok, true, landed.text);
  assert.match(landed.text, /The project's own copy holds files git does not track, which do not land: notes\.txt\./);
  assert.equal(readFileSync(join(h.root, "notes.txt"), "utf-8"), "the Human's own notes\n");
  assert.equal(h.git(h.root, "show", "main:a.txt"), "cart\n");
});

/** Runs `during` with a git first on PATH that fails the `nth` call whose words hold `words`, as git fails when it cannot read. */
async function withGitFailing<T>(h: Harness, words: string, nth: number, during: () => Promise<T>): Promise<T> {
  const bin = tempDir("sw3-git-");
  const real = h.git(h.root, "--exec-path").trim();
  const count = `n=$(($(cat "${bin}/n" 2>/dev/null || echo 0) + 1)); echo $n > "${bin}/n"`;
  const fail = `if [ $n = ${nth} ]; then echo "fatal: cannot read" >&2; exit 128; fi`;
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncase " $* " in *" ${words} "*) ${count}; ${fail};; esac\nexec "${real}/git" "$@"\n`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  return during().finally(() => (process.env.PATH = path));
}

test("a lane whose head git cannot read when its gate is to run is not landed, and not said to have moved", async () => {
  const { h, lane, land, onMain } = await laneWith({ "src/cart.ts": "export const cart = 1;\n" });
  const refused = await withGitFailing(h, `rev-parse --verify ${lane.branch}^{commit}`, 2, land);
  assert.equal(refused.ok, false, refused.text);
  assert.match(refused.text, new RegExp(`^Lane L1 was not closed: git could not read ${lane.branch}`));
  assert.doesNotMatch(refused.text, /moved after its gate ran/);
  assert.equal(onMain("src/cart.ts"), false);
  assert.equal((await land()).ok, true, "once git reads it, it lands");
});

test("what git could not say of a lane's tests is evidence that it could not, never that nothing was deleted", async () => {
  const { h, land } = await laneWith({ "test/cart.test.ts": "assert.ok(true);\n" });
  const landed = await withGitFailing(h, "--diff-filter=D", 1, land);
  assert.equal(landed.ok, true, landed.text);
  assert.match(landed.text, /Which test files it deleted could not be read from git\./);
});

test("what git shows of a lane goes with its landing as evidence, and holds nothing back", async () => {
  const { h, sup, land, onMain } = await laneWith(risky);
  const landed = await land();
  assert.equal(landed.ok, true, landed.text);
  assert.ok(onMain("src/auth/login.ts"));
  assert.match(
    landed.text,
    /Evidence: 1 commit; 1 file, 1 line changed\. Gate: passed on the lane\. No review of the whole lane is on record\./,
  );

  commitAll(h, h.root, {
    "test/cart.test.ts": "assert.equal(total, 1);\nassert.ok(total);\n",
    "test/old.test.ts": "assert.ok(true);\n",
  });
  await h.call(sup, "supervisor", "set_project", { gate: "false", gateOn: "task" });
  const cart = { title: "Cart", outcome: "a cart", ...scope, writeSet: ["src/**", "test/**"], isolate: true };
  await h.call(sup, "supervisor", "open_lane", cart);
  const lane = h.ledger().lanes.L2!;
  const tasks = [{ key: "t", title: "Totals", goal: "g", ...scope, hints: ["src/cart.ts"] }];
  await h.call(lane.lead!, "lead", "add_tasks", { tasks });
  const task = h.ledger().tasks["L2-T1"]!;
  rmSync(join(task.worktree!, "test/old.test.ts"));
  commitAll(h, task.worktree!, {
    "src/cart.ts": "export const total = 2;\n",
    "test/cart.test.ts": "assert.equal(total, 2);\nit.skip('later', () => {});\n",
    "docs/notes.md": "x\n".repeat(600),
    "package-lock.json": `${"{}\n".repeat(900)}`,
  });
  await h.call(task.peer!, "peer", "done", { outcome: "complete", summary: "totals" });
  h.agents.get(task.peer!)!.status = "idle";
  const accepted = await h.call(lane.lead!, "lead", "accept", {
    task: "L2-T1",
    overGate: true,
    reason: "a known flake",
  });
  assert.equal(accepted.ok, true, accepted.text);
  await h.runtime.desk.settled(h.project);
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  h.agents.get(lane.lead!)!.status = "idle";
  const over = await h.call(sup, "supervisor", "land_lane", { lane: "L2", overGate: true, reason: "the flake again" });
  assert.equal(over.ok, true, over.text);
  const evidence = over.text.slice(over.text.indexOf("Evidence: "));
  for (const line of [
    "Gate: failed on the lane.",
    "Tests changed: test/cart.test.ts, test/old.test.ts.",
    "test/old.test.ts is deleted.",
    "test/cart.test.ts: adds a skip marker.",
    "docs/notes.md is outside the lane's write set, src/**, test/**.",
    "package-lock.json is outside the lane's write set, src/**, test/**.",
    "L2-T1 was accepted over its red gate: false: the gate failed with exit 1; the same gate on lane/l2-cart at",
  ])
    assert.ok(evidence.includes(line), `${line}\n${evidence}`);
});

test("what the record holds of a lane goes to whoever lands it, and never to the Lead it is about", async () => {
  const { h, sup, lane, peer, timeline } = await laneWithPeer(undefined, undefined, {
    holds: ["a.txt"],
    parallel: true,
  });
  const lead = lane.lead!;
  await h.call(sup, "supervisor", "set_project", { gate: "npm test", gateOn: "lane" });
  const worktree = h.ledger().tasks["L1-T1"]!.worktree!;
  timeline.beat("turn_started", "t1");
  timeline.add({ type: "user_message", text: "Clean the build" }, "t1");
  const edit = { type: "edit", filePath: join(worktree, "a.txt"), oldString: "one", newString: "uno" };
  timeline.add({ type: "tool_call", callId: "w1", name: "Edit", status: "completed", detail: edit }, "t1");
  const run = { type: "shell", command: "npm test", output: "1 failing", exitCode: 1 };
  timeline.add({ type: "tool_call", callId: "g1", name: "Bash", status: "completed", detail: run }, "t1");
  await settle();
  const handed = await h.call(peer, "peer", "done", {
    outcome: "complete",
    summary: "done",
    checks: "npm test passes",
  });
  assert.equal(handed.ok, true);
  timeline.beat("turn_completed", "t1");
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await h.idle(peer);
  await h.idle(lead);
  await h.idle(sup);
  assert.match(
    h.agents.get(sup)!.sent.join("\n"),
    /INCIDENT I\d+ \(claim-contradicted, attend\) on the Peer on L1-T1[^]*handed back as complete, but `npm test` failed the last time it ran, after the last edit/,
  );
  assert.doesNotMatch(h.agents.get(lead)!.sent.join("\n"), /INCIDENT/, "never to the Lead it is about");

  const beside = [{ key: "s", title: "Side", goal: "g", ...scope, holds: ["c.txt"], parallel: true }];
  await h.call(lead, "lead", "add_tasks", { tasks: beside });
  await h.call(lead, "lead", "start_review", { focus: "the lane as a whole" });
  const review = Object.values(h.ledger().tasks).find((task) => task.kind === "review")!;
  await h.call(review.peer!, "reviewer", "done", { verdict: "accept", answer: "Right." });
  await h.call(sup, "supervisor", "open_lane", { title: "Other", outcome: "x", ...scope, isolate: true });
  const other = h.ledger().lanes.L2!;
  await h.call(other.lead!, "lead", "add_tasks", { tasks: [{ key: "o", title: "Push", goal: "g", ...scope }] });
  await h.tick();
  const pushing = h.timelineOf(h.ledger().tasks["L2-T1"]!.peer!);
  pushing.beat("turn_started", "p1");
  const force = { type: "shell", command: "git push --force origin main" };
  pushing.add({ type: "tool_call", callId: "c1", name: "Bash", status: "running", detail: force }, "p1");
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    h.events("incident.open").map((event) => [event.id, event.finding]),
    [
      ["I1", "claim-contradicted"],
      ["I2", "review-unchecked"],
      ["I3", "destructive"],
    ],
    "the review accepted with no command run, as its own calls show",
  );

  const reported = await h.call(lead, "lead", "report", { summary: "done", ready: true });
  assert.doesNotMatch(reported.text, /Incident|claim-contradicted/);
  await h.idle(sup);
  // Mail held for a busy seat goes as one text: the report is read from its own heading on.
  const composed = h
    .heard(sup)
    .filter((text) => text.includes("REPORT L1"))
    .at(-1)!;
  // Its heading at a line's start: the queue's index names it too.
  const report = composed.slice(composed.search(/^REPORT L1/m));
  assert.match(
    report,
    /REPORT L1 \(Build\): ready to land[^]*- Incident I\d+ on this lane is still open: claim-contradicted\./,
  );
  assert.match(report, /L1-T2 is running: landing cuts it\./);
  assert.match(report, /L1-R1 review: accept\./);
  assert.doesNotMatch(report, /L1-R1 is|destructive/);
  const landed = await h.call(sup, "supervisor", "land_lane", { lane: "L1", overGate: true, reason: "judged safe" });
  assert.equal(landed.ok, true, landed.text);
  assert.match(landed.text, /Incident I\d+ on this lane is still open: claim-contradicted\./);
  assert.match(landed.text, /It cut L1-T1, L1-T2, which were not finished\./);
});

test("two lanes landed at once each stay on the base: the second waits for the first, and a landing never erases another", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const gate = tempDir("sw3-gate-");
  const hold = `test ! -f hold || test ! -f ${gate}/armed || { : > ${gate}/reached; until test -f ${gate}/open; do sleep 0.02; done; }`;
  await h.call(sup, "supervisor", "set_project", { gate: hold });
  for (const [title, file] of [
    ["Cart", "cart.txt"],
    ["Order", "order.txt"],
  ] as const) {
    const opened = await h.call(sup, "supervisor", "open_lane", {
      title,
      outcome: title,
      ...scope,
      writeSet: title === "Cart" ? [file, "hold"] : [file],
      isolate: true,
    });
    assert.equal(opened.ok, true, opened.text);
    const lane = Object.values(h.ledger().lanes).find((entry) => entry.title === title)!;
    commitAll(h, lane.worktree!, title === "Cart" ? { [file]: `${title}\n`, hold: "" } : { [file]: `${title}\n` });
    h.agents.get(lane.lead!)!.status = "idle";
  }
  h.git(h.root, "switch", "-qc", "human-work");
  writeFileSync(join(gate, "armed"), "");
  const first = h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  for (let i = 0; i < 500 && !existsSync(join(gate, "reached")); i++) await settle();
  assert.ok(existsSync(join(gate, "reached")), "the first landing is held in its gate");
  const looked = heldLook(h, sup);
  const second = h.call(sup, "supervisor", "land_lane", { lane: "L2" });
  await looked.reached;
  looked.release();
  await settle();
  writeFileSync(join(gate, "open"), "");
  const replies = await Promise.all([first, second]);
  assert.deepEqual(
    replies.map((reply) => reply.ok),
    [true, true],
    replies.map((reply) => reply.text).join("\n"),
  );
  const onMain = h.git(h.root, "ls-tree", "--name-only", "-r", "main").split("\n");
  assert.deepEqual(
    ["cart.txt", "order.txt"].filter((file) => onMain.includes(file)),
    ["cart.txt", "order.txt"],
  );
});

test("with the Human out of the loop, getting what landed out is the Supervisor's: push sends the base where git would, and a release tag, never forced", async () => {
  const { h, sup, land } = await laneWith({ "a.txt": "cart\n" });
  const remote = tempDir("sw3-remote-");
  h.git(remote, "init", "-q", "--bare");
  h.git(h.root, "remote", "add", "origin", remote);
  const landed = await land();
  assert.equal(landed.ok, true, landed.text);
  assert.match(
    landed.text,
    /Getting it out is yours while the Human is out of the loop: push sends main to its remote/,
  );
  const push = (args: Record<string, unknown> = {}) => h.call(sup, "supervisor", "push", args);
  assert.match(
    (await push()).text,
    /^Nothing was pushed: main names no remote to push to, as git reads it/,
    "a remote that is only there is not where the Human's own git would push",
  );
  h.git(h.root, "config", "branch.main.remote", "origin");
  h.git(h.root, "config", "branch.main.merge", "refs/heads/main");
  assert.match((await push()).text, /^Pushed main to origin\.$/);
  const head = () => h.git(h.root, "rev-parse", "main").trim();
  assert.equal(h.git(remote, "rev-parse", "main").trim(), head());
  h.git(h.root, "config", "user.name", "The Human");
  h.git(h.root, "config", "tag.gpgSign", "true");
  h.git(h.root, "config", "gpg.program", "false");
  assert.match(
    (await push({ tag: "v1.0.0", message: "the cart" })).text,
    /^Pushed main and the tag v1\.0\.0 to origin\.$/,
  );
  assert.equal(h.git(remote, "rev-parse", "v1.0.0^{commit}").trim(), head());
  assert.equal(
    h.git(remote, "for-each-ref", "--format=%(taggername) %(contents:signature)", "refs/tags/v1.0.0").trim(),
    "seatworks",
    "a release tag the desk makes is its own, unsigned, as its commits are",
  );
  assert.match((await push({ tag: "bad..tag" })).text, /bad\.\.tag is not a name git takes for a tag/);

  const fork = tempDir("sw3-fork-");
  h.git(fork, "init", "-q", "--bare");
  h.git(h.root, "remote", "add", "fork", fork);
  h.git(h.root, "config", "remote.pushDefault", "fork");
  assert.match((await push()).text, /^Pushed main to fork\.$/, "where the Human pushes, not where they fetch from");
  assert.equal(h.git(fork, "rev-parse", "main").trim(), head());
  h.git(h.root, "config", "--unset", "remote.pushDefault");

  const elsewhere = tempDir("sw3-elsewhere-");
  h.git(elsewhere, "clone", "-q", remote, ".");
  h.git(elsewhere, "commit", "-q", "--allow-empty", "-m", "elsewhere");
  h.git(elsewhere, "push", "-q", "origin", "main");
  h.git(h.root, "commit", "-q", "--allow-empty", "-m", "here");
  for (let again = 0; again < 2; again++)
    assert.match(
      (await push({ tag: "v1.1.0" })).text,
      /^Nothing was pushed: origin has 1 commit on main that main here lacks/,
      "a tag for a push that failed is not left behind to refuse the next try",
    );
  assert.equal(h.git(h.root, "tag", "--list", "v1.1.0").trim(), "");
  assert.match(
    (await push()).text,
    /^Nothing was pushed: origin has 1 commit on main that main here lacks, and a push is never forced\. Taking it in is a lane's work: open_lane with a task whose Peer merges origin\/main, fetched now, into its own branch/,
    "a remote that moved on is never forced, and taking it in goes through a lane",
  );
  assert.equal(h.git(h.root, "rev-parse", "origin/main").trim(), h.git(remote, "rev-parse", "main").trim());

  h.projectSettings({ hitl: { on: true } });
  assert.match((await push()).text, /^Pushing and releasing are the Human's while they are in the loop/);
});

test("the lane that audits what goes out hears of each landing on its base, as mail that asks it to look", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Work", outcome: "a.txt changes", ...scope });
  const audit = await h.call(sup, "supervisor", "open_lane", {
    title: "Audit",
    outcome: "main does what CONTEXT.md says before it is pushed",
    ...scope,
    isolate: true,
    audit: true,
  });
  assert.equal(audit.ok, true, audit.text);
  const other = await h.call(sup, "supervisor", "open_lane", {
    title: "Other",
    outcome: "b.txt changes",
    ...scope,
    isolate: true,
  });
  assert.equal(other.ok, true, other.text);
  const [work, auditor, bystander] = [h.ledger().lanes.L1!, h.ledger().lanes.L2!, h.ledger().lanes.L3!];
  assert.equal(auditor.audit, true);
  h.commit(work.worktree!, "a.txt", "changed\n");
  await h.call(work.lead!, "lead", "report", { summary: "done", ready: true });
  h.agents.get(work.lead!)!.status = "idle";
  assert.equal((await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).ok, true);
  const told = h.runtime.outbox.pending(auditor.lead!).find((letter) => letter.text.startsWith("LANDED L1"));
  assert.ok(told, "held for its turn to end, as it is running");
  assert.notEqual(told.wakes, false, "it asks the audit to look");
  assert.match(told.text, /^LANDED L1 \(Work\) on main: squashed lane\/l1-work into one commit on main/);
  assert.equal(
    h.runtime.outbox.pending(work.lead!).some((letter) => letter.text.startsWith("LANDED L1 (Work) on main")),
    false,
    "only the audit's Lead",
  );
  assert.equal(
    h.runtime.outbox.pending(bystander.lead!).some((letter) => letter.text.startsWith("LANDED L1 (Work) on main")),
    false,
    "not another lane open on the same base",
  );
});
