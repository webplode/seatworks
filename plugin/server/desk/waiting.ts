import { branchExists, currentBranch, headSha } from "../core/git.ts";
import { hash } from "./context.ts";
import { fetchIssue } from "./issue.ts";
import { type Lane, type Ledger, type Task, loadLedger } from "./ledger.ts";
import { letters } from "./letters.ts";
import { leadSeatOf, openedReply, placement, seatingKey, startLead, startPeer, taskPlacement } from "./opening.ts";
import type { Project } from "./project.ts";
import type { DeskServices } from "./services.ts";

/** The one rule for `after`, lanes and tasks alike: each must exist, one done counts, one dropped holds, the rest are waited for. */
function awaiting<T extends { id: string }>(after: string[], find: (id: string) => T | undefined, done: (entry: T) => boolean, dropped: (entry: T) => string | undefined, noun: string): T[] | string {
  const found = after.map(find);
  const missing = after.filter((_, index) => !found[index]);
  if (missing.length > 0) return `There is no ${noun} ${missing.join(", ")} to wait for.`;
  const gone = found.map((entry) => dropped(entry!)).find(Boolean);
  if (gone) return `${gone}, so nothing of it is there to build on.`;
  return found.filter((entry) => !done(entry!)) as T[];
}

/** Why a lane cannot wait on these, or the lanes of them still to land. */
export function waitsFor(ledger: Ledger, after: string[], onBranch: boolean): Lane[] | string {
  const pending = awaiting(after, (id) => ledger.lanes[id], (lane) => lane.landed === true, (lane) => (lane.status === "closed" && !lane.landed ? `Lane ${lane.id} closed without landing` : undefined), "lane");
  if (typeof pending === "string") return pending;
  // A branch carried on merges nowhere: a lane opened off the base after it would not have its work.
  const carried = after.map((id) => ledger.lanes[id]!).find((lane) => lane.onBranch);
  if (carried && !onBranch) return `Lane ${carried.id} carries on ${carried.branch} and merges nowhere, so a lane waiting for it carries on that branch too: pass onBranch.`;
  return pending;
}

/** Why a task cannot wait on these, or the tasks of them still to be accepted; only code tasks of its own lane count. */
export function taskWaitsFor(ledger: Ledger, lane: string, after: string[]): Task[] | string {
  const find = (id: string) => (ledger.tasks[id]?.lane === lane && ledger.tasks[id].kind === "code" ? ledger.tasks[id] : undefined);
  return awaiting(after, find, (task) => task.status === "merged", (task) => (task.status === "cut" ? `${task.id} was cut` : undefined), "task in this lane");
}

/** Keeps why a lane or task still waits, and tells whoever asked for it, once per reason. */
async function hold(desk: DeskServices, project: Project, entry: Lane | Task, held: NonNullable<Lane["held"]>): Promise<void> {
  const task = "lane" in entry;
  const told = await desk.ctx.ledger(project, (current) => {
    const kept = task ? current.tasks[entry.id] : current.lanes[entry.id];
    if (!kept || kept.status !== "waiting" || kept.held?.why === held.why) return false;
    kept.held = held;
    return true;
  });
  if (!told) return;
  desk.ctx.event(project, task ? { kind: "task.held", task: entry.id, reason: held.why } : { kind: "lane.held", lane: entry.id, reason: held.why });
  const to = task ? loadLedger(project.state).lanes[entry.lane]?.lead : await desk.roster.supervisorFor(project, entry.opener);
  await desk.ctx.post(to, `held:${entry.id}:${hash(held.why)}`, letters.waited(entry, `${task ? "it has not started" : "it is not open"}: ${held.why}`));
}

/**
 * Opens each waiting lane whose lanes have all landed; one that cannot, or waits on a lane dropped, is told once per reason.
 * A lane whose start was tried and failed is tried again only when `retryHeld`: a closing lane frees what held it, a round does not.
 */
export async function openWaiting(desk: DeskServices, project: Project, retryHeld: boolean): Promise<void> {
  await putBackHalfOpen(desk, project);
  const ledger = loadLedger(project.state);
  for (const waiting of Object.values(ledger.lanes).filter((lane) => lane.status === "waiting" && (retryHeld || !lane.held?.tried))) {
    const pending = waitsFor(ledger, waiting.after ?? [], waiting.onBranch === true);
    if (Array.isArray(pending) && pending.length > 0) continue;
    const held = typeof pending === "string" ? { why: `${pending} Close this lane to drop it, or close it and open the work again without waiting.` } : await release(desk, project, waiting);
    if (held) await hold(desk, project, waiting, held);
  }
}

