import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stateRoot } from "../../server/core/paths.ts";
import { saveLedger } from "../../server/desk/store/ledger.ts";
import { reported } from "../console.ts";
import { tempDir } from "../tempdir.ts";
import { settle } from "./fake-timeline.ts";
import { harness, laneWithPeer, nobodySeated } from "./harness.ts";

/** Whether `check` comes true within `ms`, looked at every 20 ms. */
async function within(ms: number, check: () => boolean): Promise<boolean> {
  for (const end = Date.now() + ms; !check(); await new Promise((resolve) => setTimeout(resolve, 20)))
    if (Date.now() > end) return false;
  return true;
}

test("merges a stop left go through once each, in turn, when the plugin starts again", async () => {
  const { h, sup, lane } = await laneWithPeer();
  const lead = lane.lead!;
  // Counted on the lane branch: L1-T1 has the lane's copy on its own branch meanwhile.
  const merges = () => Number(h.git(lane.worktree!, "rev-list", "--merges", "--count", lane.branch).trim());
  const status = (id: string) => h.ledger().tasks[id]!.status;
  /** A task beside others, with its file committed in its own copy and handed back, ready to be merged. */
  const handedBack = async (title: string, file: string) => {
    await h.call(lead, "lead", "add_tasks", {
      tasks: [
        { key: "t", title, goal: "g", acceptance: ["a"], holds: [file], outOfScope: ["the rest"], parallel: true },
      ],
    });
    const task = Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
    h.commit(task.worktree!, file, `${title}\n`);
    assert.equal((await h.call(task.peer!, "peer", "done", { outcome: "complete", summary: title })).ok, true);
    return task;
  };
  /** Accepted, and the plugin stopped with its merge `where` the queue had it: no path in one run stops there. */
  const stopped = (id: string, where: "queued" | "merging") => {
    const ledger = h.ledger();
    Object.assign(ledger.tasks[id]!, { status: where, acceptedAt: Date.now() });
    saveLedger(h.project.state, ledger);
  };
  const started = async () => {
    h.restart();
    await h.tick();
    await h.runtime.desk.settled(h.project);
  };

  // First, while nothing has merged into the lane yet, so its tip is no merge at all.
  const cut = await handedBack("One", "c.txt");
  stopped(cut.id, "merging");
  await started();
  assert.deepEqual(
    [status(cut.id), merges()],
    ["merged", 1],
    "stopped before the lane moved, it runs again from the start",
  );

  const first = await handedBack("Two", "d.txt");
  h.restart();
  // Accepted before the first round, so its merge is under way when the queue is taken up.
  assert.equal((await h.call(lead, "lead", "accept", { task: first.id })).ok, true);
  await h.runtime.desk.resumeMerges(h.project);
  await h.runtime.desk.settled(h.project);
  assert.deepEqual([status(first.id), merges()], ["merged", 2], "the merges a stop left wait behind it");

  const queued = await handedBack("Three", "e.txt");
  stopped(queued.id, "queued");
  await started();
  assert.equal(status(queued.id), "merged");
  assert.equal(h.git(lane.worktree!, "show", `${lane.branch}:e.txt`), "Three\n");
  assert.match(h.heard(lead).join("\n"), new RegExp(`MERGED ${queued.id}`));

  const landed = await handedBack("Four", "f.txt");
  const before = h.git(lane.worktree!, "rev-parse", lane.branch).trim();
  const made = h
    .git(
      lane.worktree!,
      "commit-tree",
      `${landed.branch}^{tree}`,
      "-p",
      before,
      "-p",
      landed.branch!,
      "-m",
      `Merge ${landed.id}`,
    )
    .trim();
  h.git(lane.worktree!, "update-ref", `refs/heads/${lane.branch}`, made, before);
  stopped(landed.id, "merging");
  await started();
  assert.deepEqual([status(landed.id), merges()], ["merged", 4], "stopped after the lane moved, it is only finished");
  assert.match(h.heard(lead).join("\n"), new RegExp(`MERGED ${landed.id}`));

  const held = await handedBack("Five", "g.txt");
  await h.call(sup, "supervisor", "hold_lane", { lane: "L1", reason: "a page came in" });
  stopped(held.id, "queued");
  await started();
  assert.equal(status(held.id), "queued", "nothing lands in a lane on hold");
  await h.call(sup, "supervisor", "resume_lane", { lane: "L1" });
  await h.runtime.desk.settled(h.project);
  assert.equal(status(held.id), "merged");

  const alone = await handedBack("Six", "h.txt");
  stopped(alone.id, "queued");
  nobodySeated(h);
  await started();
  assert.equal(status(alone.id), "merged", "the first round takes them up even with nobody seated");
});

