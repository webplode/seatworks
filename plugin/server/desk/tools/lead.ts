import { roleThatCan } from "../../catalog/kit.ts";
import { skillSources } from "../../catalog/content.ts";
import { skillDirsFor } from "../../catalog/team.ts";
import { branchExists, currentBranch, diffCounts, git, headSha, outsideOwned, resetHard, trackedFiles } from "../../core/git.ts";
import { workState } from "../../catalog/project-files.ts";
import { firstOverlap, serialHits, serialPaths } from "../../core/scope.ts";
import { type Args, type Caller, hash, no, ok, str, strs } from "../context.ts";
import { errorText } from "../../core/errors.ts";
import { gateNote, laneGate } from "../gates.ts";
import {
  type Ask,
  type AskKind,
  type Lane,
  type Ledger,
  type Task,
  type TaskStatus,
  activeTasks,
  findTask,
  laneOfLead,
  loadLedger,
  nextAskId,
  nextTaskId,
  slugify,
} from "../ledger.ts";
import { clip, letters } from "../letters.ts";
import { type Project, loadConfig } from "../project.ts";
import type { DeskServices, Tool } from "../services.ts";
import { namedOrNot } from "./shared.ts";

const HOLDS: TaskStatus[] = ["running", "rework", "done", "stalled"];

/** Handed-back and stalled tasks still hold the copy (their Peer is seated there), unless the stalled Peer's seat is gone. */
const holds = (task: Task): boolean => HOLDS.includes(task.status) && !(task.status === "stalled" && task.peerGone);

/** What is in the way, named: a stray message file reads as unfinished work otherwise. */
async function uncommittedIn(cwd: string): Promise<string> {
  const run = await git(cwd, ["status", "--porcelain"]);
  const lines = run.stdout.split("\n").filter((line) => line.trim());
  const shown = lines.slice(0, 6).map((line) => line.trim()).join(", ");
  return lines.length > 6 ? `${shown} and ${lines.length - 6} more` : shown || "something git reports but does not name";
}

function holderOf(ledger: Ledger, lane: Lane, except?: string): Task | undefined {
  return Object.values(ledger.tasks).find(
    (task) => task.lane === lane.id && task.id !== except && task.kind === "code" && task.mode !== "parallel" && holds(task),
  );
}

function laneTask(ledger: Ledger, caller: Caller, id: string): { lane: Lane; task: Task } | string {
  const lane = laneOfLead(ledger, caller.id);
  const task = findTask(ledger, id);
  if (!lane) return "You have no open lane.";
  if (!task || task.lane !== lane.id) return `${id} is not a task in your lane.`;
  return { lane, task };
}

async function placementProblem(project: Project, ledger: Ledger, lane: Lane, owned: string[], parallel: boolean): Promise<string | undefined> {
  const active = activeTasks(ledger, lane.id).filter((task) => task.kind === "code");
  if (!parallel) {
    const holder = holderOf(ledger, lane);
    if (!holder) return undefined;
    return holder.status === "done"
      ? `${holder.id} has handed back and is waiting on you, and it still holds the lane's working copy — rework would wake its Peer in there. Accept or cut it first, or set parallel only for owned paths independent of it.`
      : `${holder.id} is still writing in the lane's working copy, and it holds one writer at a time. Wait for its hand-back and accept or cut it, or set parallel only for owned paths independent of it.`;
  }
  const serial = serialHits(owned, serialPaths(await trackedFiles(lane.worktree ?? project.root), loadConfig(project.state).serialOnly));
  if (serial.length > 0) return `A parallel task can't own ${serial.join(", ")}; run it in the lane's working copy instead.`;
  for (const task of active) {
    const clash = firstOverlap(owned, task.owned);
    if (clash) return `The owned paths overlap ${task.id} at ${clash}; run it after ${task.id} instead of in parallel.`;
  }
  return undefined;
}

