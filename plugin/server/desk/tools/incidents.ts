import { can } from "../../catalog/kit.ts";
import { type Caller, no, ok, str } from "../context.ts";
import { type Incident, incidentsFault, loadIncidents } from "../incidents.ts";
import { laneOfLead, loadLedger } from "../ledger.ts";
import { clip } from "../letters.ts";
import { mask } from "../../runtime/watch/mask.ts";
import type { Tool } from "../services.ts";

const at = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export const HELD: Record<string, string> = {
  shadow: "shadow",
  budget: "the day's budget is spent",
  nobody: "nobody was seated to tell",
  awaiting: "waiting for the sensor",
  vetoed: "held back",
};

function line(item: Incident): string {
  const sent = item.told !== undefined ? `told ${at(item.told)}` : item.held ? `not sent: ${HELD[item.held] ?? item.held}` : "";
  const state = item.open ? sent || "open" : ["closed", sent, item.label ? `marked ${item.label}` : "not marked"].filter(Boolean).join(", ");
  const seen = item.count > 1 ? ` (seen ${item.count} times, last ${at(item.last)})` : "";
  const later = item.later !== undefined ? `; seen after you were told: ${clip(item.later.replace(/\s+/g, " "), 200)}` : "";
  return `- ${item.id} [${item.level}, ${state}] ${item.where}, agent ${item.seat}: ${item.kind}${seen} — ${clip(item.quote.replace(/\s+/g, " "), 300)}${later}`;
}

function briefs(state: string, shown: Incident[]): string[] {
  let ledger;
  try {
    ledger = loadLedger(state);
  } catch {
    return [];
  }
  const text = (value: string, limit: number) => clip(value.replace(/\s+/g, " "), limit);
  const out: string[] = [];
  for (const id of [...new Set(shown.flatMap((item) => (item.task ? [item.task] : [])))]) {
    const task = ledger.tasks[id];
    if (task) out.push(`- ${task.id} ${text(task.title, 120)}: goal ${text(task.goal, 300)}; acceptance ${text(task.acceptance.join("; "), 300)}; owned ${text(task.owned.join(", ") || "not declared", 200)}; out of scope ${text(task.outOfScope.join("; ") || "nothing named", 200)}`);
  }
  for (const id of [...new Set(shown.flatMap((item) => (item.lane && !item.task ? [item.lane] : [])))]) {
    const lane = ledger.lanes[id];
    if (lane) out.push(`- ${lane.id} ${text(lane.title, 120)}: outcome ${text(lane.outcome, 300)}; acceptance ${text(lane.acceptance.join("; "), 300)}; out of scope ${text(lane.outOfScope.join("; ") || "nothing named", 200)}`);
  }
  return out.length > 0 ? ["", "What they were asked:", ...out] : [];
}

/** A supervisor sees every incident; a Lead only those about its own open lane's other seats, never itself. */
function mine(caller: Caller): ((item: Incident) => boolean) | string {
  if (can(caller.role, "supervise")) return () => true;
  let lane: string | undefined;
  try {
    lane = laneOfLead(loadLedger(caller.project.state), caller.id)?.id;
  } catch {}
  if (!lane) return "You have no open lane, so there are no incidents here for you.";
  return (item) => item.lane === lane && item.seat !== caller.id;
}

export const incidents: Tool = async ({ ctx }, caller, args) => {
  const fault = incidentsFault(caller.project.state);
  if (fault) return no(`${fault}. Only the Human can repair it or move it aside.`);
  const allowed = mine(caller);
  if (typeof allowed === "string") return no(allowed);
  const held = loadIncidents(caller.project.state);
  const all = Object.values(held.items).filter(allowed);
  const waiting = all.filter((item) => item.open || !item.label).sort((a, b) => b.last - a.last);
  const shown = waiting.slice(0, 50);
  const lines = [waiting.length > 0 ? `${waiting.length} not yet marked:` : "Nothing waiting to be marked."];
  lines.push(...shown.map(line));
  if (waiting.length > shown.length) lines.push(`… and ${waiting.length - shown.length} older ones not shown.`);
  lines.push(...briefs(caller.project.state, shown));
  if (args.closed === true) {
    const marked = all.filter((item) => item.label).sort((a, b) => (b.closed ?? b.last) - (a.closed ?? a.last)).slice(0, 20);
    lines.push("", marked.length > 0 ? "Recently marked:" : "Nothing marked yet.", ...marked.map(line));
  }
  if (waiting.length > 0) lines.push("", "Each is a signal to look at, not a verdict. Mark each one with ack once you have looked at the agent's record, so the thresholds can be tuned.");
  ctx.event(caller.project, { kind: "incident.read", agent: caller.id, waiting: waiting.length });
  return ok(lines.join("\n"));
};

export const ack: Tool = async ({ ctx }, caller, args) => {
  const id = str(args.id);
  // One of the three: the desk holds every call to the schema before it gets here.
  const verdict = str(args.verdict) as NonNullable<Incident["label"]>;
  const note = mask(str(args.note));
  const now = Date.now();
  const allowed = mine(caller);
  if (typeof allowed === "string") return no(allowed);
  const done = await ctx.incidents(caller.project, (held) => {
    caller.revalidate?.();
    const item = held.items[id];
    if (!item || !allowed(item)) return undefined;
    item.label = verdict;
    if (note) item.note = note;
    if (item.open) {
      item.open = false;
      item.closed = now;
    }
    return { ...item };
  });
  if (!done) return no(`There is no incident ${id} here for you to mark. incidents lists the ones there are.`);
  ctx.event(caller.project, { kind: "incident.ack", id, agent: caller.id, verdict, note: note || null, seat: done.seat, finding: done.kind, opened: done.opened, last: done.last, sensor: done.sensor ?? null, ...(done.by ? { by: done.by } : {}) });
  const later = done.later !== undefined ? ` It was seen ${done.count} times, the last at ${at(done.last)} after you were told: ${clip(done.later.replace(/\s+/g, " "), 200)}` : "";
  return ok(`${id} marked ${verdict} and closed.${later}`);
};
