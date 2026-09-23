import { configFault } from "../../core/config-file.ts";
import { branchExists, currentBranch, isAncestor, landLane, mergeBranch, trackedFiles } from "../../core/git.ts";
import { blockUncommitted } from "../../catalog/project-files.ts";
import { roleThatCan } from "../../catalog/kit.ts";
import { firstOverlap, serialPaths, serialReach } from "../../core/scope.ts";
import { type Args, type Caller, no, ok, str, strs } from "../context.ts";
import { errorText } from "../../core/errors.ts";
import { laneGate } from "../gates.ts";
import { type Issue, fetchIssue } from "../issue.ts";
import { type Lane, type Ledger, type Task, findLane, loadLedger, nextLaneId, slugify, tasksOf } from "../ledger.ts";
import { clip, letters, outside } from "../letters.ts";
import { type Project, type ProjectConfig, conceptFile, configFile, detectGate, loadConfig, saveConfig } from "../project.ts";
import type { Roster } from "../roster.ts";
import type { DeskServices, Tool } from "../services.ts";
import { namedOrNot } from "./shared.ts";

function scopeProblem(serial: string[], open: Lane[], writeSet: string[], contracts: string[]): string | undefined {
  if (open.length === 0) return undefined;
  const mine = serialReach(writeSet, serial);
  for (const other of open) {
    // No write set could mean any of them, and a copy of its own does not help: a merge cannot reconcile these.
    const theirs = other.writeSet.length === 0 ? serial : serialReach(other.writeSet, serial);
    const both = mine.filter((path) => theirs.includes(path));
    // Capped at four: resolved against real files, a Unity or Unreal tree can match tens of thousands.
    if (both.length > 0)
      return `Lane ${other.id} may already be writing ${both.slice(0, 4).join(", ")}${both.length > 4 ? ` and ${both.length - 4} more` : ""}, and only one lane at a time may write those; open this lane after ${other.id} lands, or keep those paths out of it.`;
  }
  // Nothing is said when either declared nothing: that is the Supervisor's call, not a hole to refuse over.
  for (const other of open) {
    if (writeSet.length === 0 || other.writeSet.length === 0) continue;
    const clash = firstOverlap(writeSet, [...other.writeSet, ...other.contracts]) ?? firstOverlap(contracts, other.writeSet);
    if (clash) return `This lane overlaps lane ${other.id} at ${clash}; fold it in or open it after ${other.id} lands.`;
  }
  return undefined;
}

/** An unreadable issue ref is a note on the lane, never a reason to refuse opening it. */
async function readIssue(args: Args, project: Project): Promise<{ issue?: Issue; unread?: string }> {
  const ref = str(args.issue);
  if (!ref) return {};
  const fetched = await fetchIssue(ref, project.root);
  return "error" in fetched ? { unread: `${ref} could not be read: ${fetched.error}` } : { issue: fetched };
}

function recordLane(desk: DeskServices, caller: Caller, args: Args, base: string, issue: Issue | undefined): Promise<Lane> {
  const title = str(args.title);
  return desk.ctx.ledger(caller.project, (ledger) => {
    caller.revalidate?.();
    const id = nextLaneId(ledger);
    const lane: Lane = {
      id,
      title,
      outcome: str(args.outcome),
      acceptance: strs(args.acceptance),
      appetite: str(args.appetite) || undefined,
      deadline: str(args.deadline) || undefined,
      outOfScope: strs(args.outOfScope),
      issue: issue?.url,
      base,
      branch: `lane/${id.toLowerCase()}-${slugify(title, 24)}`,
      detourOf: str(args.detourOf).trim().toUpperCase() || undefined,
      writeSet: strs(args.writeSet),
      contracts: strs(args.contracts),
      opener: caller.id,
      status: "open",
      openedAt: Date.now(),
      tasks: 0,
    };
    ledger.lanes[id] = lane;
    return { ...lane };
  });
}

/** Which gate regime this project runs, because a Lead plans its splits against it. */
function gateRegime(project: Project): string {
  const config = loadConfig(project.state);
  if (!config.gate) return "none set, so nothing is checked for you";
  return config.gateOn === "task" ? `${config.gate} runs on every task, and its verdict reaches the Lead with the hand-back — evidence, not a veto` : `${config.gate} runs on the whole lane when you report it ready`;
}

