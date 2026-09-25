import { existsSync } from "node:fs";
import { roleThatCan } from "../../catalog/kit.ts";
import { configFault } from "../../core/config-file.ts";
import { errorText } from "../../core/errors.ts";
import { LAND_AS, branchExists, currentBranch, headSha, isAncestor, landLane, landedRef, mergeBranch } from "../../core/git.ts";
import { blockUncommitted } from "../../catalog/project-files.ts";
import { type Args, type Caller, type ToolReply, given, no, ok, str, strs } from "../context.ts";
import { laneGate } from "../gates.ts";
import { type Issue, fetchIssue } from "../issue.ts";
import { type Lane, type Ledger, type Task, amend, findLane, loadLedger, nextLaneId, slugify, tasksOf } from "../ledger.ts";
import { clip, letters } from "../letters.ts";
import { type Project, type ProjectConfig, configFile, detectGate, loadConfig, saveConfig } from "../project.ts";
import type { Roster } from "../roster.ts";
import type { DeskServices, Tool } from "../services.ts";
import { directiveFor, leadSeatOf, overlap, openedReply, placement, seatingKey, startLead } from "../opening.ts";
import { openWaiting, waitsFor } from "../waiting.ts";
import { namedOrNot } from "./shared.ts";
import { decidePlan } from "../approval.ts";
import { keepRun } from "../checkpoints.ts";
import { seatCritic } from "../critique.ts";
import { GATE_FAILED, NOT_READY, landCheck } from "../landing.ts";

/** An unreadable issue ref is a note on the lane, never a reason to refuse opening it. */
async function readIssue(args: Args, project: Project): Promise<{ issue?: Issue; unread?: string }> {
  const ref = str(args.issue);
  if (!ref) return {};
  const fetched = await fetchIssue(ref, project.root);
  return "error" in fetched ? { unread: `${ref} could not be read: ${fetched.error}` } : { issue: fetched };
}

function recordLane(desk: DeskServices, caller: Caller, args: Args, place: { base: string; onBranch: boolean; branch?: string }, issue: Issue | undefined, after?: string[]): Promise<Lane> {
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
      base: place.base,
      branch: place.branch ?? `lane/${id.toLowerCase()}-${slugify(title, 24)}`,
      detourOf: str(args.detourOf).trim().toUpperCase() || undefined,
      onBranch: place.onBranch || undefined,
      writeSet: strs(args.writeSet),
      contracts: strs(args.contracts),
      opener: caller.id,
      status: after ? "waiting" : "open",
      after,
      // What decides how it opens, kept for when it does: the call that asked for it is long gone by then.
      opening: after && (args.isolate === true || str(args.role)) ? { isolate: args.isolate === true || undefined, role: str(args.role) || undefined } : undefined,
      openedAt: Date.now(),
      tasks: 0,
    };
    ledger.lanes[id] = lane;
    if (!after) desk.ctx.seating.add(seatingKey(caller.project, id));
    return { ...lane };
  });
}

