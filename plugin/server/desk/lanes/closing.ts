import { conflictsWith, landedRef } from "../../core/git.ts";
import { midTurn } from "../../core/ports.ts";
import { plural } from "../../core/text.ts";
import { ASK } from "../../domain/ask.ts";
import { LANE } from "../../domain/lane.ts";
import { QUESTION } from "../../domain/question.ts";
import { TASK, openWork } from "../../domain/task.ts";
import { workKey } from "../claims.ts";
import { no, ok, str } from "../context.ts";
import { landLetters } from "../letters/land-letters.ts";
import type { Lane } from "../../domain/lane.ts";
import { type Ledger, findLane } from "../../domain/ledger.ts";
import type { Task } from "../../domain/task.ts";
import { loadLedger } from "../store/ledger.ts";
import { closeIncidentsOf } from "../watch/notice.ts";
import { type Project, readProjectConfig } from "../project/project.ts";
import type { Roster } from "../seats/roster.ts";
import type { DeskServices } from "../services.ts";
import { recordEvent } from "../store/event-log.ts";
import { stowCopy } from "../copies/stow.ts";
import { openWaiting } from "../waiting/lanes.ts";
import type { Closed } from "./land-hold.ts";
import { type Landed, landLane } from "./landing.ts";

type Closing = { lane: string; land: boolean; reason?: string; overGate?: boolean };

type Leftovers = { tasks: Task[]; cut: string[]; canceled: string[] };

/** Closes a lane for `by`, the Supervisor that called or the one the Human's approval lands it for. */
export async function closeLane(desk: DeskServices, project: Project, by: string, args: Closing): Promise<Closed> {
  const { closing, landings, merges } = desk;
  const ledger = loadLedger(project.state);
  const lane = findLane(ledger, str(args.lane));
  if (!lane) return no(`There is no lane ${str(args.lane)}.`);
  if (lane.status === "waiting") return dropWaiting(desk, project, lane, args);
  if (lane.status !== "open") return no(`Lane ${lane.id} is already closed.`);
  if (args.land && lane.onHold)
    return no(`Lane ${lane.id} is on hold: ${lane.onHold.reason}. ${whenHeld(ledger, lane)}`);
  // One close of a lane at a time: a second would land and retire it again, and both be told it closed.
  const key = workKey(project, lane.id);
  if (!closing.take(key))
    return no(`Lane ${lane.id} is already being closed by another call; read status once that call has answered.`);
  try {
    // Queued merges run in the copy closing gates, lands and removes: wait for them, one more try included.
    await merges.retry(project, lane.id);
    await merges.settled(project, lane.id);
    // One landing at a time moves a project's base; the next reads it again, bringing in what the last one landed.
    const landing = () => {
      const now = loadLedger(project.state);
      const over = { overGate: args.overGate === true, reason: str(args.reason) };
      return landLane(desk, project, now, now.lanes[lane.id] ?? lane, by, over);
    };
    const kept = { how: `the branch ${lane.branch} is kept`, note: "" };
    const landed = args.land ? await landings.run(`${project.slug}:land`, landing) : kept;
    if ("text" in landed) return landed;
    return await retire(desk, project, lane, args, landed);
  } finally {
    closing.release(key);
  }
}

/** How a held lane comes to land: a hold the desk put on for the Human's answer lifts once that question is settled. */
function whenHeld(ledger: Ledger, lane: Lane): string {
  const waiting = Object.values(ledger.questions).find(
    (question) => question.lane === lane.id && question.parked && question.status === "open",
  );
  return waiting
    ? `It waits for the Human's answer to ${waiting.id}: once they answer, decline or cancel it, or you withdraw it with withdraw_question, resume_lane it, then land it.`
    : "Resume it with resume_lane before landing it.";
}