function openedReply(project: Project, lane: Lane, slot: { id?: string }, lead: string, issue: Issue | undefined): string {
  // An empty gate is the owner's answer, not a missing one, so it is not an invitation to set one.
  const stored = loadConfig(project.state).gate;
  const gate = stored ? stored : stored === "" ? "none set, by this project's own choice" : "none; call set_project with the project's test command";
  const issueText = issue
    ? `\n\nIssue #${issue.number} as the Lead received it: ${outside("issue", issue.title, 200)} (${outside("issue", issue.url, 300)})\n<issue>\n${outside("issue", issue.body, 4000)}\n</issue>`
    : "";
  const where = slot.id ? `in working copy ${slot.id}` : "in the project's own working copy";
  return `Lane ${lane.id} is open on ${lane.branch} (off ${lane.base}) ${where}, and its Lead ${lead} is starting. Gate: ${gate}. Reports and asks arrive as mail; nothing to wait for now.${issueText}`;
}

export const openLane: Tool = async (desk, caller, args) => {
  const { ctx, slots, agents } = desk;
  const { project } = caller;
  const config = loadConfig(project.state);
  const base = str(args.base) || config.base || (await currentBranch(project.root)) || "main";
  if (!(await branchExists(project.root, base))) return no(`The base branch ${base} does not exist.`);
  // Seeded only when unanswered: `config.gate` is "" when the owner answered "no gate".
  if (!config.base || config.gate === undefined) {
    caller.revalidate?.();
    const fault = configFault(configFile(project.state));
    if (fault) return no(`${fault}\nOnly the Human can repair it or move it aside — no seat may write the desk's own files — so tell them; the desk will not write its own defaults over a file it could not read.`);
    saveConfig(project.state, { ...config, base: config.base ?? base, gate: config.gate ?? detectGate(project.root) });
  }
  const open = Object.values(loadLedger(project.state).lanes).filter((lane) => lane.status === "open");
  // One checkout is one branch: a second lane gets its own copy rather than switching the first lane's.
  const ownCopy = args.isolate === true || open.some((lane) => !lane.slot);
  const detourOf = str(args.detourOf);
  // A detour must name a real open lane, or the letter back out of it has nowhere to go.
  if (detourOf && !open.some((lane) => lane.id === detourOf.trim().toUpperCase())) return no(`There is no open lane ${detourOf} for this one to clear the way for.`);
  const serial = open.length > 0 ? serialPaths(await trackedFiles(project.root), config.serialOnly) : [];
  const problem = scopeProblem(serial, open, strs(args.writeSet), strs(args.contracts));
  if (problem) return no(problem);
  const { issue, unread } = await readIssue(args, project);
  const lane = await recordLane(desk, caller, args, base, issue);
  // Cleanup restores the project's own copy too; by slot id alone it stayed on the lane's branch.
  const fail = async (reason: string, taken?: { id?: string }) => {
    await ctx.ledger(project, (ledger) => {
      const entry = ledger.lanes[lane.id];
      if (entry) entry.status = "closed";
    });
    if (taken?.id) await slots.release(project, taken.id, lane.branch, base);
    else if (taken) await slots.giveBack(project, base, lane.branch);
    return no(reason);
  };
  let slot: { id?: string; path: string; workspaceId?: string };
  try {
    caller.revalidate?.();
    slot = ownCopy ? await slots.acquire(project, lane.branch, base, { lane: lane.id }) : await slots.inPlace(project, lane.branch, base);
  } catch (error) {
    return fail(`The lane could not get a working copy: ${errorText(error)}`);
  }
  try {
    const askedLead = str(args.role);
    const leadRole = roleThatCan(ctx.kit, "lead", askedLead || undefined);
    if (!leadRole) return fail(namedOrNot(ctx.kit, "lead", askedLead, "lead a lane"), slot);
    caller.revalidate?.();
    const lead = await agents.start(project, slot, leadRole.role, {
      parent: caller.id,
      title: `${lane.id} ${lane.title}`,
      prompt: letters.directive(lane, issue, conceptFile(project.state), gateRegime(project)),
      labels: { "seatworks.lane": lane.id, "seatworks.role": leadRole.role },
    });
    await ctx.ledger(project, (ledger) => {
      const entry = ledger.lanes[lane.id];
      if (entry) Object.assign(entry, { lead, worktree: slot.path, slot: slot.id, workspaceId: slot.workspaceId });
      ledger.agents[lead] = { id: lead, role: leadRole.role, lane: lane.id };
    });
    ctx.event(project, { kind: "lane.opened", lane: lane.id, lead, branch: lane.branch, base, slot: slot.id ?? "in place" });
    const unshared = slot.id && (await blockUncommitted(project.root))
      ? "\n\nThe team block in AGENTS.md and CLAUDE.md is not committed, so this lane's copy was made without it: ask the Human to commit those two files now."
      : "";
    return ok(`${openedReply(project, lane, slot, lead, issue)}${unshared}${unread ? `\n\nThe issue was not read into the lane: ${clip(unread, 300)}. The Lead has the outcome and the checks; give it the issue yourself if it needs one.` : ""}`);
  } catch (error) {
    return fail(`The Lead could not start: ${errorText(error)}`, slot);
  }
};