export const openLane: Tool = async (desk, caller, args) => {
  const { project } = caller;
  const config = loadConfig(project.state);
  const onBranch = args.onBranch === true;
  const newBranch = str(args.newBranch).trim();
  const after = [...new Set(strs(args.after).map((id) => id.trim().toUpperCase()))];
  const here = await currentBranch(project.root);
  if (newBranch && !onBranch) return no("newBranch goes with onBranch: it starts the branch the lane then carries on.");
  if (onBranch && (args.isolate === true || str(args.base))) return no("onBranch carries on the branch the project's own copy is on, in that copy, so it takes no base and no isolate.");
  if (onBranch && !here) return no("The project's own copy is not on a branch, so there is no branch to carry on; open the lane without onBranch to start one.");
  if (newBranch && after.length > 0) return no("A lane that waits cannot start a branch from the copy as it is now: that is not the copy it will open in. Wait without newBranch, and start the branch when its turn comes.");
  if (newBranch && (await branchExists(project.root, newBranch))) return no(`The branch ${newBranch} already exists; carry it on after switching to it, or pick another name with the Human.`);
  const pending = after.length > 0 ? waitsFor(loadLedger(project.state), after, onBranch) : [];
  if (typeof pending === "string") return no(`${pending} Open this lane without waiting for it.`);
  const carried = pending.find((lane) => lane.onBranch)?.branch;
  const base = onBranch ? carried ?? (newBranch || here!) : str(args.base) || config.base || here || "main";
  if (!newBranch && !(await branchExists(project.root, base))) return no(`The base branch ${base} does not exist.`);
  // Seeded only when unanswered: `config.gate` is "" when the owner answered "no gate". A branch carried on is not a base.
  if (!config.base || config.gate === undefined) {
    caller.revalidate?.();
    const fault = configFault(configFile(project.state));
    if (fault) return no(`${fault}\nOnly the Human can repair it or move it aside — no seat may write the desk's own files — so tell them; the desk will not write its own defaults over a file it could not read.`);
    saveConfig(project.state, { ...config, base: config.base ?? (onBranch ? undefined : base), gate: config.gate ?? detectGate(project.root) });
  }
  const place = { base, onBranch, branch: onBranch ? base : undefined };
  if (pending.length > 0) {
    const { issue } = await readIssue(args, project);
    const lane = await recordLane(desk, caller, args, place, issue, after);
    desk.ctx.event(project, { kind: "lane.waiting", lane: lane.id, after });
    await seatCritic(desk, project, lane);
    return ok(`Lane ${lane.id} waits for ${pending.map((entry) => `${entry.id} (${entry.status})`).join(", ")}. It opens by itself once they have all landed, checked again against the lanes open then; if it cannot, or one closes without landing, you get a letter. Close it to drop it.`);
  }
  const placed = await placement(project, { onBranch, writeSet: strs(args.writeSet), contracts: strs(args.contracts), detourOf: str(args.detourOf).trim().toUpperCase() || undefined }, args.isolate === true);
  if ("why" in placed) return no(`${placed.why} ${placed.instead}`.trim());
  const { issue, unread } = await readIssue(args, project);
  const lane = await recordLane(desk, caller, args, place, issue);
  const started = await startLead(desk, project, lane, { ownCopy: placed.ownCopy, failed: "closed", from: newBranch ? here : undefined, role: str(args.role), parent: caller.id, issue, revalidate: caller.revalidate });
  if (typeof started === "string") return no(started);
  await seatCritic(desk, project, lane);
  const unshared = started.slot.id && (await blockUncommitted(project.root))
    ? "\n\nThe team block in AGENTS.md and CLAUDE.md is not committed, so this lane's copy was made without it: ask the Human to commit those two files now."
    : "";
  return ok(`${openedReply(project, lane, started.slot, started.lead, issue)}${unshared}${unread ? `\n\nThe issue was not read into the lane: ${clip(unread, 300)}. The Lead has the outcome and the checks; give it the issue yourself if it needs one.` : ""}`);
};

/**
 * Merges base into the lane in its own copy; never under a seat mid-turn there, and an unseen seat counts as writing.
 * `why` is what stops it, for anyone; `then` is what the Supervisor can do about it.
 */
async function bringBaseIn(roster: Roster, ledger: Ledger, lane: Lane, revalidate?: () => void): Promise<{ why: string; then: string; writers?: string[] } | undefined> {
  if (!lane.worktree) return { why: `it has no working copy on record to merge ${lane.base} into`, then: "Close it with land false." };
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
      why: `${lane.base} has moved on, so landing it starts with merging ${lane.base} into ${lane.branch} in its copy, and a seat is mid-turn there`,
      then: "CAN LAND comes as mail when that turn ends; close it again then, or close it with land false.",
      writers: busy,
    };
  }
  revalidate?.();
  const merged = await mergeBranch(lane.worktree, lane.base, `Bring ${lane.base} into ${lane.branch}`);
  if (merged.ok) return undefined;
  const why = merged.conflicts.length > 0 ? `conflicts in ${merged.conflicts.join(", ")}` : merged.message;
  return { why: `${lane.base} has moved on and does not merge into ${lane.branch}: ${why}`, then: `Nothing was changed. Message its Lead to merge ${lane.base} into the lane and settle it, or close it with land false.` };
}