/** Whether a process of that id still runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a gate running when the plugin stops is stopped with it, not left writing into the copy", async (t) => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const pidFile = join(tempDir("sw3-gate-"), "pid");
  await h.call(sup, "supervisor", "set_project", { gate: `echo $$ > ${pidFile}; exec sleep 30`, gateOn: "task" });
  h.commit(lane.worktree!, "a.txt", "A\n");
  const handing = h.call(peer, "peer", "done", { outcome: "complete", summary: "done" });
  assert.ok(await within(5000, () => existsSync(pidFile) && readFileSync(pidFile, "utf-8").trim() !== ""));
  const gate = Number(readFileSync(pidFile, "utf-8"));
  t.after(() => void (alive(gate) && process.kill(gate, "SIGKILL")));
  h.restart();
  assert.ok(await within(5000, () => !alive(gate)), "its process goes with the plugin");
  await handing;
  const handback = h.ledger().tasks["L1-T1"]!.handback;
  assert.match(handback?.gate?.note ?? "", /stopped as the plugin stopped/, "and the hand-back says so");
});

test("what waited on a turn when the plugin stopped goes on at its first round", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  await h.call(sup, "supervisor", "open_lane", {
    title: "Numbers",
    outcome: "a.txt gains words",
    acceptance: ["four"],
    outOfScope: ["anything else"],
    isolate: true,
  });
  const numbers = h.ledger().lanes.L2!;
  h.commit(numbers.worktree!, "a.txt", "one\ntwo\nthree\nfour\n");
  // main moves on, so landing starts with merging it into the lane's copy, where its Lead is mid-turn.
  const side = join(tempDir("sw3-moved-"), "wt");
  h.git(h.root, "worktree", "add", "-q", "-b", "side", side, "main");
  h.git(side, "commit", "-qm", "moved", "--allow-empty");
  h.git(h.root, "branch", "-f", "main", "side");
  h.git(h.root, "worktree", "remove", "--force", side);
  assert.match((await h.call(sup, "supervisor", "land_lane", { lane: "L2" })).text, /^Lane L2 lands once /);
  // L1's Lead and Peer are mid-turn, so closing the lane leaves the Peer, and the copy they write in, until their turns end.
  assert.equal((await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "no longer wanted" })).ok, true);
  assert.equal(h.agents.get(peer)!.archivedAt, null, "not while it is mid-turn");

  h.restart();
  // Their turns ended while the plugin was down, so no hook will say so.
  for (const id of [lane.lead!, peer, numbers.lead!]) h.agents.get(id)!.status = "idle";
  await h.tick();
  assert.ok(h.agents.get(peer)!.archivedAt, "the Peer waiting to be archived");
  assert.equal(h.agents.get(lane.lead!)!.archivedAt, null, "the Lead stays until it is released");
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), "main", "and the copy they wrote in is put back");
  await h.runtime.desk.settled(h.project);
  assert.match(h.heard(sup).join("\n"), /LANDED L2 /, "the landing that waited on a turn is carried out");
  assert.equal(h.ledger().lanes.L2!.status, "closed");
  await h.tick();
  assert.equal(
    h.agents.get(lane.lead!)!.archivedAt,
    null,
    "with no lane open, the project's own copy is still not swept from under the seats it keeps",
  );
});

test("an answer promised as mail that a stop lost is owned up to once the plugin starts again, and one that came is not", async (t) => {
  const go = join(tempDir("sw3-promise-"), "go");
  t.after(() => writeFileSync(go, ""));
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  // The gate waits for the test, which decides whether the answer comes before or after the stop.
  await h.call(sup, "supervisor", "set_project", { gate: `until [ -f ${go} ]; do sleep 0.05; done` });
  await h.call(sup, "supervisor", "open_lane", {
    title: "Slow",
    outcome: "x",
    acceptance: ["a"],
    outOfScope: ["anything else in the repository"],
  });
  const lead = h.ledger().lanes.L1!.lead!;
  const report = (id: string) =>
    h.runtime.desk.answer(
      {
        id,
        agent: lead,
        role: "lead",
        tool: "report",
        args: { summary: "ready", ready: true },
        cwd: h.root,
        at: Date.now(),
      },
      { within: 100 },
    );
  const told = () => h.agents.get(lead)!.sent.join("\n").split("NO ANSWER to your report call").length - 1;
  const answered = (count: number) =>
    within(
      5000,
      () => h.heard(lead).join("\n").split("ANSWER to your report call, which ran longer").length - 1 === count,
    );

  assert.match((await report("r1")).text, /answer arrives as mail/, "told to end its turn and wait");
  h.restart();
  await h.tick();
  await h.idle(lead);
  assert.equal(told(), 1, "the stop lost the answer, so the desk owns up to it");
  writeFileSync(go, "");
  assert.ok(await answered(1), "the run the stop left behind finishes");

  rmSync(go);
  assert.match((await report("r2")).text, /answer arrives as mail/);
  writeFileSync(go, "");
  assert.ok(await answered(2), "the answer comes as mail");
  h.restart();
  await h.tick();
  await h.idle(lead);
  assert.equal(told(), 1, "an answer that came is not owned up to again");

  const said = reported(t);
  writeFileSync(join(stateRoot(), "intents.json"), "{not json");
  rmSync(go);
  assert.match((await report("r3")).text, /answer arrives as mail/);
  writeFileSync(go, "");
  assert.ok(await answered(3), "the answer still comes");
  assert.equal(
    readFileSync(join(stateRoot(), "intents.json"), "utf-8"),
    "{not json",
    "a promises file that cannot be read is not written over",
  );
  assert.match(said(), /intents\.json[^]*could not be read/);
});

/** Opens a lane whose Lead Paseo seats, then stops the plugin before the desk hears back, as a crash there would. */
async function stoppedOpening(where: Record<string, unknown>) {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const paseo = h.paseo as unknown as {
    workspaces: { ref: (id: string) => { agents: { create: (options: unknown) => Promise<unknown> } } };
  };
  const ref = paseo.workspaces.ref;
  paseo.workspaces.ref = (id) => {
    const workspace = ref(id);
    const create = workspace.agents.create;
    workspace.agents.create = async (options) => (await create(options), new Promise(() => {}));
    return workspace;
  };
  const head = h.git(h.root, "rev-parse", "HEAD").trim();
  void h.call(sup, "supervisor", "open_lane", {
    title: "Cart",
    outcome: "a.txt changes",
    acceptance: ["a"],
    outOfScope: ["the rest"],
    ...where,
  });
  const seated = () => [...h.agents.values()].find((agent) => agent.title.startsWith("L1 · Lead"));
  for (let i = 0; i < 200 && !seated(); i++) await settle();
  paseo.workspaces.ref = ref;
  h.restart();
  await h.tick(Date.now());
  return { h, lead: seated()!.id, head };
}

test("a Lead seated before a stop is taken on where it works, the commit its lane started from kept, and its tasks start", async () => {
  for (const [where, from] of [
    [{}, undefined],
    [{ onBranch: true }, "head"],
  ] as const) {
    const { h, lead, head } = await stoppedOpening(where);
    const lane = h.ledger().lanes.L1!;
    assert.equal(lane.lead, lead, JSON.stringify(where));
    assert.equal(lane.startSha, from && head, "on the Human's branch, what the lane changed is read from here");
    await h.call(lead, "lead", "add_tasks", {
      tasks: [{ key: "t", title: "Total", goal: "g", acceptance: ["a"], hints: ["a.txt"], outOfScope: ["the rest"] }],
    });
    assert.equal(h.ledger().tasks["L1-T1"]!.status, "running", String(h.ledger().tasks["L1-T1"]!.startHeld?.why));
  }
});
