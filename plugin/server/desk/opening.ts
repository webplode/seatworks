import { roleThatCan } from "../catalog/kit.ts";
import { trackedFiles } from "../core/git.ts";
import type { SeatView } from "../core/paseo.ts";
import { errorText } from "../core/errors.ts";
import { firstOverlap, serialHits, serialPaths, serialReach } from "../core/scope.ts";
import type { Issue } from "./issue.ts";
import { type Lane, type Ledger, type Task, type TaskStatus, activeTasks, loadLedger, ownCopyHolder } from "./ledger.ts";
import { letters, outside } from "./letters.ts";
import { type Project, conceptFile, loadConfig } from "./project.ts";
import type { DeskServices } from "./services.ts";
import { namedOrNot } from "./tools/shared.ts";

/** Why a lane cannot open, and what open_lane would do instead: the reason is shared, the advice is not. */
export type Refusal = { why: string; instead: string };

function scopeProblem(serial: string[], open: Lane[], writeSet: string[], contracts: string[]): Refusal | undefined {
  if (open.length === 0) return undefined;
  const mine = serialReach(writeSet, serial);
  for (const other of open) {
    // No write set could mean any of them, and a copy of its own does not help: a merge cannot reconcile these.
    const theirs = other.writeSet.length === 0 ? serial : serialReach(other.writeSet, serial);
    const both = mine.filter((path) => theirs.includes(path));
    // Capped at four: resolved against real files, a Unity or Unreal tree can match tens of thousands.
    if (both.length > 0)
      return {
        why: `Lane ${other.id} may already be writing ${both.slice(0, 4).join(", ")}${both.length > 4 ? ` and ${both.length - 4} more` : ""}, and only one lane at a time may write those.`,
        instead: `Open this lane after ${other.id} lands, or keep those paths out of it.`,
      };
  }
  // Nothing is said when either declared nothing: that is the Supervisor's call, not a hole to refuse over.
  for (const other of open) {
    if (writeSet.length === 0 || other.writeSet.length === 0) continue;
    const clash = firstOverlap(writeSet, [...other.writeSet, ...other.contracts]) ?? firstOverlap(contracts, other.writeSet);
    if (clash) return { why: `This lane overlaps lane ${other.id} at ${clash}.`, instead: `Fold it in or open it after ${other.id} lands.` };
  }
  return undefined;
}

export async function overlap(project: Project, open: Lane[], writeSet: string[], contracts: string[]): Promise<Refusal | undefined> {
  const serial = open.length > 0 ? serialPaths(await trackedFiles(project.root), loadConfig(project.state).serialOnly) : [];
  return scopeProblem(serial, open, writeSet, contracts);
}

export const seatingKey = (project: Project, lane: string) => `${project.slug}:${lane}`;

/** A seat Paseo holds as this lane's Lead, by the labels it was started with; a Peer's and a reviewer's also name a task. */
export function leadSeatOf(seats: SeatView[], project: Project, lane: string): SeatView | undefined {
  return seats.find((seat) => seat.labels?.["seatworks.project"] === project.slug && seat.labels["seatworks.lane"] === lane && !seat.labels["seatworks.task"]);
}

export function directiveFor(project: Project, lane: Lane, issue?: Issue): string {
  return letters.directive(lane, issue, conceptFile(project.state), gateRegime(project));
}

/** Which gate regime this project runs, because a Lead plans its splits against it. */
function gateRegime(project: Project): string {
  const config = loadConfig(project.state);
  if (!config.gate) return "none set, so nothing is checked for you";
  return config.gateOn === "task" ? `${config.gate} runs on every task, and its verdict reaches the Lead with the hand-back — evidence, not a veto` : `${config.gate} runs on the whole lane when you report it ready`;
}

export function openedReply(project: Project, lane: Lane, slot: { id?: string }, lead: string, issue: Issue | undefined): string {
  // An empty gate is the owner's answer, not a missing one, so it is not an invitation to set one.
  const stored = loadConfig(project.state).gate;
  const gate = stored ? stored : stored === "" ? "none set, by this project's own choice" : "none; call set_project with the project's test command";
  const issueText = issue
    ? `\n\nIssue #${issue.number} as the Lead received it: ${outside("issue", issue.title, 200)} (${outside("issue", issue.url, 300)})\n<issue>\n${outside("issue", issue.body, 4000)}\n</issue>`
    : "";
  const where = slot.id ? `in working copy ${slot.id}` : "in the project's own working copy";
  const on = lane.onBranch
    ? `carries on ${lane.branch} ${where}${lane.branch === loadConfig(project.state).base ? `, which is the project's base: nothing separates this work from it and there is no lane branch to fall back on` : ""}`
    : `is open on ${lane.branch} (off ${lane.base}) ${where}`;
  return `Lane ${lane.id} ${on}, and its Lead ${lead} is starting. Gate: ${gate}. Reports and asks arrive as mail; nothing to wait for now.${issueText}`;
}

