import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../tempdir.ts";
import { harness } from "./harness.ts";

const lane = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  outcome: "x",
  acceptance: ["a"],
  outOfScope: ["anything else in the repository"],
  ...extra,
});

test("where a lane works is carried by open_lane or laneHome; with neither, a copy off its base or dirty leaves the lane in a copy of its own, decided for them and said so", async () => {
  const h = harness();
  h.projectSettings({ hitl: { on: true } });
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const status = async () => (await h.call(sup, "supervisor", "status", {})).text;
  const branch = () => h.git(h.root, "branch", "--show-current").trim();
  const open = (title: string, extra: Record<string, unknown> = {}) =>
    h.call(sup, "supervisor", "open_lane", lane(title, extra));
  const choice =
    /Nothing on record chooses where the next lane works, so it opens in a copy of its own unless the Human chooses another: /;
  await h.call(sup, "supervisor", "set_project", { base: "main", gate: "true" });
  const endless = await h.call(sup, "supervisor", "set_project", { gate: "npm test", gateTimeoutMinutes: 0 });
  assert.match(endless.text, /^Nothing was set: gateTimeoutMinutes/);
  assert.match((await h.call(sup, "supervisor", "set_project", {})).text, /^Base main; gate true, /);
  const fresh = await status();
  assert.match(
    fresh,
    /Base main\.[^\n]*\n\n## The project's own copy\n\n[^\n]* is on main, clean\.\nNo lane is working in it\./,
  );
  assert.doesNotMatch(fresh, choice);

  h.git(h.root, "switch", "-qc", "fix/login");
  const offBase = await status();
  assert.match(offBase, /is on fix\/login, clean\./);
  assert.match(offBase, choice);
  assert.match(
    offBase,
    /carry on fix\/login here \(onBranch\), a new branch off main here \(isolate false\), or a copy of its own \(isolate\)\./,
  );
  const decided =
    /\n\nNothing on record chose where it works, so it opened in a copy of its own, which leaves the project's own copy as it is: decided for you\. The choices were to carry on fix\/login here \(onBranch\), /;
  const first = await open("First");
  assert.equal(first.ok, true, first.text);
  assert.match(
    first.text,
    new RegExp(
      `${decided.source}a new branch off main here \\(isolate false\\), or a copy of its own \\(isolate\\); set_project laneHome keeps a choice for every lane\\.$`,
    ),
  );
  assert.deepEqual([branch(), Boolean(h.ledger().lanes.L1!.slot)], ["fix/login", true]);
  h.commit(h.ledger().lanes.L1!.worktree!, "a.txt", "first\n");
  assert.match((await open("Then", { after: ["L1"] })).text, /Lane L2 waits for L1/);
  for (let n = 1; n <= 12; n++) writeFileSync(join(h.root, `wip-${String(n).padStart(2, "0")}.txt`), "half done\n");
  writeFileSync(join(h.root, "a.txt"), "edited\n");
  h.agents.get(h.ledger().lanes.L1!.lead!)!.status = "idle";
  assert.equal((await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).ok, true);
  const then = h.ledger().lanes.L2!;
  assert.deepEqual([then.status, Boolean(then.slot)], ["open", true], "a lane that waited opens as one opened now");
  await h.idle(sup);
  assert.match(
    h.heard(sup).join("\n"),
    new RegExp(`OPENED L2 \\(Then\\)[^]*${decided.source}a new branch that takes the uncommitted work along`),
  );
  assert.equal(branch(), "fix/login");
  assert.equal(readFileSync(join(h.root, "a.txt"), "utf-8"), "edited\n");
  assert.equal(h.git(h.root, "status", "--porcelain").trim().split("\n").length, 13);
  const now = await open("Now", { after: ["L1"] });
  assert.match(now.text, new RegExp(`${decided.source}a new branch that takes the uncommitted work along`));
  assert.deepEqual([branch(), Boolean(h.ledger().lanes.L3!.slot)], ["fix/login", true]);
  for (const id of ["L2", "L3"])
    assert.equal((await h.call(sup, "supervisor", "drop_lane", { lane: id, reason: "not now" })).ok, true);
  const dirty = await status();
  assert.match(dirty, /with 13 uncommitted files: a\.txt, wip-01\.txt, [^\n]*wip-09\.txt, and 3 more\./);
  assert.match(dirty, /takes the uncommitted work along/);
  h.git(h.root, "stash", "-u", "-q");

  const here = await open("Numbers", {
    outcome: "a.txt gains words",
    writeSet: ["a.txt"],
    contracts: ["b.txt"],
    isolate: false,
  });
  assert.equal(here.ok, true, here.text);
  const numbers = h.ledger().lanes.L4!;
  assert.equal(branch(), numbers.branch);
  const taken = await status();
  assert.match(taken, /Lane L4 is working in it\./);
  assert.doesNotMatch(taken, choice);
  assert.match(taken, /Outcome: a\.txt gains words\nWrites: a\.txt\nDepends on: b\.txt/);
  assert.doesNotMatch((await h.call(numbers.lead!, "lead", "status", {})).text, /The project's own copy|Outcome:/);
  await h.call(sup, "supervisor", "drop_lane", { lane: "L4", reason: "done" });
  h.agents.get(numbers.lead!)!.status = "idle";
  await h.endTurn(numbers.lead!, "done");
  h.git(h.root, "switch", "-q", "fix/login");

  const said = "Open lanes where I say from now on, please.";
  h.humanSays(sup, said);
  await h.call(sup, "supervisor", "set_project", { laneHome: "newBranch", humanSaid: said });
  writeFileSync(join(h.root, "a.txt"), "the Human's own edit\n");
  assert.match(
    (await open("Here", { writeSet: ["b.txt"] })).text,
    /^Where this lane works cannot be a new branch in the project's own copy while that copy has uncommitted work: carry on fix\/login here \(onBranch\), a new branch that takes the uncommitted work along/,
  );
  h.git(h.root, "checkout", "--", "a.txt");
  assert.match(
    (await h.call(sup, "supervisor", "set_project", { laneHome: "isolate" })).text,
    /^Nothing was set: to set where lanes work to isolate is the Human's while they are in the loop\. Ask them, and pass their words/,
  );
  assert.equal((await h.call(sup, "supervisor", "set_project", { laneHome: "isolate", humanSaid: said })).ok, true);
  assert.match(
    (await h.call(sup, "supervisor", "set_project", { riskRules: [] })).text,
    /^Nothing was set: to drop the risk rule that running it a second time changes nothing, [^.]* is the Human's while they are in the loop\./,
    "a risk rule is a standing order the Supervisor may only raise",
  );
  const rule = { paths: ["db/**"], invariant: "a second run changes nothing", reviewQuestion: "And a second run?" };
  assert.match((await h.call(sup, "supervisor", "set_project", { riskRules: [rule] })).text, /^Nothing was set/);
  assert.equal((await h.call(sup, "supervisor", "set_project", { riskRules: [rule], humanSaid: said })).ok, true);
  assert.match(await status(), /Lanes open in a copy of their own, as chosen for every lane \(laneHome\)\./);
  assert.equal((await open("Standing")).ok, true);
  assert.ok(h.ledger().lanes.L5!.slot);
  assert.equal(branch(), "fix/login");
  const offMain = await open("Off main", { base: "main" });
  assert.equal(offMain.ok, true, offMain.text);
  assert.deepEqual(
    [h.ledger().lanes.L6!.base, Boolean(h.ledger().lanes.L6!.slot), branch()],
    ["main", true, "fix/login"],
  );
  assert.equal((await open("After it", { after: ["L5"] })).ok, true);
  assert.equal(h.ledger().lanes.L7!.opening?.home, "isolate");
  await h.call(sup, "supervisor", "set_project", { laneHome: "onBranch", humanSaid: said });
  assert.equal((await open("Carry on")).ok, true);
  assert.deepEqual([h.ledger().lanes.L8!.onBranch, h.ledger().lanes.L8!.branch], [true, "fix/login"]);
});

test("with the Human out of the loop, where a lane works is the Supervisor's to choose, status says so, and a lane nothing chose for opens in a copy of its own", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", { base: "main", gate: "true" });
  h.git(h.root, "switch", "-qc", "fix/login");
  const status = (await h.call(sup, "supervisor", "status", {})).text;
  assert.match(
    status,
    /Nothing on record chooses where the next lane works, so it opens in a copy of its own unless you choose another: carry on fix\/login here \(onBranch\)/,
  );
  assert.match(status, /The Human is out of the loop: only the concept is theirs, so no landing waits for them/);
  const opened = await h.call(sup, "supervisor", "open_lane", lane("First"));
  assert.equal(opened.ok, true, opened.text);
  assert.match(
    opened.text,
    /Nothing on record chose where it works, so it opened in a copy of its own[^]*: decided for you\. The choices were to carry on fix\/login here \(onBranch\)[^]*; set_project laneHome keeps a choice for every lane\.$/,
  );
  assert.doesNotMatch(opened.text, /Human/);
  assert.deepEqual(
    [h.git(h.root, "branch", "--show-current").trim(), Boolean(h.ledger().lanes.L1!.slot)],
    ["fix/login", true],
  );
});