/** What a lane lands under as one commit or a merge: its title, its outcome and the tasks that went into it. */
function landMessage(ledger: Ledger, lane: Lane): string {
  const tasks = tasksOf(ledger, lane.id).filter((task) => task.kind === "code" && task.status === "merged");
  return [`${lane.title} (${lane.id})`, "", lane.outcome, ...(tasks.length > 0 ? ["", ...tasks.map((task) => `- ${task.id} ${task.title}`)] : [])].join("\n");
}

type Held = NonNullable<Lane["landApproval"]>;

/**
 * The land check: off, nothing; shadow, recorded and landed; on, held for the Human on a signal or when every landing is.
 * An approval stands for the signals it was given: anything new that landing turns up holds it again, but a missing READY is the Lead's to give.
 */
async function checkLanding(desk: DeskServices, project: Project, lane: Lane, gateOk: boolean, by: string, overGate: boolean, approved?: Held): Promise<{ held?: string; blocked?: string; note: string }> {
  const { ctx } = desk;
  const checks = ctx.team(project).checkpoints;
  const mode = checks.land;
  if (mode === "off") return { note: "" };
  const { signals, evidence } = await landCheck(project, loadLedger(project.state), lane, { set: Boolean(loadConfig(project.state).gate), ok: gateOk }, checks);
  const asks = signals.length > 0 || checks.landApprove === "every";
  const fresh = approved ? signals.filter((signal) => !approved.signals.includes(signal)) : signals;
  if (approved && fresh.length > 0 && fresh.every((signal) => signal === NOT_READY)) return { blocked: "its Lead has not reported it ready as it now stands", note: "" };
  const reason = signals.length > 0 ? signals.join(" ") : "this project approves every landing.";
  if (!approved || fresh.length > 0) keepRun(project, { checkpoint: "land", mode, lane: lane.id, by, decision: asks ? "ask" : "pass", findings: signals });
  if (mode === "on" && (approved ? fresh.length > 0 : asks)) {
    const head = (await headSha(project.root, lane.branch)) ?? "";
    await ctx.ledger(project, (current) => {
      const entry = current.lanes[lane.id];
      if (entry) entry.landApproval = { since: Date.now(), head, signals, evidence, overGate };
    });
    ctx.event(project, { kind: "land.held", lane: lane.id, signals: signals.length });
    await ctx.post(lane.lead, `landheld:${lane.id}:${head}`, letters.landHeld(lane, reason));
    return { held: `Lane ${lane.id} was not landed: it waits for the Human's approval, on its card in Seatworks, because ${reason}\n\nEvidence: ${evidence.join(" ")}\n\nYou cannot approve it; tell them it waits, and why. LANDED or SENT BACK comes as mail.`, note: "" };
  }
  const verdict = approved
    ? "Land check (on): the Human approved it."
    : mode === "shadow" && asks
      ? `Land check (shadow): the Human would have been asked, because ${reason}`
      : `Land check (${mode}): nothing held it.`;
  return { note: `\n\n${verdict}\nEvidence: ${evidence.join(" ")}` };
}

export const closeLane: Tool = (desk, caller, args) => close(desk, caller.project, caller.id, args, caller.revalidate);