/** Where a lane opens given the project as it is now, or why it cannot; asked again when a waiting lane's turn comes. */
export async function placement(project: Project, lane: Pick<Lane, "onBranch" | "writeSet" | "contracts" | "detourOf">, isolate: boolean, self?: string): Promise<{ ownCopy: boolean } | Refusal> {
  const lanes = Object.values(loadLedger(project.state).lanes).filter((entry) => entry.id !== self);
  const open = lanes.filter((entry) => entry.status === "open");
  const holder = ownCopyHolder(lanes);
  if (lane.onBranch && holder) return { why: `Lane ${holder.id} is working in the project's own copy on ${holder.branch}, and one checkout holds one branch.`, instead: `Carry this branch on once ${holder.id} closes, or open the lane on a branch of its own.` };
  // A detour must name a real open lane, or the letter back out of it has nowhere to go.
  if (lane.detourOf && !open.some((entry) => entry.id === lane.detourOf)) return { why: `There is no open lane ${lane.detourOf} for this one to clear the way for.`, instead: "" };
  const problem = await overlap(project, open, lane.writeSet, lane.contracts);
  if (problem) return problem;
  // One checkout is one branch, so whether to wait for it or take a copy is the Supervisor's call; a detour cannot wait.
  if (holder && !isolate && !lane.onBranch && !lane.detourOf) {
    return holder.status === "open"
      ? { why: `Lane ${holder.id} is working in the project's own copy on ${holder.branch}.`, instead: `Pass isolate to open this lane in a copy of its own now, or open it with after ${holder.id} to work in the project's copy once that lane lands.` }
      : { why: `Lane ${holder.id} is closed, but its Lead is still ending a turn in the project's own copy, which goes back to ${holder.base} when that turn ends.`, instead: "Pass isolate to open this lane in a copy of its own now, or open it again once status shows the copy is back." };
  }
  return { ownCopy: !lane.onBranch && (isolate || holder !== undefined) };
}

type Seating = { ownCopy: boolean; from?: string; role?: string; parent?: string; issue?: Issue; revalidate?: () => void };
type Seated = { slot: { id?: string; path: string; workspaceId?: string }; lead: string };

/** Seats the Lead of a lane marked seating; a failure puts back what it took, sets the lane to `failed`, and comes back as the reason. */
export async function startLead(desk: DeskServices, project: Project, lane: Lane, how: Seating & { failed: "closed" | "waiting" }): Promise<Seated | string> {
  const { ctx } = desk;
  try {
    const started = await seatLead(desk, project, lane, how);
    if (typeof started === "string") {
      await ctx.ledger(project, (ledger) => {
        const entry = ledger.lanes[lane.id];
        if (entry) entry.status = how.failed;
      });
    }
    return started;
  } finally {
    ctx.seating.delete(seatingKey(project, lane.id));
  }
}

async function seatLead(desk: DeskServices, project: Project, lane: Lane, how: Seating): Promise<Seated | string> {
  const { ctx, slots, agents } = desk;
  const giveBack = async (taken: { id?: string }) => {
    if (taken.id) await slots.release(project, taken.id, lane.branch, lane.base);
    else if (how.from) await slots.unstart(project, how.from, lane.branch);
    else if (!lane.onBranch) await slots.giveBack(project, lane.base, lane.branch);
  };
  let slot: { id?: string; path: string; workspaceId?: string };
  try {
    how.revalidate?.();
    slot = lane.onBranch ? await slots.carryOn(project, lane.branch, how.from) : how.ownCopy ? await slots.acquire(project, lane.branch, lane.base, { lane: lane.id }) : await slots.inPlace(project, lane.branch, lane.base);
  } catch (error) {
    return `The lane could not get a working copy: ${errorText(error)}`;
  }
  try {
    const leadRole = roleThatCan(ctx.kit, "lead", how.role || undefined);
    if (!leadRole) {
      await giveBack(slot);
      return namedOrNot(ctx.kit, "lead", how.role ?? "", "lead a lane");
    }
    how.revalidate?.();
    const lead = await agents.start(project, slot, leadRole.role, {
      parent: how.parent,
      title: `${lane.id} ${lane.title}`,
      prompt: directiveFor(project, lane, how.issue),
      labels: { "seatworks.lane": lane.id, "seatworks.role": leadRole.role },
    });
    await ctx.ledger(project, (ledger) => {
      const entry = ledger.lanes[lane.id];
      if (entry) Object.assign(entry, { lead, worktree: slot.path, slot: slot.id, workspaceId: slot.workspaceId });
      ledger.agents[lead] = { id: lead, role: leadRole.role, lane: lane.id };
    });
    ctx.event(project, { kind: "lane.opened", lane: lane.id, lead, branch: lane.branch, base: lane.base, slot: slot.id ?? "in place" });
    return { slot, lead };
  } catch (error) {
    await giveBack(slot);
    return `The Lead could not start: ${errorText(error)}`;
  }
}