function dropWaiting({ ledgers }: Pick<DeskServices, "ledgers">, project: Project, lane: Lane, args: Closing): Closed {
  if (args.land) return no(`Lane ${lane.id} never opened, so there is nothing to land; drop_lane drops it.`);
  ledgers.moveLane(project, lane.id, "drop");
  const reason = str(args.reason);
  recordEvent(project, {
    kind: "lane.closed",
    lane: lane.id,
    land: false,
    landing: "dropped while waiting",
    reason,
    writers: [],
  });
  return ok(`Lane ${lane.id} was waiting and is dropped; nothing had started for it.`);
}

/** Closes the lane on record and cuts what it had going: its Peers go, its Lead stays with any copy of its own. */
async function retire(
  desk: DeskServices,
  project: Project,
  lane: Lane,
  args: Closing,
  landed: Landed,
): Promise<Closed> {
  const { ledgers, mail, roster, agents } = desk;
  const left = ledgers.transact(project, (current) => {
    const entry = current.lanes[lane.id];
    if (entry && LANE.move(entry, "close"))
      Object.assign(entry, { landed: args.land || undefined, closedAt: Date.now() });
    delete entry?.landApproval;
    delete entry?.onHold;
    return settleLeftovers(current, lane);
  });
  for (const id of left.canceled)
    recordEvent(project, { kind: "question.answered", question: id, status: "canceled", by: "desk" });
  const branches: string[] = [];
  for (const task of left.tasks) {
    const branch = await agents.retire(project, task, args.land ? landedRef(lane.id) : lane.branch);
    if (branch) branches.push(branch);
  }
  const { kept, writers } = await leadAndWriters(roster, lane, left.tasks);
  const stowed = await stowCopy(desk, project, lane, left.tasks, { land: args.land, kept, writers });
  if (lane.lead) closeIncidentsOf(desk, project, lane.lead);
  if (kept) await mail.post(lane.lead, landLetters.closed(lane, args.land, landed.how));
  if (lane.detourOf) {
    const waiting = loadLedger(project.state).lanes[lane.detourOf];
    if (waiting?.status === "open" && waiting.lead)
      await mail.post(waiting.lead, landLetters.detourClosed(lane, waiting, landed.how, args.land));
  }
  const reason = str(args.reason);
  recordEvent(project, { kind: "lane.closed", lane: lane.id, land: args.land, landing: landed.how, reason, writers });
  const moved = args.land && !lane.onBranch ? await tellBaseMoved(desk, project, lane) : "";
  if (args.land && !lane.onBranch) await tellAudit(desk, project, lane, landed.how);
  const read = readProjectConfig(project.state);
  const base = "config" in read ? read.config.base : undefined;
  const sends = base ? `push sends ${base}` : "push sends the project's base, once set_project names it,";
  const out =
    args.land && !lane.onBranch && !desk.teamFor(project).hitl.on
      ? `\n\nGetting it out is yours while the Human is out of the loop: ${sends} to its remote, with a tag when it is a release.`
      : "";
  const reply = `${closedReply(lane, landed, left, kept, [...branches, ...stowed.kept], stowed.note)}${moved}${out}`;
  await openWaiting(desk, project, true);
  return ok(reply);
}

/**
 * Each lane still open on the base a landing moved hears what now conflicts with it, ahead of its own landing; between
 * lanes that is the Supervisor's, which is told which.
 */
async function tellBaseMoved({ mail }: Pick<DeskServices, "mail">, project: Project, landed: Lane): Promise<string> {
  const others = Object.values(loadLedger(project.state).lanes).filter(
    (other) => other.status === "open" && !other.onBranch && other.base === landed.base && other.id !== landed.id,
  );
  const hit: string[] = [];
  for (const other of others) {
    const conflicts = await conflictsWith(project.root, other.branch, other.base);
    if (!conflicts || conflicts.length === 0) continue;
    await mail.post(other.lead, landLetters.baseMoved(landed, other, conflicts));
    hit.push(`${other.id} (${conflicts.join(", ")})`);
  }
  return hit.length > 0
    ? `\n\n${landed.base} now conflicts with lanes still open: ${hit.join("; ")}. Their Leads have the facts; who takes ${landed.base} in for each is yours to choose.`
    : "";
}

