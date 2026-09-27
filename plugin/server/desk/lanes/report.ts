import { currentBranch } from "../../core/git.ts";
import { plural } from "../../core/text.ts";
import { type Caller, type ToolReply, no, ok, str, strs } from "../context.ts";
import { laneGate } from "../project/gates.ts";
import { holdRefusal, putOnHold } from "./hold.ts";
import { askFirstHits, changeOf, changesStanding, landFacts, reviewFacts } from "./land-facts.ts";
import type { Lane } from "../../domain/lane.ts";
import { laneOfLead, tasksOf } from "../../domain/ledger.ts";
import { loadLedger } from "../store/ledger.ts";
import { workLetters } from "../letters/work-letters.ts";
import type { Project } from "../project/project.ts";
import type { DeskServices } from "../services.ts";
import { recordEvent } from "../store/event-log.ts";
import { midTurnAmong } from "../seats/writing.ts";
import { unsavedIn } from "../copies/unsaved.ts";

type ReportCall = { summary: string; ready: boolean; carried?: string[]; decided?: string[]; assumed?: string[] };

type Gate = Awaited<ReturnType<typeof laneGate>>;

/** A Lead's report to whoever supervises, READY with the lane gated as it stands, or progress. */
export async function reportLane(desk: DeskServices, caller: Caller, args: ReportCall): Promise<ToolReply> {
  const { project } = caller;
  const lane = laneOfLead(loadLedger(project.state), caller.id);
  if (!lane) return no("You have no open lane.");
  const ready = args.ready === true;
  if (ready) {
    const blocked = await readyBlocked(desk, project, lane);
    if (blocked) return no(blocked);
  }
  const amendments = lane.amended?.length ?? 0;
  const gate = ready ? await laneGate(desk, project, lane) : undefined;
  // Recorded on the lane as it stands now: it may have closed, changed Lead, been amended or held while the gate ran.
  const refused = desk.ledgers.transact(project, (current): string | undefined => {
    const entry = laneOfLead(current, caller.id);
    if (entry?.id !== lane.id)
      return `Lane ${lane.id} is no longer yours to report on: it closed, or has another Lead, while this was asked.`;
    if (ready && (entry.amended?.length ?? 0) !== amendments)
      return `Lane ${lane.id} was amended while its gate ran, so what READY would claim has changed: carry the amendment in, then report ready again.`;
    const held = ready ? holdRefusal(entry) : undefined;
    if (held) return held;
    if (ready) entry.ready = { at: Date.now() };
    else delete entry.ready;
    return undefined;
  });
  if (refused) return no(refused);
  return tell(desk, project, lane, args, gate);
}

/** Why READY cannot be claimed now: the lane held, a seat writing in its copy, the copy on a task's branch or dirty. */
async function readyBlocked(desk: DeskServices, project: Project, lane: Lane): Promise<string | undefined> {
  const held = holdRefusal(lane);
  if (held) return held;
  // What ready claims is what the gate runs on: the merges accepted before it land first, and nobody writes under it.
  await desk.merges.retry(project, lane.id);
  await desk.merges.settled(project, lane.id);
  const inCopy = tasksOf(loadLedger(project.state), lane.id).filter(
    (task) => task.kind === "code" && task.mode !== "parallel",
  );
  const busy = await midTurnAmong(
    desk.roster,
    inCopy.map((task) => task.peer),
  );
  if (busy.length > 0) {
    const ends = plural(busy.length, "that turn ends", "those turns end");
    return `${busy.join(" and ")} ${plural(busy.length, "is", "are")} mid-turn in the lane's working copy, so what ready claims could still change under the gate. Report ready once ${ends}.`;
  }
  const on = await currentBranch(lane.worktree!);
  const holding = inCopy.find((task) => task.branch === on);
  if (holding)
    return `The lane's working copy is on ${on}, ${holding.id}'s branch, not ${lane.branch}: the gate would read ${holding.id}'s tree. Report ready once it is merged or cut.`;
  const unsaved = await unsavedIn(lane.worktree!, !lane.slot);
  return unsaved
    ? `The lane's working copy ${unsaved}: only what is committed is gated and lands. Report ready once it is committed or cleared.`
    : undefined;
}