function recordTask(desk: DeskServices, project: Project, lane: Lane, args: Args, parallel: boolean, startSha: string | undefined): Promise<Task> {
  const title = str(args.title);
  return desk.ctx.ledger(project, (current) => {
    const id = nextTaskId(current.lanes[lane.id]!, "code");
    const now = Date.now();
    const task: Task = {
      id,
      lane: lane.id,
      kind: "code",
      mode: parallel ? "parallel" : "lane",
      title,
      goal: str(args.goal),
      acceptance: strs(args.acceptance),
      owned: strs(args.owned),
      outOfScope: strs(args.outOfScope),
      context: str(args.context) || undefined,
      skills: strs(args.skills),
      branch: parallel ? `task/${id.toLowerCase()}-${slugify(title, 24)}` : lane.branch,
      worktree: parallel ? undefined : lane.worktree,
      slot: parallel ? undefined : lane.slot,
      startSha,
      status: "running",
      openedAt: now,
      updatedAt: now,
      silent: 0,
    };
    current.tasks[id] = task;
    return { ...task };
  });
}

export const startTask: Tool = async (desk, caller, args) => {
  const { ctx, slots, agents } = desk;
  const { project } = caller;
  const owned = strs(args.owned);
  const parallel = args.parallel === true;
  const ledger = loadLedger(project.state);
  const lane = laneOfLead(ledger, caller.id);
  if (!lane?.worktree) return no("You have no open lane.");
  const problem = await placementProblem(project, ledger, lane, owned, parallel);
  if (problem) return no(problem);
  // Writing, not `work`: a reviewing role holds `work` too, and would be offered as a Peer that cannot write.
  const asked = str(args.role);
  const workRole = roleThatCan(ctx.kit, "write", asked || undefined);
  if (!workRole) return no(namedOrNot(ctx.kit, "write", asked, "take a task"));
  // Refused here: nothing in the Lead's context lists the skills, and a missing one is a dead line in the brief.
  const held = [...skillSources(ctx.kit, workRole, skillDirsFor(ctx.team(project), workRole.role)).keys()];
  const unknown = strs(args.skills).filter((name) => !held.includes(name));
  if (unknown.length > 0) {
    return no(held.length === 0 ? `This kit gives ${workRole.label}s no skills, so ${unknown.join(", ")} cannot be opened.` : `${workRole.label}s have no skill called ${unknown.join(", ")}. They have: ${held.sort().join(", ")}.`);
  }
  const task = await recordTask(desk, project, lane, args, parallel, parallel ? undefined : await headSha(lane.worktree));
  try {
    let slot: { id?: string; path: string; workspaceId?: string };
    if (parallel) {
      slot = await slots.acquire(project, task.branch!, lane.branch, { task: task.id });
      await ctx.setTask(project, task.id, (entry) => Object.assign(entry, { slot: slot.id, worktree: slot.path }));
    } else {
      slot = lane.slot ? loadLedger(project.state).slots[lane.slot]! : { path: lane.worktree, workspaceId: lane.workspaceId };
    }
    const peer = await agents.start(project, slot, workRole.role, {
      parent: caller.id,
      title: `${task.id} ${task.title}`,
      prompt: letters.brief(task, lane),
      labels: { "seatworks.lane": lane.id, "seatworks.task": task.id, "seatworks.role": workRole.role },
    });
    await ctx.setTask(project, task.id, (entry) => {
      entry.peer = peer;
    });
    await ctx.ledger(project, (current) => {
      current.agents[peer] = { id: peer, role: workRole.role, lane: lane.id, task: task.id };
    });
    ctx.event(project, { kind: "task.started", task: task.id, peer, mode: task.mode, slot: slot.id ?? "in place" });
    const where = parallel ? `in its own working copy ${slot.id} on ${task.branch}` : `in the lane's working copy on ${lane.branch}`;
    return ok(`Started ${task.id} ${where} with Peer ${peer}. Its hand-back arrives as mail; there is nothing to wait for in this turn.`);
  } catch (error) {
    const failed = await ctx.setTask(project, task.id, (entry) => {
      entry.status = "cut";
    });
    if (failed && parallel) await slots.release(project, failed.slot, failed.branch, lane.branch);
    return no(`The Peer could not start: ${errorText(error)}`);
  }
};

/** A landed parallel task's copy and branch are gone, so its change is read from the merge, not `laneBranch...HEAD`. */
async function changeOf(project: Project, target: Task, lane: Lane, inOwnCopy: boolean): Promise<{ where: string; range: string } | undefined> {
  if (target.mode !== "parallel") return { where: "Your working copy holds the change", range: `git diff ${target.startSha ?? lane.branch}..HEAD` };
  if (inOwnCopy) return { where: "Your working copy holds the change", range: `git diff ${lane.branch}...HEAD` };
  if (target.mergeSha) return { where: `The change is in ${lane.branch}, as the merge ${target.mergeSha.slice(0, 7)}`, range: `git diff ${target.mergeSha}^1..${target.mergeSha}` };
  if (target.branch && (await branchExists(project.root, target.branch)))
    return { where: `The change is on ${target.branch}, not in your working copy`, range: `git diff ${lane.branch}...${target.branch}` };
  return undefined;
}