/** Merges base into the lane in its own copy; never under a seat mid-turn there, and an unseen seat counts as writing. */
async function bringBaseIn(roster: Roster, ledger: Ledger, lane: Lane, revalidate?: () => void): Promise<{ why: string; writers?: string[] } | undefined> {
  if (!lane.worktree) return { why: `it has no working copy on record to merge ${lane.base} into.` };
  if (await isAncestor(lane.worktree, lane.base, lane.branch)) return undefined;
  const writers = [lane.lead, ...tasksOf(ledger, lane.id).filter((task) => task.mode !== "parallel").map((task) => task.peer)];
  const writing = await Promise.all(
    writers.map(async (id) => {
      if (typeof id !== "string") return false;
      try {
        const seat = await roster.look(id);
        return !seat.archivedAt && (seat.status === "running" || seat.status === "initializing");
      } catch {
        return true;
      }
    }),
  );
  const busy = writers.filter((id, index): id is string => typeof id === "string" && writing[index] === true);
  if (busy.length > 0) {
    return {
      why: `${lane.base} has moved on, so landing it starts with merging ${lane.base} into ${lane.branch} in its copy, and a seat is mid-turn there. CAN LAND comes as mail when that turn ends; close it again then, or close it with land false.`,
      writers: busy,
    };
  }
  revalidate?.();
  const merged = await mergeBranch(lane.worktree, lane.base, `Bring ${lane.base} into ${lane.branch}`);
  if (merged.ok) return undefined;
  const why = merged.conflicts.length > 0 ? `conflicts in ${merged.conflicts.join(", ")}` : merged.message;
  return { why: `${lane.base} has moved on and does not merge into ${lane.branch}: ${why}. Nothing was changed. Message its Lead to merge ${lane.base} into the lane and settle it, or close it with land false.` };
}

