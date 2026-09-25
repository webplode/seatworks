import { keepRun } from "./checkpoints.ts";
import { type Lane, loadLedger } from "./ledger.ts";
import { letters } from "./letters.ts";
import type { Planned } from "./plan.ts";
import type { Project } from "./project.ts";
import type { DeskServices } from "./services.ts";
import { startWaiting } from "./waiting.ts";

/** Why a person should see this plan before it runs, read from the paths it owns and never from what the Lead calls it. */
export function riskSignals(plan: Planned[], risk: string): string[] {
  const risky = new RegExp(risk, "i");
  return plan.flatMap((task) => task.owned.filter((path) => risky.test(path)).map((path) => `${task.key} owns ${path}, which this project counts as risky.`));
}

/**
 * Settles the plan a lane holds for approval: approved, its tasks start; sent back, they are cut and the Lead plans again.
 * `by` is "human" from the panel, or the seat that decided; a plan held for the Human is never a seat's to decide.
 */
export async function decidePlan(desk: DeskServices, project: Project, laneId: string, approve: boolean, by: string, note: string): Promise<{ ok: boolean; text: string }> {
  const { ctx } = desk;
  const decided = await ctx.ledger(project, (ledger) => {
    const lane = ledger.lanes[laneId];
    const pending = lane?.approval;
    if (!lane || !pending) return `No plan of lane ${laneId} waits for approval.`;
    if (pending.by === "human" && by !== "human") return `Plan ${pending.plan} of lane ${laneId} waits for the Human, on its card in Seatworks; it is not yours to decide. Tell them it is waiting, and why.`;
    delete lane.approval;
    const cut = approve ? [] : Object.values(ledger.tasks).filter((task) => task.lane === laneId && task.plan === pending.plan && task.status === "waiting");
    for (const task of cut) task.status = "cut";
    return { lane: { ...lane } as Lane, pending, cut: cut.map((task) => task.id) };
  });
  if (typeof decided === "string") return { ok: false, text: decided };
  const { lane, pending, cut } = decided;
  keepRun(project, { checkpoint: "plan", mode: "on", lane: laneId, by, decision: approve ? "approved" : "sent back", findings: note ? [note] : [], waitedMs: Date.now() - pending.since });
  ctx.event(project, { kind: approve ? "plan.approved" : "plan.sentBack", lane: laneId, plan: pending.plan, by, cut });
  await ctx.post(lane.lead, `plan:${laneId}:${pending.plan}`, approve ? letters.planApproved(lane, pending.plan, note) : letters.planSentBack(lane, pending.plan, note, cut));
  if (approve) await startWaiting(desk, project, true);
  const tasks = loadLedger(project.state).tasks;
  return {
    ok: true,
    text: approve
      ? `Plan ${pending.plan} of lane ${laneId} is approved; ${Object.values(tasks).filter((task) => task.plan === pending.plan && task.lane === laneId && task.status === "running").length} of its tasks started, and the rest start as what they wait for is accepted.`
      : `Plan ${pending.plan} of lane ${laneId} is sent back; ${cut.join(", ") || "none of its tasks"} cut, and its Lead plans again.`,
  };
}