export const startReview: Tool = async ({ ctx, agents }, caller, args) => {
  const { project } = caller;
  const focus = str(args.focus);
  const ledger = loadLedger(project.state);
  const lane = laneOfLead(ledger, caller.id);
  if (!lane?.worktree) return no("You have no open lane.");
  const target = str(args.task) ? findTask(ledger, str(args.task)) : undefined;
  if (str(args.task) && (!target || target.lane !== lane.id || target.kind !== "code")) return no(`${str(args.task)} is not a code task in your lane.`);
  // A slot marked for teardown still answers as the task's copy; a reviewer seated there loses it at the Peer's turn end.
  const holds = target?.slot ? ledger.slots[target.slot] : undefined;
  const own = target?.mode === "parallel" && holds?.task === target.id && !holds.releasing ? holds : undefined;
  const change = target ? await changeOf(project, target, lane, Boolean(own)) : undefined;
  if (target && !change)
    return no(`${target.id} worked in a copy that has been given back, and neither a merge nor a branch is left to read it from. Ask for a review of the lane instead.`);
  const slot: { id?: string; path: string; workspaceId?: string } | undefined =
    own ?? (lane.slot ? ledger.slots[lane.slot] : { path: lane.worktree, workspaceId: lane.workspaceId });
  if (!slot) return no("The working copy for that review is gone.");
  // No fallback to a plain worker: read-only comes from the reviewer role's settings, so a stand-in could rewrite.
  const lens = str(args.role);
  const reviewRole = roleThatCan(ctx.kit, "review", lens || undefined);
  if (!reviewRole) return no(namedOrNot(ctx.kit, "review", lens, "review, so there is nobody to ask a read-only question of"));
  const review = await ctx.ledger(project, (current) => {
    const id = nextTaskId(current.lanes[lane.id]!, "review");
    const now = Date.now();
    const created: Task = {
      id,
      lane: lane.id,
      kind: "review",
      mode: "lane",
      of: target?.id,
      title: str(args.title) || (target ? `Review ${target.id}` : clip(focus.split(/\r?\n/)[0] ?? "Review", 50)),
      goal: focus,
      acceptance: target?.acceptance ?? [],
      owned: [],
      outOfScope: [],
      context: lane.branch,
      worktree: slot.path,
      slot: slot.id,
      status: "running",
      openedAt: now,
      updatedAt: now,
      silent: 0,
    };
    current.tasks[id] = created;
    return { ...created };
  });
  try {
    const reviewer = await agents.start(project, slot, reviewRole.role, {
      parent: caller.id,
      title: `${review.id} ${target?.title ?? review.title}`,
      prompt: letters.reviewBrief(review, target, focus, lane.branch, change),
      labels: { "seatworks.lane": lane.id, "seatworks.task": review.id, "seatworks.role": reviewRole.role },
    });
    await ctx.setTask(project, review.id, (entry) => {
      entry.peer = reviewer;
    });
    await ctx.ledger(project, (current) => {
      current.agents[reviewer] = { id: reviewer, role: reviewRole.role, lane: lane.id, task: review.id };
    });
    ctx.event(project, { kind: "review.started", task: review.id, of: target?.id ?? null, reviewer });
    return ok(`Started ${review.id}${target ? ` on ${target.id}` : ""} with reviewer ${reviewer}. The verdict arrives as mail.`);
  } catch (error) {
    await ctx.setTask(project, review.id, (entry) => {
      entry.status = "cut";
    });
    return no(`The reviewer could not start: ${errorText(error)}`);
  }
};