test("a lane takes the project's own copy while it is free; one that finds it taken, or still being given back, is told both ways out, and a copy of its own is filed under the project", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const open = (title: string, extra: Record<string, unknown> = {}) =>
    h.call(sup, "supervisor", "open_lane", lane(title, extra));
  assert.equal((await open("Authorization", { outcome: "roles gate the api" })).ok, true);
  const first = h.ledger().lanes.L1!;
  assert.match(
    (await h.call(sup, "supervisor", "set_project", {})).text,
    /^Base unset;/,
    "the branch a lane starts from is not the project's base until set_project names one",
  );
  const auth = { outcome: "sessions exist", writeSet: ["src/auth/**"] };
  assert.match(
    (await open("Authentication", auth)).text,
    /Lane L1 is working in the project's own copy on lane\/l1-authorization\. Pass isolate to open this lane in a copy of its own now, or open it with after L1/,
  );
  assert.equal(Object.keys(h.ledger().lanes).length, 1);
  assert.equal((await open("Authentication", { ...auth, isolate: true })).ok, true);
  const second = h.ledger().lanes.L2!;
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), first.branch);
  assert.notEqual(h.workspaces.get(second.workspaceId!), h.root);
  assert.equal(h.workspaceProjects.get(second.workspaceId!), h.workspaceProjects.get(first.workspaceId!));

  const dropped = await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "wrong outcome" });
  assert.match(dropped.text, /^Lane L1 closed; the branch lane\/l1-authorization is kept\./);
  assert.doesNotMatch(dropped.text, /Human/, "out of the loop, a reply sends nobody to the Human");
  assert.deepEqual(h.ledger().lanes.L1!.restoring!.writers, [first.lead!]);
  assert.match(
    (await open("Second")).text,
    /Lane L1 is closed, but its Lead is still ending a turn in the project's own copy, which goes back to main when that turn ends\. Pass isolate/,
  );
  assert.match(
    (await h.call(sup, "supervisor", "status", {})).text,
    /Lane L1 is closed, and its Lead is ending a turn in it; it goes back to main after\./,
  );
  assert.equal((await open("Second", { isolate: true })).ok, true);
  const third = h.ledger().lanes.L3!;
  assert.ok(third.slot);
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), first.branch);
  h.agents.get(first.lead!)!.status = "idle";
  await h.endTurn(first.lead!, "stopping");
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), "main");
  h.commit(third.worktree!, "a.txt", "L3 work\n");
  assert.equal(h.git(h.root, "log", "-1", "--format=%s", third.branch).trim(), "edit a.txt");

  const home = [...h.workspaceNames].find(([, name]) => name === h.project.slug)![0];
  const filed = h.workspaceProjects.get(home)!;
  h.workspaceProjects.set(home, "");
  const made = h.workspaces.size;
  const bare = await open("Away", { isolate: true });
  assert.equal(bare.ok, false);
  assert.match(bare.text, /names no Paseo project/);
  assert.equal(h.workspaces.size, made);
  assert.equal(h.git(h.root, "branch", "--list", "lane/l4-away").trim(), "", "a copy never made leaves no branch");

  // A task whose copy could not be made starts on its own branch once the copy can be made.
  const beside = (key: string) => ({
    key,
    title: key,
    goal: "g",
    acceptance: ["a"],
    holds: [`${key}.txt`],
    parallel: true,
  });
  await h.call(third.lead!, "lead", "add_tasks", { tasks: [{ ...beside("one"), outOfScope: ["the rest"] }] });
  assert.equal(h.ledger().tasks["L3-T1"]!.peer, undefined);
  h.workspaceProjects.set(home, filed);
  await h.call(third.lead!, "lead", "add_tasks", { tasks: [{ ...beside("two"), outOfScope: ["the rest"] }] });
  const retried = h.ledger().tasks["L3-T1"]!;
  assert.deepEqual([retried.status, Boolean(retried.peer), Boolean(retried.slot)], ["running", true, true]);
});

