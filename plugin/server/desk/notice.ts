import { existsSync } from "node:fs";
import { join } from "node:path";
import { seatOf } from "../catalog/kit.ts";
import { jevOn, watchOn } from "../catalog/team.ts";
import { KEPT_FILE, assessmentsDir } from "../runtime/watch/jev/assessments.ts";
import type { Attention } from "../catalog/kit.ts";
import type { Finding, Verdict } from "../runtime/watch/findings.ts";
import { confirmable } from "../runtime/watch/jev/rules.ts";
import { type Held, type Incident, type Incidents, closeSeat, forget, openFor, settledAsNoise, sight, spentToday } from "./incidents.ts";
import { type Lane, type Task, laneOfLead, loadLedger, taskOfPeer } from "./ledger.ts";
import { errorText } from "../core/errors.ts";
import { letters } from "./letters.ts";
import type { Project } from "./project.ts";
import type { DeskServices } from "./services.ts";

export type Noticed = { id: string; provider: string; title?: string | null };

export type Placed = { where: string; lane?: Lane; task?: Task };

const AWAIT_MS = 120_000;

export const WATCHER_JUDGED = "watcher";

/** The facts that wait to be judged before they are told, and how long: Jev's by jev, the Watcher's by a seat. */
type Judging = { kinds: Set<string>; ms: number };

function judging(services: DeskServices, project: Project): Judging {
  const team = services.ctx.team(project);
  if (jevOn(team)) return { kinds: confirmable(team.sensor?.spec.questions ?? {}), ms: AWAIT_MS };
  if (team.attention.by === "seat") return { kinds: new Set(services.ctx.kit.watcher?.judges ?? []), ms: team.attention.watcherJudgeMinutes * 60_000 };
  return { kinds: new Set(), ms: AWAIT_MS };
}

function holdFor(incident: Incident, incidents: Incidents, attention: Attention, waiting: Judging, now: number): Held | undefined {
  if (incident.kind.startsWith("communication_")) return "shadow";
  if (!attention.watch) return "shadow";
  const judged = incident.level === "attend" && waiting.kinds.has(incident.kind);
  if (judged && incident.sensor?.says === "vetoes") return "vetoed";
  if (judged && !incident.sensor && now - incident.last < waiting.ms) return "awaiting";
  if (incident.level === "attend" && spentToday(incidents, now) >= attention.incidentsPerDay) return "budget";
  return undefined;
}

export function placeOf(project: Project, seat: Noticed): Placed {
  try {
    const ledger = loadLedger(project.state);
    const task = taskOfPeer(ledger, seat.id);
    const lane = task ? ledger.lanes[task.lane] : laneOfLead(ledger, seat.id);
    if (task) return { where: `the Peer on ${task.id} (${task.title})`, lane, task };
    if (lane) return { where: `the Lead of ${lane.id} (${lane.title})`, lane };
  } catch {}
  return { where: seat.title ? `${seat.title} (${seat.id})` : seat.id };
}

export async function notice(services: DeskServices, project: Project, seat: Noticed, findings: Finding[], now = Date.now()): Promise<{ opened: Incident[]; sent: string[]; place: Placed }> {
  const { ctx } = services;
  const place = placeOf(project, seat);
  if (findings.length === 0) return { opened: [], sent: [], place };
  const attention = ctx.team(project).attention;
  const waiting = judging(services, project);
  for (const finding of findings) {
    ctx.event(project, { kind: "watch.finding", agent: seat.id, finding: finding.kind, level: finding.level, quote: finding.quote, facts: finding.facts, p: finding.p ?? null, model: finding.model ?? null });
  }
  const { opened, sending } = await ctx.incidents(project, (incidents) => {
    const opened: Incident[] = [];
    const sending: Incident[] = [];
    for (const finding of findings) {
      const sighting = { seat: seat.id, provider: seat.provider, where: place.where, lane: place.lane?.id, task: place.task?.id, kind: finding.kind, level: finding.level, quote: finding.quote, facts: finding.facts, p: finding.p, model: finding.model, ...(finding.by ? { by: finding.by } : {}) };
      if (settledAsNoise(incidents, sighting, now)) continue;
      const { incident, opened: isNew } = sight(incidents, sighting, now);
      if (incident.told !== undefined) continue;
      const held = holdFor(incident, incidents, attention, waiting, now);
      if (held) incident.held = held;
      else {
        delete incident.held;
        incident.told = now;
        sending.push({ ...incident });
      }
      if (isNew) {
        ctx.event(project, { kind: "incident.open", id: incident.id, agent: seat.id, finding: incident.kind, level: incident.level, held: incident.held ?? null });
        opened.push({ ...incident });
      }
    }
    forget(incidents);
    return { opened, sending };
  });
  if (sending.length === 0) return { opened, sent: [], place };
  const sent = await deliver(services, project, seat, place, sending, now);
  return { opened, sent, place };
}