/** The same for tasks, in open lanes: an accepted or cut task frees what held one, a round does not. */
export async function startWaiting(desk: DeskServices, project: Project, retryHeld: boolean): Promise<void> {
  await putBackHalfStarted(desk, project);
  const ledger = loadLedger(project.state);
  for (const waiting of Object.values(ledger.tasks).filter((task) => task.status === "waiting" && (retryHeld || !task.held?.tried))) {
    const lane = ledger.lanes[waiting.lane];
    if (lane?.status !== "open" || !lane.lead || (waiting.plan !== undefined && lane.approval?.plan === waiting.plan)) continue;
    const pending = taskWaitsFor(ledger, lane.id, waiting.after ?? []);
    if (Array.isArray(pending) && pending.length > 0) continue;
    const held = typeof pending === "string" ? { why: `${pending} Cut this task to drop it, or cut it and start the work again without waiting.` } : await releaseTask(desk, project, lane, waiting);
    if (held) await hold(desk, project, waiting, held);
  }
}

/** As `release`, for a task: checked with nothing taken, claimed under the ledger lock, and back to waiting if its Peer cannot start. */
async function releaseTask(desk: DeskServices, project: Project, lane: Lane, task: Task): Promise<Task["held"]> {
  const problem = await taskPlacement(project, loadLedger(project.state), lane, task.owned, task.mode === "parallel");
  if (problem) return { why: `${problem.why} It starts by itself once that clears; amend it, or cut it to drop it.` };
  const startSha = task.mode === "parallel" ? undefined : await headSha(lane.worktree!);
  const claimed = await desk.ctx.ledger(project, (ledger) => {
    const entry = ledger.tasks[task.id];
    if (entry?.status !== "waiting") return undefined;
    Object.assign(entry, { status: "running", startSha, updatedAt: Date.now() });
    desk.ctx.seating.add(seatingKey(project, entry.id));
    return { ...entry };
  });
  if (!claimed) return undefined;
  const started = await startPeer(desk, project, lane, claimed, { role: claimed.opening!.role, parent: lane.lead, failed: "waiting" });
  if (typeof started === "string") return { why: `${started} It is tried again when a task is accepted or cut; cut it to drop it.`, tried: true };
  await desk.ctx.setTask(project, task.id, (entry) => {
    delete entry.held;
  });
  await desk.ctx.post(lane.lead, `started:${task.id}`, letters.waited(claimed, `Started ${task.id} ${started.where} with Peer ${started.peer}. Its hand-back arrives as mail.`));
  return undefined;
}

/** Asked first with nothing taken, so a round can ask every time; then claimed under the ledger lock, so nothing opens it twice. */
async function release(desk: DeskServices, project: Project, lane: Lane): Promise<Lane["held"]> {
  const here = await currentBranch(project.root);
  const placed = lane.onBranch && here !== lane.branch
    ? `it carries on ${lane.branch}, and the project's own copy is on ${here ?? "no branch"} now.`
    : !lane.onBranch && !(await branchExists(project.root, lane.base))
      ? `its base branch ${lane.base} no longer exists.`
      : await placement(project, lane, lane.opening?.isolate === true, lane.id);
  if (typeof placed === "string" || "why" in placed) return { why: `${typeof placed === "string" ? placed : placed.why} It opens by itself once that clears; amend it, or close it to drop it.` };
  const claimed = await desk.ctx.ledger(project, (ledger) => {
    const entry = ledger.lanes[lane.id];
    if (entry?.status !== "waiting") return undefined;
    entry.status = "open";
    desk.ctx.seating.add(seatingKey(project, lane.id));
    return { ...entry };
  });
  if (!claimed) return undefined;
  const fetched = claimed.issue ? await fetchIssue(claimed.issue, project.root) : undefined;
  const issue = fetched && !("error" in fetched) ? fetched : undefined;
  const started = await startLead(desk, project, claimed, { ownCopy: placed.ownCopy, failed: "waiting", role: claimed.opening?.role, parent: claimed.opener, issue });
  if (typeof started === "string") return { why: `${started} It is tried again when a lane closes; close it to drop it.`, tried: true };
  await desk.ctx.ledger(project, (ledger) => {
    const entry = ledger.lanes[lane.id];
    if (entry) delete entry.held;
  });
  await desk.ctx.post(await desk.roster.supervisorFor(project, claimed.opener), `opened:${lane.id}`, letters.waited(claimed, openedReply(project, claimed, started.slot, started.lead, issue)), project);
  return undefined;
}