export const accept: Tool = async ({ ctx, agents, merges }, caller, args) => {
  const { project } = caller;
  const found = laneTask(loadLedger(project.state), caller, str(args.task));
  if (typeof found === "string") return no(found);
  const { lane, task } = found;
  if (task.kind !== "code") return no(`${task.id} is a review; cut it when you are done with it.`);
  if (["merged", "queued", "merging", "cut"].includes(task.status)) return no(`${task.id} is ${task.status}.`);
  if (task.mode === "parallel") {
    await ctx.setTask(project, task.id, (entry) => {
      entry.status = "queued";
    });
    const ahead = Object.values(loadLedger(project.state).tasks).filter((entry) => entry.status === "queued" || entry.status === "merging").length - 1;
    merges.enqueue(project, task.id);
    return ok(`${task.id} is in the merge queue${ahead > 0 ? ` behind ${ahead}` : ""}. MERGED or MERGE FAILED arrives as mail.`);
  }
  // A copy off the lane branch (mid-bisect) has commits on no branch; clean and detached is not landed.
  if (lane.worktree && (await currentBranch(lane.worktree)) !== lane.branch) {
    return no(
      `The lane's working copy is not on ${lane.branch}, so nothing committed in it is on the lane branch. Send rework asking the Peer on ${task.id} to put the copy back on ${lane.branch} — if it bisected, git bisect reset — and to commit its work there, then accept again.`,
    );
  }
  if (!lane.worktree) return no(`Lane ${lane.id} has no working copy.`);
  const copy = await workState(lane.worktree);
  if (copy === "unknown") return no(`git could not read the lane's working copy at ${lane.worktree}, so the desk cannot tell whether anything is uncommitted there.`);
  if (copy === "dirty") {
    // Named correctly: the uncommitted work may be another task's, and reworking this one would wake its Peer into it.
    const other = holderOf(loadLedger(project.state), lane, task.id);
    return no(
      other
        ? `The lane's working copy has uncommitted changes, and ${other.id} is the task holding it — they are not ${task.id}'s. Accept ${task.id} once ${other.id} has handed back and been accepted or cut.`
        : `The lane's working copy has uncommitted changes: ${await uncommittedIn(lane.worktree)}. Send rework asking the Peer on ${task.id} for those, then accept again.`,
    );
  }
  const counts = await diffCounts(lane.worktree, task.startSha ?? lane.base, "HEAD");
  // Not rerun: a per-task gate already gave the Lead its verdict with the hand-back.
  const gate = gateNote(project, task);
  const updated = await ctx.setTask(project, task.id, (entry) => {
    entry.status = "merged";
  });
  await ctx.post(lane.lead, `merge:${task.id}:merged:${Date.now()}`, letters.merged(task, counts, outsideOwned(counts?.files ?? [], task.owned), gate), caller.project);
  if (updated) await agents.retire(project, updated, lane.branch);
  ctx.event(project, { kind: "task.accepted", task: task.id, mode: "lane" });
  return ok(
    counts && counts.files.length === 0
      ? `${task.id} is accepted; it changed nothing, so ${lane.branch} stands where it did. The working copy is free for the next task.`
      : `${task.id} is accepted; its commits are already on ${lane.branch}. The working copy is free for the next task.`,
  );
};

export const rework: Tool = async ({ ctx, roster }, caller, args) => {
  const text = str(args.text);
  const result = await ctx.ledger(caller.project, (ledger): Task | string => {
    const found = laneTask(ledger, caller, str(args.task));
    if (typeof found === "string") return found;
    const { lane, task } = found;
    if (["merged", "cut", "queued", "merging"].includes(task.status)) return `${task.id} is ${task.status}.`;
    const holder = task.mode === "parallel" ? undefined : holderOf(ledger, lane, task.id);
    if (holder) return `${holder.id} holds the lane's working copy; waking the Peer on ${task.id} in there would put two writers in one checkout. Accept or cut ${holder.id} first.`;
    task.status = "rework";
    task.silent = 0;
    task.reworks = (task.reworks ?? 0) + 1;
    task.updatedAt = Date.now();
    return { ...task };
  });
  if (typeof result === "string") return no(result);
  if (!result.peer) return no(`${result.id} has no Peer.`);
  const seat = await roster.look(result.peer);
  if (seat.archivedAt) return no(`The Peer on ${result.id} is gone; cut the task and start a new one.`);
  // Keyed by the task's clock, not the words: a repeated instruction is a second instruction, not a duplicate.
  const posted = await ctx.post(result.peer, `rework:${result.id}:${result.reworks}`, letters.rework(text), caller.project);
  return posted === "duplicate"
    ? no(`That rework was already sent to the Peer on ${result.id} and it has not ended a turn since, so this would be the same letter twice. Wait for its hand-back, or cut it.`)
    : ok(`Rework sent to the Peer on ${result.id}; its next hand-back arrives as mail.`);
};