export type Reader = "lead" | "supervisor";

/** Attention-level incidents about a Peer go to its Lead; the rest, or a Peer with no Lead, to whoever supervises. Never to the seat itself. */
async function recipientFor(services: DeskServices, project: Project, seat: Noticed, place: Placed, level: Incident["level"]): Promise<{ to: string | undefined; as: Reader }> {
  const lead = place.lane?.lead;
  if (level === "attend" && place.task && lead && lead !== seat.id && (await services.roster.seated(lead))) return { to: lead, as: "lead" };
  const to = await services.roster.supervisorFor(project, place.lane?.opener);
  return { to: to === seat.id ? undefined : to, as: "supervisor" };
}

async function deliver(services: DeskServices, project: Project, seat: Noticed, place: Placed, sending: Incident[], now: number): Promise<string[]> {
  const { ctx } = services;
  const harness = seatOf(ctx.kit, seat.provider)?.harness;
  const shape = { steers: harness?.steers === true, outputless: Boolean(harness?.exitPattern) };
  // Named only when the file exists: with no key or an unreachable sensor, nothing was kept.
  const file = join(assessmentsDir(project.state), KEPT_FILE);
  const kept = existsSync(file) ? file : undefined;
  const told: string[] = [];
  for (const level of ["page", "attend"] as const) {
    const batch = sending.filter((incident) => incident.level === level);
    if (batch.length === 0) continue;
    let reader: { to: string | undefined; as: Reader } = { to: undefined, as: "supervisor" };
    try {
      reader = await recipientFor(services, project, seat, place, level);
    } catch (error) {
      ctx.event(project, { kind: "incident.lookup-failed", error: errorText(error) });
    }
    const { to, as } = reader;
    if (!to) {
      await ctx.incidents(project, (incidents) => {
        for (const sent of batch) {
          const incident = incidents.items[sent.id];
          if (!incident || incident.told !== now) continue;
          delete incident.told;
          incident.held = "nobody";
        }
      });
      for (const sent of batch) ctx.event(project, { kind: "incident.held", id: sent.id, held: "nobody" });
      continue;
    }
    await ctx.incidents(project, (incidents) => {
      for (const sent of batch) {
        const incident = incidents.items[sent.id];
        if (incident?.told === now) incident.toldTo = as;
      }
    });
    for (const incident of batch) {
      try {
        await ctx.post(to, `incident:${project.slug}:${incident.id}:${incident.opened}:${incident.level}`, letters.incident(incident, place, shape, kept, as), project);
      } catch (error) {
        ctx.event(project, { kind: "incident.post-failed", id: incident.id, error: errorText(error) });
      }
    }
    ctx.event(project, { kind: "incident.told", ids: batch.map((incident) => incident.id), to });
    told.push(...batch.map((incident) => incident.id));
  }
  return told;
}