/**
 * A task running with no Peer that nothing is seating was left so by a stop. A Peer Paseo had already started is taken
 * on; otherwise a task that waited goes back to waiting and starts again, and one started outright is cut, its Lead told.
 */
async function putBackHalfStarted(desk: DeskServices, project: Project): Promise<void> {
  const { ctx, slots, roster } = desk;
  const halfStarted = (ledger: Ledger) => Object.values(ledger.tasks).filter((task) => task.status === "running" && !task.peer && !ctx.seating.has(seatingKey(project, task.id)));
  if (halfStarted(loadLedger(project.state)).length === 0) return;
  const seats = await roster.open();
  // An empty listing is a daemon that answered nothing, not word that no Peer was started.
  if (seats.length === 0) return;
  const stopped = await ctx.ledger(project, (ledger) =>
    halfStarted(ledger).flatMap((task) => {
      const seat = seats.find((entry) => !entry.archivedAt && entry.labels?.["seatworks.project"] === project.slug && entry.labels["seatworks.task"] === task.id);
      if (seat) {
        task.peer = seat.id;
        ledger.agents[seat.id] = { id: seat.id, role: seat.labels!["seatworks.role"] ?? "peer", lane: task.lane, task: task.id };
        return [];
      }
      const slot = task.mode === "parallel" ? task.slot : undefined;
      task.status = task.opening ? "waiting" : "cut";
      if (task.mode === "parallel") {
        delete task.slot;
        delete task.worktree;
      }
      return [{ task: { ...task }, slot, into: ledger.lanes[task.lane]?.branch }];
    }),
  );
  for (const { task, slot, into } of stopped) {
    if (slot) await slots.release(project, slot, task.branch, into);
    ctx.event(project, { kind: "task.halfStarted", task: task.id, now: task.status });
    if (task.status === "cut") await ctx.post(loadLedger(project.state).lanes[task.lane]?.lead, `notstarted:${task.id}`, letters.notStarted(task));
  }
}

/**
 * A lane open with no Lead that nothing is seating was left so by a stop. A Lead Paseo had already started is taken on;
 * otherwise what the lane took goes back, and it waits again or, its open_lane never answered, closes.
 */
async function putBackHalfOpen(desk: DeskServices, project: Project): Promise<void> {
  const { ctx, slots, roster } = desk;
  const halfOpen = (ledger: Ledger) => Object.values(ledger.lanes).filter((lane) => lane.status === "open" && !lane.lead && !ctx.seating.has(seatingKey(project, lane.id)));
  if (halfOpen(loadLedger(project.state)).length === 0) return;
  const seats = await roster.open();
  // An empty listing is a daemon that answered nothing, not word that no Lead was started.
  if (seats.length === 0) return;
  const stopped = await ctx.ledger(project, (ledger) =>
    halfOpen(ledger).map((lane) => {
      const slot = Object.values(ledger.slots).find((entry) => entry.lane === lane.id);
      const lead = leadSeatOf(seats, project, lane.id);
      if (lead) {
        Object.assign(lane, { lead: lead.id, worktree: lead.cwd, slot: slot?.id, workspaceId: slot?.workspaceId });
        ledger.agents[lead.id] = { id: lead.id, role: lead.labels!["seatworks.role"] ?? "lead", lane: lane.id };
      } else {
        lane.status = lane.after ? "waiting" : "closed";
        delete lane.held;
      }
      return { lane: { ...lane }, slot: slot?.id };
    }),
  );
  for (const { lane, slot } of stopped) {
    if (!lane.lead && slot) await slots.release(project, slot, lane.branch, lane.base);
    else if (!lane.lead && !lane.onBranch && (await currentBranch(project.root)) === lane.branch) await slots.giveBack(project, lane.base, lane.branch);
    ctx.event(project, { kind: "lane.halfOpen", lane: lane.id, status: lane.status, lead: lane.lead ?? null });
    if (lane.status !== "waiting") await ctx.post(await roster.supervisorFor(project, lane.opener), `halfopen:${lane.id}`, letters.halfOpen(lane), project);
  }
}
