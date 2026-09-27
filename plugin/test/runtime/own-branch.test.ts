import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../tempdir.ts";
import { harness, laneWithPeer } from "./harness.ts";

type Harness = ReturnType<typeof harness>;

const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
const onBranch = (h: Harness, cwd: string) => h.git(cwd, "branch", "--show-current").trim();
const has = (h: Harness, cwd: string, ref: string, file: string) =>
  h.git(cwd, "ls-tree", "--name-only", ref, file).trim() === file;
const oneTask = (key: string, title: string, extra: Record<string, unknown> = {}) => ({
  tasks: [{ key, title, goal: "g", ...scope, ...extra }],
});

test("a task in the lane's copy works on a branch of its own, and the lane branch takes its work only by its merge", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  const copy = lane.worktree!;
  const own = h.ledger().tasks["L1-T1"]!.branch!;
  const brief = (id: string) => h.agents.get(h.ledger().tasks[id]!.peer!)!.prompt ?? "";
  assert.match(own, /^task\/l1-t1-/);
  assert.equal(onBranch(h, copy), own);
  await h.call(lead, "lead", "start_review", { focus: "Is the lane sound?" });
  const tip = h.git(h.root, "rev-parse", "--short=7", lane.branch).trim();
  assert.ok(
    brief("L1-R1").includes(
      `\n\nYour working copy holds ${lane.branch} at ${tip}. Read whatever the question needs.\n`,
    ),
    "the lane as its branch has it, not the task at work in the lane's copy",
  );
  await h.call(lead, "lead", "cut", { task: "L1-R1", reason: "not now" });
  assert.equal(
    (await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).text,
    `Lane L1 was not closed: its working copy is on ${own}, L1-T1's branch, not ${lane.branch}. Land it once L1-T1 is merged or cut.`,
  );
  assert.equal(h.ledger().lanes.L1!.status, "open");

  await h.call(lead, "lead", "add_tasks", oneTask("s", "Side", { holds: ["c.txt"], parallel: true }));
  const side = h.ledger().tasks["L1-T2"]!;
  writeFileSync(join(copy, "a.txt"), "being written\n");
  h.commit(side.worktree!, "c.txt", "C\n");
  await h.call(side.peer!, "peer", "done", { outcome: "complete", summary: "c" });
  h.agents.get(side.peer!)!.status = "idle";
  await h.call(lead, "lead", "accept", { task: "L1-T2" });
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks["L1-T2"]!.status, "merged");
  assert.equal(has(h, copy, lane.branch, "c.txt"), true);
  assert.equal(readFileSync(join(copy, "a.txt"), "utf-8"), "being written\n");
  assert.equal(onBranch(h, copy), own);

  h.git(copy, "checkout", "-q", "--detach", "HEAD");
  h.commit(copy, "a.txt", "fixed at the source\n");
  const handed = await h.call(peer, "peer", "done", { outcome: "complete", summary: "found and fixed it" });
  assert.equal(handed.ok, true);
  assert.match(handed.text, new RegExp(`not on ${own} any more`));
  assert.match(handed.text, /git bisect reset takes it back[^]*left it some other way, say so with ask/);
  h.agents.get(peer)!.status = "idle";
  const detached = await h.call(lead, "lead", "accept", { task: "L1-T1" });
  assert.equal(detached.ok, false);
  assert.match(
    detached.text,
    /nothing committed in it is on its branch[^]*git bisect reset[^]*some other way[^]*raise it with ask/,
  );
  assert.equal(h.git(copy, "show", `${lane.branch}:a.txt`), "one\ntwo\nthree\n");

  h.git(copy, "switch", "-q", own);
  h.commit(copy, "new.txt", "new\n");
  writeFileSync(join(copy, "a.txt"), "left behind\n");
  assert.equal(
    (await h.call(lead, "lead", "accept", { task: "L1-T1" })).text,
    "L1-T1's working copy has work uncommitted (M a.txt): send rework asking its Peer to commit what belongs to it, then accept it again.",
  );
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "done");
  h.git(copy, "checkout", "--", "a.txt");
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T1" })).ok, true);
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "merged");
  assert.equal(h.git(copy, "log", "-1", "--format=%s", lane.branch).trim(), "Merge L1-T1: Clean build");
  assert.equal(onBranch(h, copy), lane.branch);
  assert.equal(h.git(copy, "status", "--porcelain").trim(), "");

  assert.equal((await h.call(lead, "lead", "cut", { task: "L1-T1", reason: "late" })).text, "L1-T1 is already merged.");
  assert.equal(
    (await h.call(peer, "peer", "done", { outcome: "complete", summary: "again" })).text,
    "This task is already merged; there is nothing to hand back.",
  );
  writeFileSync(join(copy, "a.txt"), "someone's\n");
  assert.equal(
    (await h.call(lead, "lead", "rework", { task: "L1-T1", text: "fix it" })).text,
    "The lane's working copy has work uncommitted (M a.txt), so L1-T1 cannot go back onto its branch there. That copy is the project's own, so what is left there is likely the Human's: ask, and send L1-T1 back once it is committed or put away.",
  );
  h.git(copy, "checkout", "--", "a.txt");
  assert.equal((await h.call(lead, "lead", "rework", { task: "L1-T1", text: "fix it" })).ok, true);
  assert.equal(onBranch(h, copy), own);
  assert.equal(has(h, copy, "HEAD", "new.txt"), true);
});

