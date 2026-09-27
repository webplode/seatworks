import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../../server/domain/task.ts";
import { emptyLedger } from "../../server/domain/ledger.ts";
import { loadLedger, saveLedger } from "../../server/desk/store/ledger.ts";
import { LedgerStore } from "../../server/desk/store/ledger-store.ts";
import { type Held, close, deliveryOf, tell, unheard } from "../../server/domain/incident.ts";
import { LANE } from "../../server/domain/lane.ts";
import type { Lifecycle } from "../../server/domain/lifecycle.ts";
import { DECIDED, SETTLED, TASK, type TaskStatus } from "../../server/domain/task.ts";
import { tempDir } from "../tempdir.ts";

const TASK_STATUSES: TaskStatus[] = [
  "waiting",
  "running",
  "done",
  "rework",
  "queued",
  "merging",
  "merged",
  "failed",
  "cut",
  "stalled",
];

const steps = <S extends string>(life: Lifecycle<S, string>) =>
  Object.entries(life.moves).map(([move, step]) => ({ move, ...step }));

function reached<S extends string>(life: Lifecycle<S, string>, recorded: S[]): Set<S> {
  const seen = new Set<S>(recorded);
  for (let grew = true; grew;) {
    grew = false;
    for (const step of steps(life)) {
      if (seen.has(step.to) || !step.from.some((status) => seen.has(status))) continue;
      seen.add(step.to);
      grew = true;
    }
  }
  return seen;
}

test("a task, a lane and an incident move only as their tables allow, and a move refused where it is written changes nothing", () => {
  const into = (status: TaskStatus) =>
    steps(TASK)
      .filter((step) => step.to === status && !step.from.includes(status))
      .map((step) => step.move);
  assert.deepEqual(
    [into("merged"), into("queued"), into("merging")],
    [["merged"], ["queue", "requeue"], ["merge"]],
    "only the Lead's accept queues a task, and only the queue merges one, in the lane's copy too",
  );
  assert.deepEqual(
    [TASK.moves.merge.from, TASK.moves.requeue.from, TASK.moves.merged.from],
    [["queued"], ["merging"], ["merging"]],
    "a merge a stop cut off goes back to where the Lead's accept put it",
  );

  assert.deepEqual([...reached(TASK, ["waiting", "running"])].sort(), [...TASK_STATUSES].sort());
  const stuck = TASK_STATUSES.filter(
    (status) =>
      !SETTLED.includes(status) && !steps(TASK).some((step) => step.from.includes(status) && step.to !== status),
  );
  assert.deepEqual(stuck, [], "all but a settled status has a way on");
  assert.deepEqual(
    steps(TASK)
      .filter((step) => step.from.includes("merged"))
      .map((step) => step.move),
    ["rework"],
    "a merged task only goes back to its Peer, sent by its Lead",
  );
  for (const move of ["handBack", "stall"] as const)
    assert.deepEqual(
      TASK.moves[move].from.filter((status) => DECIDED.includes(status)),
      [],
      `${move}: once the Lead has decided a task, its Peer can no longer move it`,
    );
  assert.deepEqual(
    TASK.moves.rework.from.filter((status) => DECIDED.includes(status)),
    ["merged"],
    "not while it is queued, merging or cut",
  );

  assert.deepEqual([...reached(LANE, ["waiting", "open"])].sort(), ["closed", "open", "waiting"]);
  assert.deepEqual(
    steps(LANE).filter((step) => step.from.includes("closed")),
    [],
    "a closed lane stays closed",
  );
  const lane: { status: "open" | "waiting" | "closed" } = { status: "open" };
  assert.equal(LANE.move(lane, "drop"), false, "an open lane is closed, not dropped");
  assert.equal(LANE.move(lane, "close"), true);
  assert.equal(lane.status, "closed");

  const ctx = new LedgerStore(() => {});
  const project = { root: tempDir("sw3-context-"), slug: "p", state: tempDir("sw3-context-state-") };
  const ledger = emptyLedger();
  const task: Task = {
    id: "L1-T1",
    lane: "L1",
    kind: "code",
    mode: "lane",
    title: "t",
    goal: "g",
    acceptance: ["a"],
    hints: ["a.ts"],
    holds: [],
    outOfScope: [],
    status: "running",
    openedAt: 0,
    updatedAt: 0,
    silent: 0,
  };
  ledger.tasks[task.id] = task;
  saveLedger(project.state, ledger);
  const handed = ctx.moveTask(project, task.id, "handBack");
  assert.equal(typeof handed === "object" && handed.status, "done");
  assert.equal(
    ctx.moveTask(project, task.id, "start", (entry) => (entry.silent = 9)),
    "done",
    "of two moves on one task the second hears the status that stopped it",
  );
  assert.deepEqual(
    [loadLedger(project.state).tasks[task.id]!.status, loadLedger(project.state).tasks[task.id]!.silent],
    ["done", 0],
    "what went with the refused move was not applied",
  );
  assert.equal(ctx.moveTask(project, "L1-T9", "cut"), undefined);

  const incident: { open: boolean; told?: number; held?: Held; closed?: number } = { open: true };
  assert.equal(deliveryOf(incident), "unsent");
  assert.equal(unheard(incident), false, "nothing was sent to go unread");
  assert.equal(tell(incident, 5), true);
  assert.deepEqual([deliveryOf(incident), incident.told, incident.held], ["told", 5, undefined]);
  assert.equal(tell(incident, 9), false, "told once");
  assert.equal(unheard(incident), true, "a letter nobody read holds it for somebody");
  assert.deepEqual([deliveryOf(incident), incident.told, incident.held], ["held", undefined, "nobody"]);
  assert.equal(close(incident, 11), true);
  assert.equal(close(incident, 12), false);
  assert.deepEqual([incident.open, incident.closed, incident.held], [false, 11, "nobody"], "closing keeps the hold");
});