export const cut: Tool = async ({ ctx, roster, slots }, caller, args) => {
  const { project } = caller;
  const ledger = loadLedger(project.state);
  const found = laneTask(ledger, caller, str(args.task));
  if (typeof found === "string") return no(found);
  const { lane, task } = found;
  if (task.status === "merged") return no(`${task.id} is already accepted.`);
  const updated = await ctx.setTask(project, task.id, (entry) => {
    entry.status = "cut";
  });
  if (!updated) return no(`${task.id} is gone.`);
  await roster.archive(task.peer, true);
  let undone = "";
  if (task.kind === "code" && task.mode === "lane" && task.startSha && lane.worktree) {
    // Resetting to the task's start would also drop later merges whose Peers were told their work was in.
    const since = Object.values(ledger.tasks).filter((other) => other.lane === lane.id && other.id !== task.id && other.status === "merged" && other.updatedAt > task.openedAt);
    if (since.length > 0) {
      undone = ` Its writing is left in the lane's working copy: ${since.map((other) => other.id).join(", ")} landed there after ${task.id} started, and going back to ${task.startSha.slice(0, 7)} would take that too. Undo what you want gone.`;
    } else {
      await resetHard(lane.worktree, task.startSha);
      await git(lane.worktree, ["clean", "-fd"]);
      undone = ` The lane's working copy is back at ${task.startSha.slice(0, 7)}.`;
    }
  }
  const kept = task.kind === "code" && task.mode === "parallel" ? await slots.release(project, task.slot, task.branch, lane.branch) : undefined;
  ctx.event(project, { kind: "task.cut", task: task.id, reason: str(args.reason), kept });
  const branch = kept ? ` Its branch ${kept} holds commits nothing else has and is kept.` : "";
  return ok(`${task.id} is cut and its agent stopped.${undone}${branch}`);
};

export const ask: Tool = async ({ ctx, roster }, caller, args) => {
  const kind = str(args.kind) as AskKind;
  const text = str(args.text);
  const lane = laneOfLead(loadLedger(caller.project.state), caller.id);
  if (!lane) return no("You have no open lane.");
  const to = await roster.supervisorFor(caller.project, lane.opener);
  if (!to) return no("Nobody above you is running to answer; keep working on your default and report when the lane is ready.");
  const entry = await ctx.ledger(caller.project, (ledger) => {
    const created: Ask = {
      id: nextAskId(ledger),
      from: caller.id,
      fromRole: caller.role.role,
      to,
      lane: lane.id,
      kind,
      text,
      default: str(args.default) || undefined,
      status: "open",
      openedAt: Date.now(),
      reminders: 0,
    };
    ledger.asks[created.id] = created;
    return { ...created };
  });
  await ctx.post(to, `ask:${entry.id}`, letters.askTo(entry, `the Lead of ${lane.id} (${lane.title})`), caller.project);
  ctx.event(caller.project, { kind: "ask.opened", ask: entry.id, from: caller.id, to });
  return ok(`Asked as ${entry.id}. Keep working on your default where you can; the answer arrives as mail.`);
};

export const report: Tool = async ({ ctx, roster }, caller, args) => {
  const summary = str(args.summary);
  const lane = laneOfLead(loadLedger(caller.project.state), caller.id);
  if (!lane) return no("You have no open lane.");
  const gate = args.ready === true ? await laneGate(ctx, caller.project, lane) : undefined;
  const to = await roster.supervisorFor(caller.project, lane.opener);
  const letter = letters.report(lane, summary, args.ready === true, strs(args.carried), gate);
  const posted = await ctx.post(to, `report:${lane.id}:${hash(summary)}`, letter, caller.project);
  ctx.event(caller.project, { kind: "lane.report", lane: lane.id, ready: args.ready === true, gate: gate?.ok, to: to ?? null, text: posted === "nobody" ? letter : undefined });
  // With nobody supervising seated the post goes nowhere; it is kept in the event log and the Lead told so.
  if (posted === "nobody") {
    return ok(`Nobody supervising this project is seated, so the report reached no one. It is kept in ${caller.project.state}/events.log for whoever comes back; there is nothing to wait for until someone does.`);
  }
  return ok(
    gate && !gate.ok
      ? `Reported to ${to}, with what the gate did in it. Stay quiet until mail arrives.`
      : `Reported to ${to}. Stay quiet until mail arrives.`,
  );
};