test("a task in the lane's copy that waits on its Lead, fails to merge, is cut or never starts keeps the copy to itself, and leaves it on the lane branch with no empty branch behind", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Two in a row", outcome: "a and b change", ...scope });
  const lane = h.ledger().lanes.L1!;
  const lead = lane.lead!;
  const copy = lane.worktree!;
  const add = (key: string, title: string, extra: Record<string, unknown> = {}) =>
    h.call(lead, "lead", "add_tasks", oneTask(key, title, extra));
  const paseo = h.paseo as {
    workspaces: { ref: (id: string) => { agents: { create: (options: unknown) => unknown } } };
  };
  const ref = paseo.workspaces.ref;
  paseo.workspaces.ref = (id) => ({ ...ref(id), agents: { create: () => Promise.reject(new Error("no seat today")) } });
  assert.match((await add("x", "Unstarted", { hints: ["a.txt"] })).text, /The Peer could not start: no seat today/);
  paseo.workspaces.ref = ref;
  assert.equal(onBranch(h, copy), lane.branch);
  assert.equal(h.git(h.root, "branch", "--list", h.ledger().tasks["L1-T1"]!.branch!).trim(), "");
  await h.call(lead, "lead", "cut", { task: "L1-T1", reason: "never started" });

  await add("a", "A", { hints: ["a.txt"] });
  const first = h.ledger().tasks["L1-T2"]!;
  h.commit(copy, "a.txt", "A\n");
  await h.call(first.peer!, "peer", "done", { outcome: "complete", summary: "a" });
  h.agents.get(first.peer!)!.status = "idle";
  assert.match(
    (await add("b", "B", { hints: ["b.txt"] })).text,
    /L1-T3 B: held: L1-T2 has handed back and is waiting on you/,
  );
  assert.equal(h.ledger().tasks["L1-T3"]!.peer, undefined);
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T2" })).ok, true);
  await h.runtime.desk.settled(h.project);
  const second = h.ledger().tasks["L1-T3"]!;
  assert.equal(second.status, "running");
  await add("c", "C", { holds: ["c.txt"], parallel: true });
  writeFileSync(join(copy, "b.txt"), "half\n");
  assert.equal((await h.call(lead, "lead", "rework", { task: "L1-T4", text: "again" })).ok, true);

  h.commit(copy, "b.txt", "B\n");
  await h.call(second.peer!, "peer", "done", { outcome: "complete", summary: "b" });
  h.agents.get(second.peer!)!.status = "idle";
  await add("d", "D", { hints: ["d.txt"] });
  const elsewhere = join(tempDir("sw3-elsewhere-"), "wt");
  h.git(h.root, "worktree", "add", "-q", elsewhere, lane.branch);
  await h.call(lead, "lead", "accept", { task: "L1-T3" });
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks["L1-T3"]!.status, "failed");
  await h.tick();
  assert.equal(h.ledger().tasks["L1-T5"]!.peer, undefined);
  assert.equal(onBranch(h, copy), second.branch);

  h.git(h.root, "worktree", "remove", "--force", elsewhere);
  const before = h.git(copy, "rev-parse", lane.branch).trim();
  writeFileSync(join(copy, "a.txt"), "half done\n");
  const cut = await h.call(lead, "lead", "cut", { task: "L1-T3", reason: "wrong approach" });
  assert.ok(
    cut.text.includes(
      `The lane's working copy is back on ${lane.branch}. Its branch ${second.branch} holds commits nothing else has and is kept.`,
    ),
    cut.text,
  );
  assert.equal(h.git(copy, "rev-parse", lane.branch).trim(), before);
  assert.equal(readFileSync(join(copy, "a.txt"), "utf-8"), h.git(copy, "show", `${lane.branch}:a.txt`));
});