/** `expect` pins the incident as read: a Watcher judges by id from a letter, and a sighting since means it judged something else. */
export async function judge(services: DeskServices, project: Project, seat: Noticed, verdicts: Verdict[], now = Date.now(), expect?: { id: string; count: number }): Promise<string[]> {
  const { ctx } = services;
  if (verdicts.length === 0) return [];
  const attention = ctx.team(project).attention;
  const waiting = judging(services, project);
  const sending = await ctx.incidents(project, (incidents) => {
    const taken: Incident[] = [];
    for (const verdict of verdicts) {
      const incident = openFor(incidents, seat.id, verdict.kind);
      if (!incident) continue;
      if (expect && (incident.id !== expect.id || incident.count !== expect.count || incident.sensor)) continue;
      ctx.event(project, { kind: "incident.judged", id: incident.id, agent: seat.id, question: verdict.question, p: verdict.p, says: verdict.says, told: incident.told !== undefined });
      if (incident.told !== undefined) continue;
      incident.sensor = { question: verdict.question, p: verdict.p, model: verdict.model, says: verdict.says, ...(verdict.why ? { why: verdict.why } : {}) };
      const held = holdFor(incident, incidents, attention, waiting, now);
      if (held) incident.held = held;
      else {
        delete incident.held;
        incident.told = now;
        taken.push({ ...incident });
      }
    }
    return taken;
  });
  if (sending.length === 0) return [];
  return deliver(services, project, seat, placeOf(project, seat), sending, now);
}

export async function retell(services: DeskServices, project: Project, now = Date.now()): Promise<string[]> {
  const { ctx } = services;
  const team = ctx.team(project);
  // Gated: with the key gone the hold set is empty, so an ungated path would send everything held back.
  if (!watchOn(team)) return [];
  const attention = team.attention;
  if (!attention.watch) return [];
  const waiting = judging(services, project);
  const told: string[] = [];
  const overdue = await ctx.incidents(project, (incidents) => {
    const taken: Incident[] = [];
    for (const incident of Object.values(incidents.items)) {
      if (!incident.open || incident.told !== undefined || (incident.held !== "awaiting" && incident.held !== "vetoed")) continue;
      // A veto is lifted only by the reader that made it: switching readers changes what waits to be judged.
      if (incident.held === "vetoed" && (incident.sensor?.question === WATCHER_JUDGED ? "seat" : "jev") !== team.attention.by) continue;
      const held = holdFor(incident, incidents, attention, waiting, now);
      if (held) incident.held = held;
      else {
        delete incident.held;
        incident.told = now;
        taken.push({ ...incident });
      }
    }
    return taken;
  });
  for (const seat of [...new Set(overdue.map((item) => item.seat))]) {
    const mine = overdue.filter((item) => item.seat === seat);
    const noticed = { id: seat, provider: mine[0]!.provider ?? "" };
    told.push(...(await deliver(services, project, noticed, placeOf(project, noticed), mine, now)));
  }
  const nobody = await ctx.incidents(project, (incidents) => Object.values(incidents.items).filter((item) => item.open && item.held === "nobody" && item.told === undefined).map((item) => ({ ...item })));
  for (const seat of [...new Set(nobody.map((item) => item.seat))]) {
    const noticed = { id: seat, provider: nobody.find((item) => item.seat === seat)!.provider ?? "" };
    const place = placeOf(project, noticed);
    // Only what somebody is now seated to read; `deliver` then finds that somebody again, per level.
    const mine: Incident[] = [];
    for (const level of ["page", "attend"] as const) {
      const some = nobody.filter((item) => item.seat === seat && item.level === level);
      if (some.length === 0) continue;
      try {
        if ((await recipientFor(services, project, noticed, place, level)).to) mine.push(...some);
      } catch {}
    }
    if (mine.length === 0) continue;
    const sending = await ctx.incidents(project, (incidents) => {
      const taken: Incident[] = [];
      for (const item of mine) {
        const incident = incidents.items[item.id];
        if (!incident?.open || incident.held !== "nobody" || incident.told !== undefined) continue;
        delete incident.held;
        incident.told = now;
        taken.push({ ...incident });
      }
      return taken;
    });
    if (sending.length > 0) told.push(...(await deliver(services, project, noticed, place, sending, now)));
  }
  return told;
}

export function closeIncidentsOf(services: DeskServices, project: Project, seat: string, now = Date.now()): Promise<string[]> {
  return services.ctx.incidents(project, (incidents) => closeSeat(incidents, seat, now));
}