async function tell(
  desk: DeskServices,
  project: Project,
  lane: Lane,
  args: ReportCall,
  gate: Gate | undefined,
): Promise<ToolReply> {
  const ready = args.ready === true;
  const to = await desk.roster.supervisorFor(project, lane.opener);
  const parked = ready ? await parkAtCheckpoint(desk, project, lane) : undefined;
  const ahead = ready ? await readAhead(desk, project, lane) : { asks: [], facts: [], changes: false };
  const found = { gate, parked: parked && `It is on hold: ${parked}.`, ...ahead };
  const own = { decided: strs(args.decided), assumed: strs(args.assumed) };
  const letter = workLetters.report(lane, str(args.summary), ready, strs(args.carried), found, own);
  const posted = await desk.mail.post(to, letter);
  const text = posted === "nobody" ? letter.text : undefined;
  recordEvent(project, { kind: "lane.report", lane: lane.id, ready, gate: gate?.ok, to: to ?? null, text, ...own });
  if (posted === "nobody")
    return ok(
      `Nobody supervising this project is seated, so the report reached no one. It is kept in ${project.state}/events.log for whoever comes back; there is nothing to wait for until someone does.`,
    );
  const held = parked
    ? ` The lane is on hold: ${parked}; nothing starts in it and nothing lands until it resumes.`
    : "";
  return ok(
    `${ready ? reviewsFirst(project, lane) : ""}Reported to ${to}${gate && !gate.ok ? ", with what the gate did in it" : ""}.${held} Stay quiet until mail arrives.`,
  );
}

/**
 * What the record has of the lane's reviews, first, as the evidence READY went with: reviews still reading, and what the
 * rest leave standing. Its reviews only: the rest may name an incident, which never reaches the seat it could be about.
 */
function reviewsFirst(project: Project, lane: Lane): string {
  const ledger = loadLedger(project.state);
  const reading = tasksOf(ledger, lane.id)
    .filter((task) => task.kind === "review" && task.status === "running")
    .map((task) => task.id);
  const facts = [
    ...(reading.length > 0
      ? [
          `${reading.join(" and ")} ${plural(reading.length, "is", "are")} still reading: ${plural(reading.length, "its verdict comes", "their verdicts come")} to you after this report.`,
        ]
      : []),
    ...reviewFacts(ledger, lane),
  ];
  return facts.length > 0 ? `What the record has of the lane's reviews went with it: ${facts.join(" ")} ` : "";
}

/**
 * A lane that went on without the Human's answer to a costly question stops at its ready report; why, when it did. Its
 * Lead, whose report this is, is not cut off mid-call: its reply says so.
 */
async function parkAtCheckpoint(desk: DeskServices, project: Project, lane: Lane): Promise<string | undefined> {
  if (!desk.teamFor(project).hitl.on) return undefined;
  const waiting = desk.ledgers.transact(project, (ledger) => {
    const open = Object.values(ledger.questions).filter(
      (question) => question.lane === lane.id && question.status === "open" && question.class === "costly",
    );
    for (const question of open) question.parked = true;
    return open.map((question) => question.id);
  });
  if (waiting.length === 0) return undefined;
  const reason = `it went on without the Human's answer to ${waiting.join(", ")}, and stops at its ready report until they answer`;
  const held = await putOnHold(desk, project, lane.id, "desk", reason, lane.lead);
  return typeof held === "string" ? undefined : reason;
}

/** What landing a lane reported ready would bring and wait for, read before whoever lands it decides to. */
async function readAhead(
  { kit, teamFor }: Pick<DeskServices, "kit" | "teamFor">,
  project: Project,
  lane: Lane,
): Promise<{ asks: string[]; facts: string[]; changes: boolean }> {
  const change = await changeOf(project, lane);
  const ledger = loadLedger(project.state);
  const facts = await landFacts(kit, project, ledger, lane, change);
  const asks = teamFor(project).hitl.on ? askFirstHits(project, change).map((hit) => hit.text) : [];
  return { asks, facts, changes: changesStanding(ledger, lane) };
}