/** A lane with its first task at work in the lane's copy: the project's, one of its own, or the Human's fix/login with their edit to b.txt uncommitted. */
async function taskInCopy(where: "own" | "isolate" | "theirs") {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  if (where === "theirs") {
    h.git(h.root, "switch", "-qc", "fix/login");
    writeFileSync(join(h.root, "b.txt"), "bee, still being edited\n");
  }
  const home = where === "theirs" ? { onBranch: true } : { isolate: where === "isolate" };
  await h.call(sup, "supervisor", "open_lane", { title: "Finish", outcome: "x", ...scope, ...home });
  const lane = h.ledger().lanes.L1!;
  await h.call(lane.lead!, "lead", "add_tasks", oneTask("t", "Work"));
  return { h, sup, lane, task: h.ledger().tasks["L1-T1"]! };
}

type Closing = {
  where: "own" | "isolate" | "theirs";
  close: "drop" | "cut";
  busy?: boolean;
  commits?: boolean;
  dirty?: boolean;
  said?: (branch: string, slot?: string) => RegExp;
};

const closings: Closing[] = [
  { where: "own", close: "drop" },
  { where: "own", close: "drop", commits: true },
  { where: "own", close: "drop", busy: true },
  { where: "isolate", close: "drop" },
  {
    where: "isolate",
    close: "drop",
    busy: true,
    said: (branch, slot) => new RegExp(`Its working copy ${slot} stays with its Lead, still on ${branch}\\.`),
  },
  { where: "theirs", close: "cut", busy: true },
  { where: "theirs", close: "drop", said: () => /The project's own copy is back on fix\/login\./ },
  { where: "theirs", close: "drop", busy: true },
  {
    where: "theirs",
    close: "cut",
    dirty: true,
    said: () => /The lane's working copy could not go back on fix\/login: [^]*a\.txt/,
  },
  {
    where: "theirs",
    close: "drop",
    dirty: true,
    said: (branch) =>
      new RegExp(
        `The project's own copy is still on ${branch}: git would not take it to fix/login as it stands, and each round tries again\\.`,
      ),
  },
];

test("a lane closed or a task cut while a task holds the lane's copy puts that copy back once nobody writes there, keeping the Human's work and any branch with commits of its own", async () => {
  for (const row of closings) {
    const { h, sup, lane, task } = await taskInCopy(row.where);
    const copy = lane.worktree!;
    const where = JSON.stringify(row);
    if (row.commits) h.commit(copy, "new.txt", "new\n");
    if (row.dirty) {
      h.commit(copy, "a.txt", "the task's\n");
      writeFileSync(join(copy, "a.txt"), "the task's, and more\n");
    }
    h.agents.get(lane.lead!)!.status = "idle";
    if (!row.busy) h.agents.get(task.peer!)!.status = "idle";
    const said =
      row.close === "cut"
        ? await h.call(lane.lead!, "lead", "cut", { task: "L1-T1", reason: "wrong" })
        : await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "not wanted" });
    assert.equal(said.ok, true, `${where}: ${said.text}`);
    if (row.said) assert.match(said.text, row.said(task.branch!, lane.slot), where);
    if (!row.dirty)
      assert.equal(
        said.text.includes(`${task.branch} holds commits nothing else has and is kept`),
        Boolean(row.commits),
      );
    const home = row.where === "own" ? "main" : row.where === "theirs" ? "fix/login" : lane.branch;
    const waits = row.busy && row.close === "drop";
    assert.equal(onBranch(h, copy), row.dirty || waits ? task.branch : home, where);
    if (waits) {
      h.agents.get(task.peer!)!.status = "idle";
      await h.endTurn(task.peer!, "done");
      if (row.where === "isolate") {
        assert.equal((await h.call(sup, "supervisor", "release", { lane: "L1" })).ok, true);
        assert.equal(existsSync(copy), false, where);
      } else assert.equal(onBranch(h, copy), home, where);
    }
    const kept = h.git(h.root, "branch", "--list", task.branch!).trim() !== "";
    assert.equal(kept, Boolean(row.commits || row.dirty), where);
    if (row.where === "theirs")
      assert.equal(readFileSync(join(h.root, "b.txt"), "utf-8"), "bee, still being edited\n", where);
    if (row.dirty) assert.equal(readFileSync(join(h.root, "a.txt"), "utf-8"), "the task's, and more\n", where);
  }
});