const HOLDS: TaskStatus[] = ["running", "rework", "done", "stalled"];

/** Handed-back and stalled tasks still hold the copy (their Peer is seated there), unless the stalled Peer's seat is gone. */
const holds = (task: Task): boolean => HOLDS.includes(task.status) && !(task.status === "stalled" && task.peerGone);

export function holderOf(ledger: Ledger, lane: Lane, except?: string): Task | undefined {
  return Object.values(ledger.tasks).find(
    (task) => task.lane === lane.id && task.id !== except && task.kind === "code" && task.mode !== "parallel" && holds(task),
  );
}

/** Where a task may start in its lane now, or why not; asked again when a waiting task's turn comes. */
export async function taskPlacement(project: Project, ledger: Ledger, lane: Lane, owned: string[], parallel: boolean): Promise<Refusal | undefined> {
  if (!parallel) {
    const holder = holderOf(ledger, lane);
    if (!holder) return undefined;
    return holder.status === "done"
      ? { why: `${holder.id} has handed back and is waiting on you, and it still holds the lane's working copy — rework would wake its Peer in there.`, instead: "Accept or cut it first, or set parallel only for owned paths independent of it." }
      : { why: `${holder.id} is still writing in the lane's working copy, and it holds one writer at a time.`, instead: `Pass after ${holder.id} to start this once it is accepted, or set parallel only for owned paths independent of it.` };
  }
  const serial = serialHits(owned, serialPaths(await trackedFiles(lane.worktree ?? project.root), loadConfig(project.state).serialOnly));
  if (serial.length > 0) return { why: `A parallel task can't own ${serial.join(", ")}.`, instead: "Run it in the lane's working copy instead." };
  for (const task of activeTasks(ledger, lane.id).filter((entry) => entry.kind === "code")) {
    const clash = firstOverlap(owned, task.owned);
    if (clash) return { why: `The owned paths overlap ${task.id} at ${clash}.`, instead: `Pass after ${task.id} instead of running it in parallel.` };
  }
  return undefined;
}

/** Seats the Peer of a task recorded running; a failure gives back its copy, sets it to `failed`, and comes back as the reason. */
export async function startPeer(desk: DeskServices, project: Project, lane: Lane, task: Task, how: { role: string; parent?: string; failed: "cut" | "waiting" }): Promise<{ peer: string; where: string } | string> {
  const { ctx, slots, agents } = desk;
  const parallel = task.mode === "parallel";
  try {
    let slot: { id?: string; path: string; workspaceId?: string };
    if (parallel) {
      slot = await slots.acquire(project, task.branch!, lane.branch, { task: task.id });
      await ctx.setTask(project, task.id, (entry) => Object.assign(entry, { slot: slot.id, worktree: slot.path }));
    } else {
      slot = lane.slot ? loadLedger(project.state).slots[lane.slot]! : { path: lane.worktree!, workspaceId: lane.workspaceId };
    }
    const peer = await agents.start(project, slot, how.role, {
      parent: how.parent,
      title: `${task.id} ${task.title}`,
      prompt: letters.brief(task, lane),
      labels: { "seatworks.lane": lane.id, "seatworks.task": task.id, "seatworks.role": how.role },
    });
    await ctx.setTask(project, task.id, (entry) => {
      entry.peer = peer;
    });
    await ctx.ledger(project, (current) => {
      current.agents[peer] = { id: peer, role: how.role, lane: lane.id, task: task.id };
    });
    ctx.event(project, { kind: "task.started", task: task.id, peer, mode: task.mode, slot: slot.id ?? "in place" });
    return { peer, where: parallel ? `in its own working copy ${slot.id} on ${task.branch}` : `in the lane's working copy on ${lane.branch}` };
  } catch (error) {
    const taken = loadLedger(project.state).tasks[task.id]?.slot;
    await ctx.setTask(project, task.id, (entry) => {
      entry.status = how.failed;
      if (parallel) {
        delete entry.slot;
        delete entry.worktree;
      }
    });
    if (parallel) await slots.release(project, taken, task.branch, lane.branch);
    return `The Peer could not start: ${errorText(error)}`;
  }
}
