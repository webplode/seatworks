import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../tempdir.ts";
import { harness, laneWithPeer } from "./harness.ts";

type Harness = ReturnType<typeof harness>;

const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
const heard = (h: Harness, id: string) => h.heard(id).join("\n");
/** What the Lead was told from the first letter headed `head` on. */
const after = (h: Harness, lead: string, head: string) => heard(h, lead).split(head)[1] ?? "";

/** A task beside others added under `lead`, with `file` committed in its copy and handed back. */
async function handedBack(h: Harness, lead: string, title: string, holds: string, file = holds) {
  const added = await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title, goal: "g", ...scope, holds: [holds], parallel: true }],
  });
  assert.equal(added.ok, true, added.text);
  const task = Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
  mkdirSync(dirname(join(task.worktree!, file)), { recursive: true });
  h.commit(task.worktree!, file, `${file}\n`);
  assert.equal((await h.call(task.peer!, "peer", "done", { outcome: "complete", summary: title })).ok, true);
  await h.idle(task.peer!);
  return h.ledger().tasks[task.id]!;
}

/** The Lead's accept, and the merge queue gone quiet after it. */
async function accept(h: Harness, lead: string, id: string, over: Record<string, unknown> = {}) {
  const reply = await h.call(lead, "lead", "accept", { task: id, ...over });
  await h.runtime.desk.settled(h.project);
  return reply;
}

test("a task that goes red with its lane brought in stays out until its Lead accepts it over the gate, with a reason", async () => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  await h.call(sup, "supervisor", "set_project", { gate: "test ! -f x.txt || test ! -f y.txt", gateOn: "task" });
  // Each green alone and red together, both handed back before either merges.
  await handedBack(h, lead, "Ex", "x.txt");
  const why = await handedBack(h, lead, "Why", "y.txt");
  assert.equal((await accept(h, lead, "L1-T2")).ok, true);
  assert.equal(h.ledger().tasks["L1-T2"]!.status, "merged");
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "z", title: "Zed", goal: "g", ...scope, holds: ["z.txt"], parallel: true }],
  });
  assert.equal(
    (await accept(h, lead, "L1-T4")).text,
    "L1-T4 is not handed back: accept it once its Peer hands it back, or cut it.",
    "what it merges is what was gated",
  );
  assert.equal(h.ledger().tasks["L1-T4"]!.status, "running");

  assert.equal((await accept(h, lead, "L1-T3")).ok, true);
  assert.equal(h.ledger().tasks["L1-T3"]!.status, "done", "back with its Lead, not merged");
  assert.deepEqual(
    h.events("merge.red").map((event) => event.task),
    ["L1-T3"],
    "the record says the gate stopped it",
  );
  assert.throws(() => h.git(lane.worktree!, "show", `${lane.branch}:y.txt`), "the lane branch never took the red tree");
  assert.equal(h.git(why.worktree!, "show", "HEAD:x.txt"), "x.txt\n", "its copy holds the tree the lane would become");
  assert.match(
    heard(h, lead),
    new RegExp(
      `MERGE RED L1-T3 \\(Why\\): the gate failed on its branch with ${lane.branch} brought in, the tree the lane would become\\. The lane branch is unchanged\\.\\n[^]*Next: Send rework to its Peer with what must change, or accept it again with overGate and a reason to merge it over the gate\\.`,
    ),
  );

  const refused = await accept(h, lead, "L1-T3");
  assert.equal(refused.ok, false);
  assert.match(
    refused.text,
    /^L1-T3's gate is red on the tree the lane would become: send it back with rework, or accept it with overGate and a reason to merge it over the gate\./,
  );
  assert.match((await accept(h, lead, "L1-T3", { overGate: true })).text, /Say why in reason/);
  const reason = "y replaces x next task";
  assert.equal((await accept(h, lead, "L1-T3", { overGate: true, reason })).ok, true);
  assert.equal(h.ledger().tasks["L1-T3"]!.status, "merged");
  assert.equal(h.git(lane.worktree!, "show", `${lane.branch}:y.txt`), "y.txt\n");
  assert.match(
    after(h, lead, "MERGED L1-T3"),
    /Gate: ran on this task: test ! -f x\.txt \|\| test ! -f y\.txt: the gate failed with exit 1; the same gate on [^\n]*, passes — merged over it: y replaces x next task/,
  );
  assert.ok(h.events("gate.overridden").some((event) => event.task === "L1-T3" && event.reason === reason));

  // Standing orders that cannot be read are not a project without a gate: nothing is handed back as if it had none.
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "e", title: "Early", goal: "g", ...scope, holds: ["e.txt"], parallel: true }],
  });
  const early = Object.values(h.ledger().tasks).find((task) => task.title === "Early")!;
  h.commit(early.worktree!, "e.txt", "e\n");
  const orders = join(h.project.state, "project.json");
  writeFileSync(orders, "{not json");
  const unread = await h.call(early.peer!, "peer", "done", { outcome: "complete", summary: "e" });
  assert.equal(unread.ok, false, unread.text);
  assert.match(unread.text, /project\.json is there but could not be read[^]*Nothing was written over it/);
  assert.equal(readFileSync(orders, "utf-8"), "{not json");
});