type Fault = "seat" | "workspace";
const failed: { where: string; on?: string; ask: Record<string, unknown>; fault?: Fault; said: RegExp }[] = [
  {
    where: "a copy of its own",
    ask: { isolate: true },
    fault: "seat",
    said: /The Lead could not start: no seat today/,
  },
  { where: "the project's copy", ask: { role: "peer" }, said: /This kit has no peer that can lead a lane/ },
  {
    where: "the project's copy",
    ask: {},
    fault: "workspace",
    said: /could not get a working copy: the daemon made no workspace/,
  },
  {
    where: "the Human's branch",
    on: "fix/login",
    ask: { onBranch: true, role: "peer" },
    said: /no peer that can lead/,
  },
  {
    where: "a new branch off the Human's",
    on: "fix/login",
    ask: { onBranch: true, newBranch: "fix/login-2", role: "peer" },
    said: /no peer that can lead/,
  },
  {
    where: "a new branch off the Human's",
    on: "fix/login",
    ask: { onBranch: true, newBranch: "fix/login-2" },
    fault: "workspace",
    said: /could not get a working copy/,
  },
];

test("an open that fails gives back everything it took, wherever it took it, and keeps the Human's branch and work", async () => {
  for (const row of failed) {
    const h = harness();
    const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
    const paseo = h.paseo as {
      workspaces: {
        list: unknown;
        create: unknown;
        ref: (id: string) => { agents: { create: (options: unknown) => unknown } };
      };
    };
    const ref = paseo.workspaces.ref;
    if (row.fault === "seat")
      paseo.workspaces.ref = (id) => ({
        ...ref(id),
        agents: { create: () => Promise.reject(new Error("no seat today")) },
      });
    if (row.fault === "workspace")
      paseo.workspaces.list = paseo.workspaces.create = () => Promise.reject(new Error("the daemon made no workspace"));
    if (row.on) {
      h.git(h.root, "switch", "-qc", row.on);
      writeFileSync(join(h.root, "b.txt"), "bee, half done\n");
    }
    const opened = await h.call(sup, "supervisor", "open_lane", lane("Numbers", row.ask));
    const where = `${row.where}: ${opened.text}`;
    assert.equal(opened.ok, false, where);
    assert.match(opened.text, row.said, where);
    const taken = h.ledger().lanes.L1!;
    assert.deepEqual(
      [taken.status, taken.slot, taken.worktree, taken.workspaceId],
      ["closed", undefined, undefined, undefined],
      where,
    );
    assert.deepEqual(Object.keys(h.ledger().slots), [], where);
    assert.deepEqual(
      h.events("lane.closed").map((event) => [event.lane, event.landing]),
      [["L1", "its Lead could not start"]],
      where,
    );
    assert.equal(h.git(h.root, "branch", "--show-current").trim(), row.on ?? "main", where);
    const left = row.on ? (row.ask.newBranch as string | undefined) : taken.branch;
    if (left) assert.equal(h.git(h.root, "branch", "--list", left).trim(), "", where);
    if (!row.on) continue;
    assert.match(h.git(h.root, "branch", "--list", row.on), /fix\/login/, where);
    assert.equal(readFileSync(join(h.root, "b.txt"), "utf-8"), "bee, half done\n", where);
    assert.deepEqual(h.events("lane.gaveBack"), [], where);
  }
});