/** The open lane that audits what goes out from the base a landing moved, if one does, hears what landed there. */
async function tellAudit(
  { mail }: Pick<DeskServices, "mail">,
  project: Project,
  landed: Lane,
  how: string,
): Promise<void> {
  const audits = Object.values(loadLedger(project.state).lanes).filter(
    (other) => other.status === "open" && other.audit && other.base === landed.base && other.id !== landed.id,
  );
  for (const audit of audits) await mail.post(audit.lead, landLetters.landedForAudit(landed, how));
}

/**
 * Whether the Lead stays, and who still writes in the lane's copy: a look Paseo could not answer is not a Lead gone,
 * and seats mid-turn there, the kept Lead included, have the copy until their turn ends.
 */
async function leadAndWriters(
  roster: Roster,
  lane: Lane,
  retired: Task[],
): Promise<{ kept: boolean; writers: string[] }> {
  const look = lane.lead ? await roster.look(lane.lead).catch(() => null) : undefined;
  const kept = look === null || Boolean(look && !look.archivedAt);
  const peers = retired
    .filter((task) => task.mode !== "parallel")
    .map((task) => task.peer)
    .filter((id): id is string => typeof id === "string" && roster.archiving(id));
  const lead = look && !look.archivedAt && midTurn(look.status) ? [lane.lead!] : [];
  return { kept, writers: [...new Set([...lead, ...peers])] };
}

/**
 * What a closing lane leaves that nobody can act on any more: its open asks answered, its open questions for the Human
 * called off, its unsettled tasks cut.
 */
function settleLeftovers(ledger: Ledger, lane: Lane): Leftovers {
  for (const ask of Object.values(ledger.asks))
    if (ask.lane === lane.id && ASK.move(ask, "answer"))
      ask.answer = `Lane ${lane.id} closed before this was answered.`;
  const canceled: string[] = [];
  for (const question of Object.values(ledger.questions)) {
    if (question.lane !== lane.id || !QUESTION.move(question, "cancel")) continue;
    const text = `Lane ${lane.id} closed before the Human answered.`;
    question.answer = { choice: "cancel", text, by: "desk", at: Date.now() };
    canceled.push(question.id);
  }
  const tasks: Task[] = [];
  const cut: string[] = [];
  for (const task of Object.values(ledger.tasks).filter((item) => item.lane === lane.id)) {
    const lost = openWork(task);
    if (TASK.move(task, "cut") && lost) cut.push(task.id);
    tasks.push({ ...task });
  }
  return { tasks, cut, canceled };
}

function closedReply(
  lane: Lane,
  landed: Landed,
  left: Leftovers,
  kept: boolean,
  branches: string[],
  note: string,
): string {
  const seats = kept
    ? `Its Peers are archived, and its Lead ${lane.lead} stays until you release it.`
    : "Its Peers are archived, and its Lead is gone.";
  const { cut, canceled } = left;
  const cutText =
    cut.length > 0 ? ` It cut ${cut.join(", ")}, which ${plural(cut.length, "was", "were")} not finished.` : "";
  const questions = `Its open question${plural(canceled.length, "", "s")} for the Human`;
  const canceledText =
    canceled.length > 0
      ? ` ${questions}, ${canceled.join(", ")}, ${plural(canceled.length, "is", "are")} canceled.`
      : "";
  const named = [...new Set(branches)];
  const holds = `${plural(named.length, "holds commits", "hold commits")} nothing else has and ${plural(named.length, "is", "are")} kept`;
  const held = named.length > 0 ? ` ${named.join(" and ")} ${holds}.` : "";
  return `Lane ${lane.id} closed; ${landed.how}. ${seats}${cutText}${canceledText} ${note}${held}${landed.note}`;
}