test("what the gate did reaches the Lead: with the hand-back, when its verdict is used again, and with each merge", async () => {
  const runs = join(tempDir("sw3-gate-runs-"), "runs");
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const gate = (settings: Record<string, unknown>) => h.call(sup, "supervisor", "set_project", settings);
  await gate({ gate: "test ! -f BROKEN", gateOn: "task" });
  await h.call(sup, "supervisor", "open_lane", {
    title: "Numbers",
    outcome: "a.txt gains words",
    acceptance: ["four"],
    outOfScope: ["anything else"],
  });
  const lane = h.ledger().lanes.L1!;
  const lead = lane.lead!;
  /** A task in the lane's copy, committing `text` to a.txt unless it finds nothing needed changing. */
  const inLane = async (title: string, text?: string) => {
    await h.call(lead, "lead", "add_tasks", { tasks: [{ key: "t", title, goal: "g", ...scope, hints: ["a.txt"] }] });
    const task = Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
    if (text) h.commit(lane.worktree!, "a.txt", text);
    const summary = text ? "four" : "nothing needed changing: the parser already handles it";
    assert.equal((await h.call(task.peer!, "peer", "done", { outcome: "complete", summary })).ok, true);
    await h.idle(task.peer!);
    assert.equal((await accept(h, lead, task.id)).ok, true);
    return h.ledger().tasks[task.id]!;
  };

  // The default path, in the lane's copy, is the one where the task gate used to be skipped in silence.
  await inLane("Add four", "one\ntwo\nthree\nfour\n");
  assert.match(
    heard(h, lead),
    /Gate: test ! -f BROKEN passed in/,
    "the Lead is told what the gate did, not what it would do",
  );
  assert.match(after(h, lead, "MERGED L1-T1"), /Gate: ran on this task: test ! -f BROKEN passed in/);
  assert.doesNotMatch(heard(h, lead), /Gate: runs on the whole lane/);
  const nothing = await inLane("Check the parser");
  assert.equal(
    nothing.status,
    "merged",
    "the Lead judges the hand-back; the desk does not decide no diff means no work",
  );
  assert.match(after(h, lead, "MERGED L1-T2"), /changed no files/, "the letter says plainly that nothing moved");

  await gate({ gate: `echo run >> ${runs}` });
  const reused = await handedBack(h, lead, "Side", "c.txt");
  await accept(h, lead, reused.id);
  assert.equal(h.ledger().tasks[reused.id]!.status, "merged");
  assert.equal(
    readFileSync(runs, "utf-8"),
    "run\n",
    "its lane had not moved since its hand-back, so the gate ran once",
  );

  await gate({ gate: "echo red; exit 1" });
  const red = await handedBack(h, lead, "B", "b.txt");
  assert.match(
    after(h, lead, `HANDBACK ${red.id}`),
    /Gate: echo red; exit 1: the gate failed with exit 1; the same gate on [^\n]*, fails too\. The lane takes it red only if you accept it over the gate with a reason\./,
  );
  assert.equal((await accept(h, lead, red.id)).ok, false);
  assert.equal(
    (await accept(h, lead, red.id, { overGate: true, reason: "the gate is broken, not the task" })).ok,
    true,
  );
  assert.equal(h.ledger().tasks[red.id]!.status, "merged", "accepted over the gate with a reason, it lands");
  assert.match(h.git(lane.worktree!, "log", "-1", "--format=%s"), new RegExp(`^Merge ${red.id}`));

  await gate({ gate: "true", gateOn: "lane" });
  const ungated = await handedBack(h, lead, "Tail", "d.txt");
  await accept(h, lead, ungated.id);
  assert.match(
    after(h, lead, `MERGED ${ungated.id}`),
    /Gate: not run on merges, so the lane branch can break between reports; it runs on the whole lane when you report it ready/,
  );
});