test("a detour gets a Lead and a copy of its own without asking, and the lane it clears hears how it ended", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const money = lane("Money type", { outcome: "money is not a float" });
  await h.call(sup, "supervisor", "open_lane", lane("Checkout", { outcome: "an order can be paid for" }));
  const waiting = h.ledger().lanes.L1!;
  assert.match(
    (await h.call(sup, "supervisor", "open_lane", { ...money, detourOf: "L7" })).text,
    /There is no open lane L7 for this one to clear the way for/,
  );
  const detour = await h.call(sup, "supervisor", "open_lane", { ...money, detourOf: "l1" });
  assert.equal(detour.ok, true, detour.text);
  const cleared = h.ledger().lanes.L2!;
  assert.equal(cleared.detourOf, "L1");
  assert.notEqual(h.agents.get(cleared.lead!)!.cwd, h.root);
  assert.match(h.agents.get(cleared.lead!)!.prompt!, /clears the way for L1/);
  h.commit(cleared.worktree!, "money.ts", "export type Money = bigint;\n");
  assert.equal((await h.call(sup, "supervisor", "land_lane", { lane: "L2" })).ok, true);
  await h.idle(waiting.lead!);
  assert.match(
    h.agents.get(waiting.lead!)!.sent.join("\n"),
    /CLEARED L2[\s\S]*Next: Read what it did before you go on; ask if your work needs it on your branch\./,
  );

  await h.call(sup, "supervisor", "open_lane", { ...money, detourOf: "L1" });
  assert.equal(
    (await h.call(sup, "supervisor", "drop_lane", { lane: "L3", reason: "the float stays for now" })).ok,
    true,
  );
  await h.idle(waiting.lead!);
  const told = h.agents.get(waiting.lead!)!.sent.join("\n");
  assert.match(
    told,
    /DETOUR DROPPED L3 \(Money type\), the detour your lane L1 was waiting on: it closed without landing, and its branch lane\/l3-money-type is kept\.\n\nNext: Go on without it; ask if your lane still needs what it was for\./,
  );
  assert.doesNotMatch(told, /CLEARED L3/);
});

