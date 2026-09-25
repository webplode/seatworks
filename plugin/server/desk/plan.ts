import { firstOverlap, serialHits } from "../core/scope.ts";
import { type Args, str, strs } from "./context.ts";
import { type Lane, type Ledger, activeTasks } from "./ledger.ts";
import { taskWaitsFor } from "./waiting.ts";

/** One task of a plan: its fields as `start_task` takes them, and what it waits for, plan keys and task ids alike. */
export type Planned = { key: string; args: Args; parallel: boolean; owned: string[]; after: string[] };

/**
 * The plan in an order it can run in, or why it is not one: each key once, each `after` a key of it or a task of this
 * lane that can still be accepted, and no loop. Tasks in the lane's copy then run one after another in that order.
 */
export function readPlan(ledger: Ledger, lane: Lane, listed: Args[]): Planned[] | string {
  const tasks: Planned[] = listed.map((args) => ({
    key: str(args.key).trim().toUpperCase(),
    args,
    parallel: args.parallel === true,
    owned: strs(args.owned),
    after: [...new Set(strs(args.after).map((id) => id.trim().toUpperCase()))],
  }));
  const keys = new Set<string>();
  for (const task of tasks) {
    if (!task.key) return "Every task of a plan has a key, which the others name in after.";
    if (keys.has(task.key)) return `The key ${task.key} names two tasks; give each its own.`;
    if (ledger.tasks[task.key]) return `The key ${task.key} is already a task of this project; pick keys that are not task ids.`;
    keys.add(task.key);
  }
  for (const task of tasks) {
    const outside = task.after.filter((id) => !keys.has(id));
    const found = outside.length > 0 ? taskWaitsFor(ledger, lane.id, outside) : [];
    if (typeof found === "string") return `${task.key}: ${found}`;
  }
  const order: Planned[] = [];
  const placed = new Set<string>();
  while (order.length < tasks.length) {
    // Listed order wherever after leaves a choice.
    const next = tasks.find((task) => !placed.has(task.key) && task.after.every((id) => !keys.has(id) || placed.has(id)));
    if (!next) return `The plan loops: ${tasks.filter((task) => !placed.has(task.key)).map((task) => task.key).join(", ")} wait for each other, so none of them could ever start.`;
    order.push(next);
    placed.add(next.key);
  }
  let previous: string | undefined;
  for (const task of order) {
    if (task.parallel) continue;
    if (previous && !task.after.includes(previous)) task.after.push(previous);
    previous = task.key;
  }
  return order;
}

/** What in the plan would collide as the desk will run it: evidence for the Lead, never a refusal on its own. */
export function planFindings(ledger: Ledger, lane: Lane, plan: Planned[], serial: string[]): string[] {
  const findings: string[] = [];
  const before = new Map<string, Set<string>>();
  for (const task of plan) before.set(task.key, new Set(task.after.flatMap((id) => [id, ...(before.get(id) ?? [])])));
  const ordered = (a: Planned, b: Planned) => before.get(a.key)!.has(b.key) || before.get(b.key)!.has(a.key);
  for (const [index, task] of plan.entries()) {
    for (const other of plan.slice(index + 1)) {
      if (!(task.parallel || other.parallel) || ordered(task, other)) continue;
      const clash = firstOverlap(task.owned, other.owned);
      if (clash) findings.push(`${task.key} and ${other.key} may run at once and both own ${clash}: order them with after, or split the paths.`);
    }
    const hits = task.parallel ? serialHits(task.owned, serial) : [];
    if (hits.length > 0) findings.push(`${task.key} runs in parallel but owns ${hits.join(", ")}, which only one writer at a time may write: run it in the lane's copy.`);
    const loose = lane.writeSet.length > 0 ? task.owned.filter((path) => !firstOverlap([path], lane.writeSet)) : [];
    if (loose.length > 0) findings.push(`${task.key} owns ${loose.join(", ")}, outside the lane's write set ${lane.writeSet.join(", ")}: leave it out, or ask for the lane to take it.`);
    for (const active of activeTasks(ledger, lane.id).filter((entry) => entry.kind === "code")) {
      if (before.get(task.key)!.has(active.id) || (!task.parallel && active.mode !== "parallel")) continue;
      const clash = firstOverlap(task.owned, active.owned);
      if (clash) findings.push(`${task.key} owns ${clash}, which ${active.id} is still writing, and does not wait for it: add ${active.id} to its after, or leave those paths to ${active.id}.`);
    }
  }
  return findings;
}