export const closeLane: Tool = async ({ ctx, roster, slots, agents, merges }, caller, args) => {
  const { project } = caller;
  const ledger = loadLedger(project.state);
  const lane = findLane(ledger, str(args.lane));
  if (!lane) return no(`There is no lane ${str(args.lane)}.`);
  if (lane.status !== "open") return no(`Lane ${lane.id} is already closed.`);
  // Wait for queued merges: they run in the lane's copy, which closing gates, lands and removes.
  await merges.settled(project);
  caller.revalidate?.();
  let landing = `the branch ${lane.branch} is kept for the Human`;
  if (args.land === true) {
    // Land before closing: a closed lane cannot be closed again, so a landing that cannot happen is refused while open.
    const synced = await bringBaseIn(roster, ledger, lane, caller.revalidate);
    if (synced?.writers) {
      await ctx.ledger(project, (current) => {
        const entry = current.lanes[lane.id];
        if (entry) entry.landing = { by: caller.id, writers: synced.writers! };
      });
    }
    if (synced) return no(`Lane ${lane.id} was not closed: ${synced.why}`);
    const gate = await laneGate(ctx, project, lane);
    // A red gate stops landing unless the Supervisor passes `overGate`: the verdict is evidence, not a veto.
    if (!gate.ok && args.overGate !== true) {
      return no(`Lane ${lane.id} was not closed: ${gate.text}\nMessage its Lead, close it with land false, or land it over the gate with overGate true — that is your call.`);
    }
    caller.revalidate?.();
    const result = await landLane(project.root, lane.base, lane.branch);
    if (!result.landed) return no(`Lane ${lane.id} was not closed: it could not land, because ${result.how}. Close it again once that is cleared, or close it with land false.`);
    if (!gate.ok) ctx.event(project, { kind: "gate.overridden", lane: lane.id, by: caller.id });
    landing = `${result.how}${gate.ok ? "" : ", over a red gate"}`;
  }
  const retired = await ctx.ledger(project, (current) => {
    caller.revalidate?.();
    const entry = current.lanes[lane.id];
    if (entry) entry.status = "closed";
    const tasks: Task[] = [];
    for (const task of Object.values(current.tasks).filter((item) => item.lane === lane.id)) {
      if (["running", "rework", "queued", "done", "failed", "stalled"].includes(task.status)) task.status = "cut";
      tasks.push({ ...task });
    }
    return tasks;
  });
  const kept: string[] = [];
  for (const task of retired) {
    const branch = await agents.retire(project, task, lane.branch);
    if (branch) kept.push(branch);
  }
  await roster.archive(lane.lead);
  // Mid-turn seats are still writing in the lane's copy; it goes when their turn ends, not under them.
  const writers = [lane.lead, ...retired.filter((task) => task.mode !== "parallel").map((task) => task.peer)].filter(
    (id): id is string => typeof id === "string" && roster.pendingArchive.has(id),
  );
  const drop = args.land === true ? { dropBranch: lane.branch, into: lane.base } : {};
  const branch = await slots.putAway({ project, slot: lane.slot, restore: lane.base, lane: lane.id, branch: lane.branch, ...drop }, writers);
  if (branch) kept.push(branch);

  if (lane.detourOf) {
    const waiting = loadLedger(project.state).lanes[lane.detourOf];
    if (waiting?.status === "open" && waiting.lead) await ctx.post(waiting.lead, `detour:${lane.id}:${Date.now()}`, letters.detourLanded(lane, waiting, landing), caller.project);
  }
  ctx.event(project, { kind: "lane.closed", lane: lane.id, land: args.land === true, landing, reason: str(args.reason), writers });
  const copy =
    writers.length > 0
      ? `Its working copy is put away once ${writers.join(" and ")} finish the turn they are in.`
      : "Its working copy is free for the next lane.";
  const branches = kept.length > 0 ? ` ${kept.join(" and ")} ${kept.length === 1 ? "holds commits" : "hold commits"} nothing else has and ${kept.length === 1 ? "is" : "are"} kept.` : "";
  return ok(`Lane ${lane.id} closed and its agents archived; ${landing}. ${copy}${branches}`);
};

export const setProject: Tool = async (_desk, caller, args) => {
  // Refused as open_lane refuses: read as all defaults, an unreadable file was saved over with them.
  const unreadable = configFault(configFile(caller.project.state));
  if (unreadable) return no(`${unreadable}\nOnly the Human can repair it or move it aside; nothing was saved over it.`);
  const config = loadConfig(caller.project.state);
  const base = str(args.base);
  if (base && !(await branchExists(caller.project.root, base))) return no(`The branch ${base} does not exist.`);
  const minutes = Number(args.gateTimeoutMinutes);
  const next: ProjectConfig = {
    ...config,
    base: base || config.base,
    gate: typeof args.gate === "string" ? args.gate.trim() : config.gate,
    gateTimeoutMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : config.gateTimeoutMinutes,
    gateOn: args.gateOn === "task" ? "task" : args.gateOn === "lane" ? "lane" : config.gateOn,
    serialOnly: Array.isArray(args.serialOnly) ? strs(args.serialOnly) : config.serialOnly,
  };
  caller.revalidate?.();
  saveConfig(caller.project.state, next);
  return ok(`Base ${next.base ?? "unset"}; gate ${next.gate || "none"}, run per ${next.gateOn}; gate timeout ${next.gateTimeoutMinutes} minutes.`);
};