/** Closes a lane for `by`: the Supervisor that called, or the one the Human's approval lands it for. `blocked` is what kept a landing from happening. */
async function close(desk: DeskServices, project: Project, by: string, args: Args, revalidate?: () => void): Promise<ToolReply & { blocked?: string }> {
  const { ctx, roster, slots, agents, merges } = desk;
  const ledger = loadLedger(project.state);
  const lane = findLane(ledger, str(args.lane));
  if (!lane) return no(`There is no lane ${str(args.lane)}.`);
  if (lane.status === "waiting") {
    if (args.land === true) return no(`Lane ${lane.id} never opened, so there is nothing to land; close it with land false to drop it.`);
    await ctx.ledger(project, (current) => {
      const entry = current.lanes[lane.id];
      if (entry?.status === "waiting") entry.status = "closed";
    });
    ctx.event(project, { kind: "lane.closed", lane: lane.id, land: false, landing: "dropped while waiting", reason: str(args.reason), writers: [] });
    return ok(`Lane ${lane.id} was waiting and is dropped; nothing had started for it.`);
  }
  if (lane.status !== "open") return no(`Lane ${lane.id} is already closed.`);
  // Wait for queued merges: they run in the lane's copy, which closing gates, lands and removes.
  await merges.settled(project);
  revalidate?.();
  let landing = `the branch ${lane.branch} is kept for the Human`;
  let checked = "";
  if (args.land === true) {
    const held = lane.landApproval;
    const tip = await headSha(project.root, lane.branch);
    // A commit after the hold makes it a lane nobody has looked at: it is checked again from the start.
    const approved = held?.approved && held.head === tip ? held : undefined;
    if (held && !held.approved && held.head === tip) {
      const checks = ctx.team(project).checkpoints;
      // No commit since the hold, so the gate's verdict then still stands; READY, the write set and incidents are read again.
      const now = await landCheck(project, ledger, lane, { set: Boolean(loadConfig(project.state).gate), ok: !held.signals.includes(GATE_FAILED) }, checks);
      if (checks.land === "on" && (now.signals.length > 0 || checks.landApprove === "every")) {
        await ctx.ledger(project, (current) => {
          const entry = current.lanes[lane.id]?.landApproval;
          if (entry && !entry.approved) Object.assign(entry, now);
        });
        return ok(`Lane ${lane.id} still waits for the Human's approval to land, since ${Math.round((Date.now() - held.since) / 60_000)} min ago, because ${now.signals.join(" ") || "this project approves every landing."} LANDED or SENT BACK comes as mail.`);
      }
    }
    // Land before closing: a closed lane cannot be closed again, so a landing that cannot happen is refused while open.
    const synced = await bringBaseIn(roster, ledger, lane, revalidate);
    if (synced?.writers) {
      await ctx.ledger(project, (current) => {
        const entry = current.lanes[lane.id];
        if (entry) entry.landing = { by, writers: synced.writers! };
      });
    }
    if (synced) return { ...no(`Lane ${lane.id} was not closed: ${synced.why}. ${synced.then}`), blocked: synced.why };
    const merged = approved ? await headSha(project.root, lane.branch) : tip;
    // Base merged in by the desk itself is not the lane changing under an approval.
    if (approved && merged && merged !== tip) {
      await ctx.ledger(project, (current) => {
        const entry = current.lanes[lane.id]?.landApproval;
        if (entry) entry.head = merged;
      });
    }
    const gate = await laneGate(ctx, project, lane);
    // A red gate stops landing unless the Supervisor passes `overGate`: the verdict is evidence, not a veto.
    if (!gate.ok && args.overGate !== true) {
      return { ...no(`Lane ${lane.id} was not closed: ${gate.text}\nMessage its Lead, close it with land false, or land it over the gate with overGate true — that is your call.`), blocked: gate.text.split("\n")[0]!.replace(/\.$/, "") };
    }
    if (!lane.onBranch) {
      const check = await checkLanding(desk, project, lane, gate.ok, by, args.overGate === true, approved);
      if (check.held) return ok(check.held);
      if (check.blocked) return { ...no(`Lane ${lane.id} was not landed: ${check.blocked}. The Human's approval stands; close_lane with land true lands it once that is cleared.`), blocked: check.blocked };
      checked = check.note;
    }
    revalidate?.();
    const how = { as: loadConfig(project.state).landAs, message: landMessage(ledger, lane), keep: landedRef(lane.id) };
    const result = lane.onBranch ? { landed: true, how: `the work stays on ${lane.branch}, the branch it carried on; nothing was merged anywhere` } : await landLane(project.root, lane.base, lane.branch, how);
    if (!result.landed) return { ...no(`Lane ${lane.id} was not closed: it could not land, because ${result.how}. Close it again once that is cleared, or close it with land false.`), blocked: result.how };
    if (!gate.ok) ctx.event(project, { kind: "gate.overridden", lane: lane.id, by });
    landing = `${result.how}${gate.ok ? "" : ", over a red gate"}`;
  }
  const retired = await ctx.ledger(project, (current) => {
    revalidate?.();
    const entry = current.lanes[lane.id];
    if (entry) Object.assign(entry, { status: "closed", landed: args.land === true || undefined });
    delete entry?.landApproval;
    const tasks: Task[] = [];
    for (const task of Object.values(current.tasks).filter((item) => item.lane === lane.id)) {
      if (["waiting", "running", "rework", "queued", "done", "failed", "stalled"].includes(task.status)) task.status = "cut";
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
  // A branch carried on is the Human's: nothing switches the copy off it or deletes it.
  if (!lane.onBranch) {
    const drop = args.land === true ? { dropBranch: lane.branch, into: landedRef(lane.id) } : {};
    const branch = await slots.putAway({ project, slot: lane.slot, restore: lane.base, lane: lane.id, branch: lane.branch, ...drop }, writers);
    if (branch) kept.push(branch);
  }

  if (lane.detourOf) {
    const waiting = loadLedger(project.state).lanes[lane.detourOf];
    if (waiting?.status === "open" && waiting.lead) await ctx.post(waiting.lead, `detour:${lane.id}:${Date.now()}`, letters.detourLanded(lane, waiting, landing), project);
  }
  ctx.event(project, { kind: "lane.closed", lane: lane.id, land: args.land === true, landing, reason: str(args.reason), writers });
  const copy = lane.onBranch
    ? `The project's own copy stays on ${lane.branch}.`
    : writers.length > 0
      ? `Its working copy is put away once ${writers.join(" and ")} finish the turn they are in.`
      : "Its working copy is free for the next lane.";
  const branches = kept.length > 0 ? ` ${kept.join(" and ")} ${kept.length === 1 ? "holds commits" : "hold commits"} nothing else has and ${kept.length === 1 ? "is" : "are"} kept.` : "";
  await openWaiting(desk, project, true);
  return ok(`Lane ${lane.id} closed and its agents archived; ${landing}. ${copy}${branches}${checked}`);
}

/**
 * The Human's word on a held landing. Approved, the desk lands it now for the Supervisor; what stops it (a seat mid-turn,
 * a dirty copy) leaves the approval standing for the next `close_lane`. Sent back, the lane stays open with their note.
 */
export async function decideLand(desk: DeskServices, project: Project, laneId: string, approve: boolean, note: string): Promise<ToolReply> {
  const { ctx } = desk;
  const lane = loadLedger(project.state).lanes[laneId];
  const held = lane?.status === "open" ? lane.landApproval : undefined;
  if (!lane || !held || held.approved) return no(`Lane ${laneId} has no landing waiting for your approval.`);
  const supervisor = await desk.roster.supervisorFor(project, lane.opener);
  const tell = (how: Parameters<typeof letters.landDecided>[1], text: string) => ctx.post(supervisor, `land:${laneId}:${how}:${Date.now()}`, letters.landDecided(lane, how, text), project);
  const drop = () =>
    ctx.ledger(project, (current) => {
      delete current.lanes[laneId]?.landApproval;
    });
  if ((await headSha(project.root, lane.branch)) !== held.head) {
    await drop();
    await tell("changed", "");
    return ok(`Lane ${laneId} changed after it was held, so this approval is not for what it holds now. It is checked again when the Supervisor lands it.`);
  }
  keepRun(project, { checkpoint: "land", mode: "on", lane: laneId, by: "human", decision: approve ? "approved" : "sent back", findings: note ? [note] : [], waitedMs: Date.now() - held.since });
  ctx.event(project, { kind: approve ? "land.approved" : "land.sentBack", lane: laneId });
  if (!approve) {
    await drop();
    await ctx.post(lane.lead, `landback:${laneId}:${held.head}`, letters.landSentBack(lane, note));
    await tell("sent back", note);
    return ok(`Lane ${laneId} is sent back to its Lead with your note; it stays open.`);
  }
  await ctx.ledger(project, (current) => {
    const entry = current.lanes[laneId]?.landApproval;
    if (entry) entry.approved = { at: Date.now(), note };
  });
  const closed = await close(desk, project, supervisor ?? lane.opener, { lane: laneId, land: true, overGate: held.overGate });
  const now = loadLedger(project.state).lanes[laneId];
  const said = `${note ? `${note}. ` : ""}${closed.text}`;
  if (now?.status === "closed") {
    await tell("landed", said);
    return ok(`Approved: ${closed.text}`);
  }
  if (now?.landApproval && !now.landApproval.approved) {
    await tell("again", closed.text);
    return ok(`Approved, but landing lane ${laneId} turned up more, so it waits for you again: ${closed.text}`);
  }
  const blocked = closed.blocked ?? closed.text;
  await tell("blocked", blocked);
  return ok(`Approved. It could not land yet: ${blocked}. The Supervisor lands it once that is cleared.`);
}

/**
 * The Human's Merge on a ready card is their approval. With the land check on, it is recorded before the Supervisor
 * lands the lane, so the check does not hold it for them again; anything new that landing turns up still does.
 */
export async function approveReady(desk: DeskServices, project: Project, laneId: string): Promise<ToolReply> {
  const { ctx } = desk;
  const ledger = loadLedger(project.state);
  const lane = ledger.lanes[laneId];
  if (!lane || lane.status !== "open") return no(`Lane ${laneId} is not open.`);
  const checks = ctx.team(project).checkpoints;
  if (checks.land !== "on" || lane.onBranch) return ok(`Nothing to record: the land check does not hold lane ${laneId}.`);
  if (lane.landApproval && !lane.landApproval.approved) return no(`Lane ${laneId} already waits for your approval on its own card.`);
  const head = await headSha(project.root, lane.branch);
  if (!head) return no(`Lane ${laneId} has no branch ${lane.branch} to approve.`);
  const { signals, evidence } = await landCheck(project, ledger, lane, { set: Boolean(loadConfig(project.state).gate), ok: true }, checks);
  if (signals.includes(NOT_READY)) return no(`Lane ${laneId} is not reported ready as it now stands, so there is nothing to approve yet.`);
  const at = Date.now();
  await ctx.ledger(project, (current) => {
    const entry = current.lanes[laneId];
    if (entry) entry.landApproval = { since: at, head, signals, evidence, overGate: false, approved: { at, note: "Approved on its card." } };
  });
  keepRun(project, { checkpoint: "land", mode: "on", lane: laneId, by: "human", decision: "approved", findings: signals, waitedMs: 0 });
  ctx.event(project, { kind: "land.approved", lane: laneId });
  return ok(`Lane ${laneId} is approved to land as it stands at ${head.slice(0, 7)}.`);
}

/** Changes what a lane is asked while it is open or waiting, keeping what it was asked before; its Lead is told what moved. */
export const amendLane: Tool = async ({ ctx }, caller, args) => {
  const { project } = caller;
  const changes = given(args, ["outcome"], ["acceptance", "outOfScope", "writeSet", "contracts"]);
  if (changes.outcome === "" || changes.acceptance?.length === 0) return no("A lane keeps an outcome and at least one acceptance line; give what it is asked now.");
  const ledger = loadLedger(project.state);
  const lane = findLane(ledger, str(args.lane));
  if (!lane) return no(`There is no lane ${str(args.lane)}.`);
  if (lane.status === "closed") return no(`Lane ${lane.id} is closed; ask for the work again with open_lane.`);
  if (lane.status === "open" && (changes.writeSet || changes.contracts)) {
    const others = Object.values(ledger.lanes).filter((entry) => entry.status === "open" && entry.id !== lane.id);
    const problem = await overlap(project, others, (changes.writeSet ?? lane.writeSet) as string[], (changes.contracts ?? lane.contracts) as string[]);
    if (problem) return no(`${problem.why} Leave those paths out of this lane, or ask for that work in a lane that waits for the other.`);
  }
  const done = await ctx.ledger(project, (current) => {
    const entry = current.lanes[lane.id];
    const amendment = entry && entry.status !== "closed" ? amend(entry, changes, caller.id, str(args.why)) : undefined;
    if (amendment) delete entry!.ready;
    return amendment && { lane: { ...entry! }, amendment };
  });
  if (!done) return no(`Nothing about lane ${lane.id} would change; pass the fields it is asked differently now.`);
  ctx.event(project, { kind: "lane.amended", lane: lane.id, fields: Object.keys(done.amendment.was), by: caller.id });
  if (done.lane.status === "waiting") return ok(`Lane ${lane.id} is amended; it opens as it is now.`);
  const posted = await ctx.post(done.lane.lead, `amended:${lane.id}:${done.lane.amended!.length}`, letters.amended(done.lane, done.amendment, "lead"));
  return ok(`Lane ${lane.id} is amended${posted === "nobody" ? ", and it has no Lead to tell" : " and its Lead has the change"}; a READY it reported before no longer stands.`);
};

/** Seats a new Lead on an open lane whose Lead is gone, where the lane stands; a Lead Paseo already started for it is taken on instead. */
export const replaceLead: Tool = async ({ ctx, roster, agents }, caller, args) => {
  const { project } = caller;
  const lane = findLane(loadLedger(project.state), str(args.lane));
  if (!lane) return no(`There is no lane ${str(args.lane)}.`);
  if (lane.status !== "open") return no(`Lane ${lane.id} is ${lane.status}; only an open lane has a Lead to replace.`);
  const seats = await roster.open();
  // An empty listing is a daemon that answered nothing, not word that the Lead is gone.
  if (seats.length === 0) return no("Paseo listed no agents just now, so whether the lane's Lead is still seated cannot be told; try again.");
  if (seats.some((seat) => seat.id === lane.lead)) return no(`Lane ${lane.id}'s Lead ${lane.lead} is still seated; message it instead.`);
  const key = seatingKey(project, lane.id);
  const claimed = await ctx.ledger(project, (ledger) => {
    const entry = ledger.lanes[lane.id];
    if (entry?.status !== "open" || entry.lead !== lane.lead || ctx.seating.has(key)) return false;
    ctx.seating.add(key);
    return true;
  });
  if (!claimed) return no(`Lane ${lane.id} changed while this was asked; read status and ask again if its Lead is still gone.`);
  try {
    const started = leadSeatOf(seats, project, lane.id);
    let lead = started?.id;
    let role = started?.labels?.["seatworks.role"];
    if (!lead) {
      const leadRole = roleThatCan(ctx.kit, "lead", str(args.role) || undefined);
      if (!leadRole) return no(namedOrNot(ctx.kit, "lead", str(args.role), "lead a lane"));
      if (!lane.worktree || !existsSync(lane.worktree)) return no(`Lane ${lane.id} has no working copy left${lane.worktree ? ` at ${lane.worktree}` : ""}; close it and open the work again.`);
      const fetched = lane.issue ? await fetchIssue(lane.issue, project.root) : undefined;
      try {
        lead = await agents.start(project, { path: lane.worktree, workspaceId: lane.workspaceId }, leadRole.role, {
          parent: caller.id,
          title: `${lane.id} ${lane.title}`,
          prompt: `${letters.takeover(lane, lane.lead ?? "its first Lead")}\n\n${directiveFor(project, lane, fetched && !("error" in fetched) ? fetched : undefined)}`,
          labels: { "seatworks.lane": lane.id, "seatworks.role": leadRole.role },
        });
      } catch (error) {
        return no(`The new Lead could not start: ${errorText(error)}`);
      }
      role = leadRole.role;
    }
    const moved = await ctx.ledger(project, (ledger) => {
      ledger.lanes[lane.id]!.lead = lead;
      ledger.agents[lead!] = { id: lead!, role: role ?? "lead", lane: lane.id };
      const asks = Object.values(ledger.asks).filter((ask) => ask.status === "open" && ask.to === lane.lead);
      for (const ask of asks) ask.to = lead!;
      return asks.length;
    });
    ctx.event(project, { kind: "lead.replaced", lane: lane.id, was: lane.lead ?? null, lead, adopted: Boolean(started) });
    const how = started ? `the Lead ${lead} that Paseo already had seated for it` : `a new Lead ${lead}, told it takes over where the lane stands`;
    const asks = moved > 0 ? ` The ${moved} open ask${moved === 1 ? "" : "s"} to the Lead that left now wait on it.` : "";
    return ok(`Lane ${lane.id} has ${how}.${asks}`);
  } finally {
    ctx.seating.delete(key);
  }
};

/** A plan held for the Supervisor's approval; one held for the Human is refused, since only the panel speaks for them. */
export const approvePlan: Tool = async (desk, caller, args) => {
  const decided = await decidePlan(desk, caller.project, str(args.lane).trim().toUpperCase(), args.approve === true, caller.id, str(args.note).trim());
  return decided.ok ? ok(decided.text) : no(decided.text);
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
    landAs: LAND_AS.find((as) => as === args.landAs) ?? config.landAs,
  };
  caller.revalidate?.();
  saveConfig(caller.project.state, next);
  return ok(`Base ${next.base ?? "unset"}; gate ${next.gate || "none"}, run per ${next.gateOn}; gate timeout ${next.gateTimeoutMinutes} minutes; lanes land as ${next.landAs}.`);
};