test("a change a risk rule reaches is rehearsed with its gate, and a red rehearsal keeps it out as a red gate does", async () => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  const rules = (gate: string, rehearse: string, invariant = "running it twice changes nothing") =>
    h.call(sup, "supervisor", "set_project", {
      gate,
      riskRules: [{ paths: ["db/**"], invariant, reviewQuestion: "What does a second run do?", rehearse }],
    });
  const cut = (id: string) => h.call(lead, "lead", "cut", { task: id, reason: "rehearsed" });

  await rules("false", "true");
  const first = await handedBack(h, lead, "Migrate", "db/", "db/001.sql");
  assert.deepEqual(
    [first.handback!.gate!.ok, first.handback!.gate!.note],
    [
      false,
      `false: the gate failed with exit 1; the same gate on ${lane.branch} at ${h.git(h.root, "rev-parse", "--short=7", lane.branch).trim()}, in a copy made as a task's is, fails too`,
    ],
    "a red gate stays red whatever the rehearsals after it would say, and they do not run",
  );
  await cut(first.id);

  await rules("true", "false");
  const migrate = await handedBack(h, lead, "M", "db/", "db/001.sql");
  const copy = await handedBack(h, lead, "Copy", "c.txt");
  assert.match(
    after(h, lead, `HANDBACK ${migrate.id}`),
    /Gate: true passed in \d+s; false, rehearsing that running it twice changes nothing, failed with exit 1/,
  );
  assert.doesNotMatch(
    after(h, lead, `HANDBACK ${copy.id}`),
    /rehearsing/,
    "a change the rule does not reach is not rehearsed",
  );
  assert.match((await accept(h, lead, migrate.id)).text, /^L1-T\d+'s gate is red on the tree the lane would become/);
  await cut(migrate.id);

  await rules("true", 'test -z "$(ls db | cut -c1-3 | sort | uniq -d)"', "no two migrations share a number");
  const [a, b] = [
    await handedBack(h, lead, "Add a", "db/001-a.sql"),
    await handedBack(h, lead, "Add b", "db/001-b.sql"),
  ];
  assert.deepEqual([a.handback!.gate!.ok, b.handback!.gate!.ok], [true, true], "each is green alone");
  await accept(h, lead, a.id);
  await accept(h, lead, b.id);
  assert.equal(h.ledger().tasks[b.id]!.status, "done", "rehearsed together at merge, the second is kept out");
  assert.match(
    heard(h, lead),
    /MERGE RED L1-T\d+ \(Add b\)[^]*rehearsing that no two migrations share a number, failed with exit 1/,
  );
});

test("a task's red gate comes with the same gate on its lane's tip, in a copy made as a task's is, run once for each tip", async () => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  const runs = join(tempDir("sw3-tip-runs-"), "runs");
  await h.call(sup, "supervisor", "set_project", { gate: `echo run >> '${runs}'; test ! -f BROKEN`, gateOn: "task" });
  const tip = () => h.git(h.root, "rev-parse", "--short=7", lane.branch).trim();
  await handedBack(h, lead, "Breaks", "BROKEN");
  assert.match(
    after(h, lead, "HANDBACK L1-T2"),
    new RegExp(
      `Gate: [^\\n]*the gate failed with exit 1; the same gate on ${lane.branch} at ${tip()}, in a copy made as a task's is, passes\\.`,
    ),
  );
  h.commitTo(lane.branch, "BROKEN", "on the lane\n");
  await handedBack(h, lead, "Beside", "c.txt");
  await handedBack(h, lead, "Again", "d.txt");
  for (const id of ["L1-T3", "L1-T4"])
    assert.match(
      after(h, lead, `HANDBACK ${id}`),
      new RegExp(`the same gate on ${lane.branch} at ${tip()}, in a copy made as a task's is, fails too\\.`),
    );
  assert.equal(
    readFileSync(runs, "utf-8").split("\n").filter(Boolean).length,
    5,
    "the tip's run is kept for its commit",
  );
  assert.deepEqual(
    h.git(h.root, "worktree", "list", "--porcelain").match(/^worktree .*tip-.*$/gm),
    null,
    "and the copy it ran in is gone",
  );
});

test("no more gates run at once than the machine's gatesAtOnce, the rest waiting their turn", async () => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  h.machineSettings({ gatesAtOnce: 1 });
  // Red when another gate runs beside it: the second mkdir finds the first one's folder.
  const busy = join(tempDir("sw3-gates-at-once-"), "busy");
  await h.call(sup, "supervisor", "set_project", {
    gate: `mkdir '${busy}' && sleep 0.3 && rmdir '${busy}'`,
    gateOn: "task",
  });
  const tasks = [];
  for (const [title, file] of [
    ["One", "c.txt"],
    ["Two", "d.txt"],
  ] as const) {
    await h.call(lead, "lead", "add_tasks", {
      tasks: [{ key: title, title, goal: "g", ...scope, holds: [file], parallel: true }],
    });
    const task = Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
    h.commit(task.worktree!, file, `${file}\n`);
    tasks.push(task);
  }
  const handed = await Promise.all(
    tasks.map((task) => h.call(task.peer!, "peer", "done", { outcome: "complete", summary: task.title })),
  );
  assert.deepEqual(
    handed.map((reply) => reply.ok),
    [true, true],
  );
  assert.deepEqual(
    tasks.map((task) => h.ledger().tasks[task.id]!.handback!.gate!.ok),
    [true, true],
    "each gate ran alone",
  );
});
