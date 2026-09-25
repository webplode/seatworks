import { createHash } from "node:crypto";
import type { SeatView } from "../core/paseo.ts";
import type { Ledger } from "./ledger.ts";
import type { FlowAsk, FlowCritic, FlowLane, FlowSeat, FlowTask, FlowView } from "../../shared/views.ts";
import type { Project } from "./project.ts";

export type { FlowAsk, FlowLane, FlowSeat, FlowTask, FlowView };

export const LANE_CAP = 50;

const minutes = (now: number, at: number | string | undefined): number =>
  at === undefined ? 0 : Math.max(0, Math.round((now - (typeof at === "string" ? Date.parse(at) : at)) / 60_000));

function seatOf(seats: Map<string, SeatView>, id: string | undefined, role: string, now: number, heard?: number): FlowSeat | null {
  if (!id) return null;
  const seat = seats.get(id);
  // Stamped zero, a seat gone for a week read as gone just now.
  if (!seat) return { id, role, status: "gone", minutes: heard ? minutes(now, heard) : 0, waiting: [] };
  return {
    id,
    role,
    status: seat.status,
    minutes: minutes(now, seat.updatedAt),
    waiting: (seat.pendingPermissions ?? []).map((request) => request.title ?? request.name ?? "a request"),
  };
}

/** `seated` comes from the roster: the ledger records a seat only after its first successful tool call. */
export function flowView(
  project: Project,
  ledger: Ledger,
  seats: Map<string, SeatView>,
  now: number,
  open: ReadonlySet<string> = new Set(),
  supervises: ReadonlySet<string> = new Set(),
  seated: { id: string; role: string }[] = [],
): Omit<FlowView, "watch"> {
  const counts = new Map<string, { total: number; running: number }>();
  const held = new Map<string, FlowTask[]>();

  for (const task of Object.values(ledger.tasks)) {
    if (task.status === "merged" || task.status === "cut") continue;
    const count = counts.get(task.lane) ?? { total: 0, running: 0 };
    count.total += 1;
    if (task.status === "running" || task.status === "rework") count.running += 1;
    counts.set(task.lane, count);
    if (!open.has(task.lane)) continue;
    const built: FlowTask = {
      id: task.id,
      title: task.title,
      status: task.status,
      kind: task.kind,
      peer: seatOf(seats, task.peer, ledger.agents[task.peer ?? ""]?.role ?? task.kind, now),
      minutes: minutes(now, task.updatedAt),
      handback: task.handback ? minutes(now, task.handback.at) : null,
    };
    const list = held.get(task.lane);
    if (list) list.push(built);
    else held.set(task.lane, [built]);
  }

  const lanes: FlowLane[] = [];
  let moreLanes = 0;
  for (const lane of Object.values(ledger.lanes)) {
    if (lane.status === "closed") continue;
    if (lanes.length >= LANE_CAP) {
      moreLanes += 1;
      continue;
    }
    const count = counts.get(lane.id) ?? { total: 0, running: 0 };
    lanes.push({
      id: lane.id,
      title: lane.title,
      status: lane.status,
      branch: lane.branch,
      ...(lane.onBranch ? {} : { base: lane.base }),
      lead: seatOf(seats, lane.lead, ledger.agents[lane.lead ?? ""]?.role ?? "lead", now),
      tasks: held.get(lane.id) ?? [],
      taskCount: count.total,
      running: count.running,
      open: open.has(lane.id),
      ...(lane.status === "waiting" ? { after: lane.after ?? [], ...(lane.held ? { held: lane.held.why } : {}) } : {}),
      ...(lane.approval ? { approval: { plan: lane.approval.plan, by: lane.approval.by, minutes: minutes(now, lane.approval.since), signals: lane.approval.signals } } : {}),
      ...(lane.landApproval
        ? { landApproval: { minutes: minutes(now, lane.landApproval.since), approved: Boolean(lane.landApproval.approved), signals: lane.landApproval.signals, evidence: lane.landApproval.evidence } }
        : {}),
    });
  }

  const asks: FlowAsk[] = [];
  for (const ask of Object.values(ledger.asks)) {
    if (ask.status !== "open") continue;
    asks.push({
      id: ask.id,
      kind: ask.kind,
      fromRole: ask.fromRole,
      to: ask.to,
      minutes: minutes(now, ask.openedAt),
      text: ask.text.split(/\r?\n/).find((line) => line.trim()) ?? "",
    });
  }

  // The Supervisor seated now: `ledger.agents` keeps each role's newest gone seat, so its first entry may be archived.
  const recorded = Object.values(ledger.agents).filter((agent) => supervises.has(agent.role));
  const live = recorded
    .filter((agent) => seats.has(agent.id))
    .sort((a, b) => Date.parse(seats.get(b.id)!.updatedAt) - Date.parse(seats.get(a.id)!.updatedAt));
  // Every supervising seat, one per concern; a concern with nobody seated shows its last seat as gone.
  const shown = new Map<string, FlowSeat>();
  const heard = (id: string) => ledger.agents[id]?.recordedAt;
  for (const entry of [...seated, ...live]) if (!shown.has(entry.id)) shown.set(entry.id, seatOf(seats, entry.id, entry.role, now, heard(entry.id))!);
  const covered = new Set([...shown.values()].map((seat) => seat.role));
  for (const agent of [...recorded].reverse()) {
    if (covered.has(agent.role)) continue;
    covered.add(agent.role);
    shown.set(agent.id, seatOf(seats, agent.id, agent.role, now, heard(agent.id))!);
  }
  const supervisors = [...shown.values()];
  // A Critic is never in the ledger: it lives one look, known by the lane its labels name.
  const critics: FlowCritic[] = [...seats.values()].flatMap((seat) => {
    const lane = seat.labels?.["seatworks.critique"];
    if (!lane || seat.archivedAt || seat.labels?.["seatworks.project"] !== project.slug) return [];
    return [{ lane, title: ledger.lanes[lane]?.title ?? "", seat: seatOf(seats, seat.id, "critic", now)! }];
  });

  const body = { project: project.slug, supervisors, critics, lanes, moreLanes, asks };
  const revision = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { ...body, at: now, revision };
}
