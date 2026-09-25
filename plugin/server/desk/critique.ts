import { readFileSync } from "node:fs";
import { roleThatCan } from "../catalog/kit.ts";
import { errorText } from "../core/errors.ts";
import { type Args, no, ok, str } from "./context.ts";
import { type Lane, loadLedger } from "./ledger.ts";
import { letters } from "./letters.ts";
import { type Project, conceptFile } from "./project.ts";
import type { DeskServices, Tool } from "./services.ts";

const LABEL = "seatworks.critique";

/** The lane as the Critic reads it, and as its quotes are checked against. */
export function laneText(lane: Lane): string {
  return [
    `Title: ${lane.title}`,
    `Outcome: ${lane.outcome}`,
    "Acceptance:",
    ...lane.acceptance.map((line, index) => `${index + 1}. ${line}`),
    "Out of scope:",
    ...(lane.outOfScope.length > 0 ? lane.outOfScope.map((line) => `- ${line}`) : ["- nothing named"]),
  ].join("\n");
}

/** Quotes are checked as words: a model copies them faithfully but not always its case or its closing full stop. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").toLowerCase();

/**
 * Seats a Critic on a lane just recorded, with the Human's own words as its Supervisor was sent them, CONTEXT.md and the
 * lane, and nothing the Supervisor said or thought. Never in the way: a lane opens whether or not a Critic could be seated.
 */
export async function seatCritic(desk: DeskServices, project: Project, lane: Lane): Promise<void> {
  const { ctx, roster, agents } = desk;
  if (ctx.team(project).critic.by !== "seat") return;
  const role = roleThatCan(ctx.kit, "critique");
  if (!role) return;
  try {
    const human = await roster.typed(lane.opener);
    const file = conceptFile(project.state);
    const concept = file ? readFileSync(file, "utf-8") : undefined;
    const id = await agents.startResident(project, role.role, {
      title: `${role.label} ${lane.id} ${project.slug}`,
      prompt: letters.critiqueBrief(lane.id, human, concept, laneText(lane)),
      labels: { [LABEL]: lane.id },
    });
    ctx.event(project, { kind: "critique.asked", lane: lane.id, agent: id, words: human.length });
  } catch (error) {
    ctx.log(project, `a Critic could not be seated on ${lane.id}: ${errorText(error)}`);
  }
}

/** A Critic's findings, each quote checked against what it was given; told to the Supervisor, and the Critic let go. */
export const findings: Tool = async (desk, caller, args) => {
  const { ctx, roster } = desk;
  const { project } = caller;
  const seat = (await roster.open()).find((entry) => entry.id === caller.id);
  const laneId = seat?.labels?.[LABEL];
  const lane = laneId ? loadLedger(project.state).lanes[laneId] : undefined;
  if (!lane) return no("There is no lane on record for you to have read; end your turn.");
  const listed = (Array.isArray(args.findings) ? (args.findings as Args[]) : []).map((entry) => ({ kind: str(entry.kind), human: str(entry.human), lane: str(entry.lane), why: str(entry.why), question: str(entry.question) }));
  const said = flat((await roster.typed(lane.opener)).join("\n"));
  const written = flat(laneText(lane));
  for (const finding of listed) {
    if (finding.human ? !said.includes(flat(finding.human)) : finding.kind !== "added") return no(finding.human ? `"${finding.human}" is not in what the Human wrote: copy their words exactly, or leave the point out.` : "Only an added point may quote nothing the Human wrote.");
    if (finding.lane ? !written.includes(flat(finding.lane)) : finding.kind === "added") return no(finding.lane ? `"${finding.lane}" is not in the lane: copy its words exactly, or leave it empty when the lane says nothing of it.` : "An added point quotes what the lane added.");
  }
  ctx.event(project, { kind: "critique.found", lane: lane.id, agent: caller.id, found: listed.length, kinds: listed.map((finding) => finding.kind) });
  if (listed.length > 0) await ctx.post(await roster.supervisorFor(project, lane.opener), `critique:${lane.id}:${caller.id}`, letters.critique(lane, listed), project);
  await roster.archive(caller.id);
  return ok(listed.length > 0 ? "Handed to the Supervisor. End your turn." : "Recorded that you found nothing. End your turn.");
};