test("a Lead's directive says what its lane writes, depends on and keeps to one writer, how the project gates, and where the Human's concept is", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const open = (title: string, extra: Record<string, unknown> = {}) =>
    h.call(sup, "supervisor", "open_lane", lane(title, { isolate: true, ...extra }));
  const directive = (id: string) => h.agents.get(h.ledger().lanes[id]!.lead!)!.prompt ?? "";
  h.commit(h.root, "package.json", JSON.stringify({ scripts: { test: "echo ran" } }));
  assert.match((await h.call(sup, "supervisor", "set_project", { gate: "" })).text, /gate none/);
  assert.match((await open("Off", { writeSet: ["f.txt"] })).text, /Gate: none set, by this project's own choice/);
  assert.match((await h.call(sup, "supervisor", "set_project", {})).text, /gate none/);
  assert.match(
    (await h.call(sup, "supervisor", "set_project", { gate: "npm test" })).text,
    /gate npm test, run per task/,
  );
  await open("Build", { writeSet: ["a.txt", "package-lock.json"], contracts: ["b.txt"] });
  const build = directive("L2");
  assert.match(
    build,
    /^Writes: a\.txt, package-lock\.json\. A change outside these is noted at hand-back and at landing; if the work needs more, ask with kind need\.$/m,
  );
  assert.match(build, /^Depends on: b\.txt, which this lane uses and does not write\.$/m);
  assert.match(
    build,
    /^One writer at a time: package-lock\.json\. A task that writes any of these works in the lane's working copy, not in parallel\.$/m,
  );
  assert.match(
    build,
    /^Gate: npm test runs on every task with the lane brought in, and its verdict reaches the Lead with the hand-back; the lane takes a task red only when its Lead accepts it over the gate with a reason$/m,
  );
  assert.match(
    build,
    /^Lane branch: lane\/l2-build, off main\. Your working copy is on it save while a task works there on a branch of its own; tasks merge into it\.$/m,
  );

  await h.call(sup, "supervisor", "set_project", { gateOn: "lane" });
  await open("Copy", { writeSet: ["c.txt"] });
  assert.match(
    directive("L3"),
    /^Gate: npm test runs on the whole lane when you report it ready; merges are not gated, so the lane branch can break between reports$/m,
  );
  const loose = await open("Loose");
  assert.equal(loose.ok, true, loose.text);
  assert.match(
    loose.text,
    /It opened beside lanes that may write what it does: L2 \(package-lock\.json\)\. Their Leads and its own are told/,
  );
  assert.match(directive("L4"), /^Writes: not declared\.$/m);
  assert.match(
    directive("L4"),
    /^Open beside it and may write the same: L2 \(package-lock\.json\)\. What both write meets when the second of you merges or lands, and the Supervisor chooses who settles it then\.$/m,
  );
  assert.match(
    h.heard(h.ledger().lanes.L2!.lead!).join("\n"),
    /LANE BESIDE L4 \(Loose\) works beside your lane and may write what yours does: package-lock\.json\./,
  );
  assert.doesNotMatch(directive("L3"), /Open beside it/);

  const concept = join(h.project.state, "CONTEXT.md");
  assert.equal(existsSync(concept), false);
  for (const id of ["L1", "L2", "L3", "L4"]) assert.doesNotMatch(directive(id), /CONTEXT\.md/);
  writeFileSync(concept, "# Shop\n\n## Behavior\n\n- A guest may check out.\n");
  await open("Guests", { writeSet: ["d.txt"] });
  const pointed = directive("L5");
  assert.match(
    pointed,
    new RegExp(`is in ${concept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Read it before you start`),
  );
  assert.match(pointed, /ask with kind question, and leave the file as it is/);
  assert.match(
    pointed,
    /Peers never see the file: quote into each task's context, word for word, the lines that task touches, so the quote is all a Peer needs\./,
    "a Peer's brief names the Human's word it needs, never a file it cannot reach",
  );

  await h.call(sup, "supervisor", "set_project", { serialOnly: ["b.txt"] });
  await open("Own list", { writeSet: ["e.txt"] });
  assert.match(
    directive("L6"),
    /^One writer at a time: b\.txt\. A task that writes any of these works in the lane's working copy, not in parallel\.$/m,
  );
  assert.doesNotMatch(directive("L6"), /package-lock/);

  // Where git cannot list what a copy holds, every one-writer rule counts, rather than none.
  const bin = tempDir("sw3-git-");
  const real = h.git(h.root, "--exec-path").trim();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncase " $* " in *" ls-files "*) echo "fatal: index file corrupt" >&2; exit 128;; esac\nexec "${real}/git" "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  await h.call(sup, "supervisor", "set_project", { serialOnly: ["b.txt", "vendor/**"] });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    await open("Blind", { writeSet: ["g.txt"] });
  } finally {
    process.env.PATH = path;
  }
  assert.match(
    directive("L7"),
    /^One writer at a time: b\.txt, vendor\/\*\*\. A task that writes any of these works in the lane's working copy, not in parallel\.$/m,
  );
});

test("the Supervisor's status names the Human's uncommitted files as they are: a space in a name, and a rename by where it went", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", { base: "main", gate: "true" });
  writeFileSync(join(h.root, "my notes.txt"), "half done\n");
  h.git(h.root, "mv", "a.txt", "moved -> here.txt");
  const status = (await h.call(sup, "supervisor", "status", {})).text;
  assert.match(status, /with 2 uncommitted files: moved -> here\.txt, my notes\.txt\./);
});

test("the Human's own words a lane comes from reach its Lead beside the Supervisor's reading of them, and only words they wrote", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const said = "Guests should check out without making an account, but keep the order history for members.";
  h.humanSays(sup, said);
  const opened = await h.call(
    sup,
    "supervisor",
    "open_lane",
    lane("Guests", { isolate: true, outcome: "guest checkout", humanSaid: "check out without making an account" }),
  );
  assert.equal(opened.ok, true, opened.text);
  const directive = h.agents.get(h.ledger().lanes.L1!.lead!)!.prompt ?? "";
  assert.match(
    directive,
    /^Outcome: guest checkout\n\nThe Human's own words it comes from, which the outcome above reads: "check out without making an account"$/m,
  );
  const guessed = await h.call(
    sup,
    "supervisor",
    "open_lane",
    lane("Members", { isolate: true, humanSaid: "members want a faster order history page" }),
  );
  assert.equal(guessed.ok, true, guessed.text);
  assert.match(
    guessed.text,
    /humanSaid is no message the Human wrote in your chat, so the Lead was not given it as theirs/,
  );
  assert.doesNotMatch(h.agents.get(h.ledger().lanes.L2!.lead!)!.prompt ?? "", /own words/);
});
