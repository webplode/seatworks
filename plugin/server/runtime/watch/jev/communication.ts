import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Team } from "../../../catalog/team.ts";
import { writeJson } from "../../../core/store.ts";
import type { Desk } from "../../../desk/desk.ts";
import { loadLedger, type Ledger, type Task } from "../../../desk/ledger.ts";
import { projectOf, type Project } from "../../../desk/project.ts";
import type { Letter, Outbox } from "../../outbox.ts";
import type { Supervision } from "../../supervision.ts";
import { mask } from "../mask.ts";
import { keepAssessment } from "./assessments.ts";
import { decide } from "./sensor.ts";

export const obligations = {
  brief: "Does the task brief supply enough intent, ownership, acceptance and context for this particular work, without demanding a fixed prose template?",
  handback: "Does the handback convey its outcome, evidence and remaining uncertainty well enough for the Lead to act?",
  handling: "Did the subsequent Lead turn and observed follow-ups address what the handback required? A valid repair delegated to a different Peer counts. Do not demand that the original Peer perform every repair.",
};
const options = { adequate: "The applicable obligation is supported by the observed evidence.", deficient: "Complete evidence clearly shows an applicable obligation was not met.", unknown: "Evidence is missing, ambiguous, overlapping, or cannot establish the obligation.", not_applicable: "This obligation does not apply to this episode." };
export const communicationQuestions = Object.fromEntries(Object.entries(obligations).map(([id, instructions]) => [id, { type: "choice", instructions, criteria: options }]));
type Choice = keyof typeof options;
export type TurnEvidence = { started: number | null; ended: number; text: string; complete: boolean };
export type CommunicationCase = { id: string; revision: string; lead: string; state: Record<string, unknown>; unknown?: string };
export type Coverage = { status: "off" | "unknown" | "shadow" | "degraded" | "budget"; detail: string; at: number; callsToday: number };

export function communicationCase(project: Project, task: Task, ledger: Ledger, letters: Letter[], turn?: TurnEvidence, limit = 8000): CommunicationCase {
  const lane = ledger.lanes[task.lane];
  const confirmed = letters.filter((l) => ["delivered", "acknowledged"].includes(l.state));
  const delivery = confirmed.findLast((l) => l.to === lane?.lead && l.key.startsWith(`${project.slug}:done:${task.id}:`) && (l.deliveredAt ?? 0) >= (task.handback?.at ?? Infinity));
  const siblings = Object.values(ledger.tasks).filter((other) => other.lane === task.lane && other.id !== task.id && other.updatedAt >= (task.handback?.at ?? Infinity))
    .map(({ id, peer, goal, status, handback, openedAt, updatedAt }) => ({ id, peer, goal, status, handback, openedAt, updatedAt }));
  const state = JSON.parse(mask(JSON.stringify({
    brief: { goal: task.goal, acceptance: task.acceptance, owned: task.owned, outOfScope: task.outOfScope, context: task.context },
    handback: task.handback, status: task.status, asks: Object.values(ledger.asks).filter((a) => a.task === task.id),
    deliveredAt: delivery?.deliveredAt, leadTurn: turn, repairs: siblings,
    followups: confirmed.filter((l) => l.key.includes(`message:${lane?.lead}:`) && (l.deliveredAt ?? 0) >= (delivery?.deliveredAt ?? Infinity)).map(({ text, deliveredAt }) => ({ text, deliveredAt })),
  }))) as Record<string, unknown>;
  const unknown = !task.handback || !delivery ? "Handback delivery is unconfirmed."
    : !turn?.complete || turn.started === null || turn.started <= delivery.deliveredAt! || turn.ended <= turn.started
      ? "No complete Lead turn started strictly after confirmed handback delivery."
      : JSON.stringify(state).length > limit ? "Evidence exceeds the configured window; assessment withheld rather than silently truncated." : undefined;
  const revision = createHash("sha256").update(JSON.stringify({ state, unknown })).digest("hex");
  return { id: `${project.slug}/${task.id}`, revision, lead: lane?.lead ?? "", state, ...(unknown ? { unknown } : {}) };
}

export function readCommunicationAnswers(value: unknown, model: string): { answers: Record<string, { choice: Choice; p: number }>; cost: number | null } {
  const body = value as { model?: unknown; answers?: Record<string, { type?: unknown; choice?: unknown; probabilities?: Record<string, unknown> }>; usage?: { cost?: unknown } };
  if (!body || body.model !== model) throw new Error("Communication assessment returned a different or missing model.");
  const answers: Record<string, { choice: Choice; p: number }> = {};
  for (const id of Object.keys(obligations)) {
    const answer = body.answers?.[id]; const probabilities = answer?.probabilities;
    if (answer?.type !== "choice" || typeof answer.choice !== "string" || !(answer.choice in options) || !probabilities || Object.keys(probabilities).sort().join() !== Object.keys(options).sort().join()) throw new Error(`Invalid Choice answer: ${id}`);
    const values = Object.values(probabilities);
    if (values.some((p) => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) || Math.abs((values as number[]).reduce((a, b) => a + b, 0) - 1) > 0.00001) throw new Error(`Invalid probability distribution: ${id}`);
    const p = probabilities[answer.choice] as number;
    if (Object.entries(probabilities).some(([key, n]) => key !== answer.choice && (n as number) >= p)) throw new Error(`Choice is not a unique maximum: ${id}`);
    answers[id] = { choice: answer.choice as Choice, p };
  }
  const cost = body.usage?.cost;
  if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) throw new Error("Invalid assessment cost.");
  return { answers, cost: typeof cost === "number" ? cost : null };
}

export const Budget = z.object({ version: z.literal(2), day: z.string(), calls: z.number().int().nonnegative(), cases: z.record(z.string(), z.string()) });
const DAILY_CALLS = 100;

export class CommunicationWatch {
  readonly coverage = new Map<string, Coverage>();
  private readonly turns = new Map<string, TurnEvidence>();
  private readonly starts = new Map<string, number>();
  private readonly store: Supervision;
  private readonly outbox: Outbox;
  private readonly desk: Desk;
  private readonly team: (project: Project) => Team;
  private readonly halt = new AbortController();
  private running = false;
  private next = 0;

  constructor(store: Supervision, outbox: Outbox, desk: Desk, team: (project: Project) => Team) {
    this.store = store; this.outbox = outbox; this.desk = desk; this.team = team;
  }

  started(agent: string): void { this.starts.set(agent, Date.now()); }
  ended(agent: string, text: string, complete: boolean): void {
    this.turns.set(agent, { started: this.starts.get(agent) ?? null, ended: Date.now(), text: text.slice(0, 8000), complete: complete && text.length <= 8000 });
    this.starts.delete(agent);
    if (this.turns.size > 1000) this.turns.delete(this.turns.keys().next().value!);
  }
  dispose(): void { this.halt.abort(); this.turns.clear(); this.starts.clear(); }

  private budget() {
    const path = join(this.store.root, "jev-budget.json");
    const day = new Date().toISOString().slice(0, 10);
    const held = existsSync(path) ? Budget.parse(JSON.parse(readFileSync(path, "utf8"))) : { version: 2 as const, day, calls: 0, cases: {} };
    return { path, value: held.day === day ? held : { version: 2 as const, day, calls: 0, cases: {} as Record<string, string> } };
  }

  async tick(): Promise<void> {
    if (this.running || this.halt.signal.aborted) return;
    this.running = true;
    try {
      const binding = this.store.read();
      if (!binding.active) return;
      const projects = binding.projects;
      if (!projects.length) return;
      const chosen = Array.from({ length: Math.min(2, projects.length) }, (_, i) => projects[(this.next + i) % projects.length]!);
      this.next = (this.next + chosen.length) % projects.length;
      await Promise.all(chosen.map(async (scope) => {
        const project = projectOf(scope.root, this.store.root);
        const team = this.team(project);
        const set = (status: Coverage["status"], detail: string, callsToday = 0) => this.coverage.set(scope.id, { status, detail, at: Date.now(), callsToday });
        if (team.attention.communication !== "shadow") { set("off", "Communication assessment is off."); return; }
        if (!team.sensor || team.attention.by !== "jev") { set("unknown", "Choose Jev and configure its key before enabling shadow assessment."); return; }
        try {
          const { spec, key } = team.sensor;
          const ledger = loadLedger(project.state);
          const cases = Object.values(ledger.tasks).filter((t) => t.handback && Date.now() - t.handback.at < 86_400_000).map((t) => communicationCase(project, t, ledger, this.outbox.records(), this.turns.get(ledger.lanes[t.lane]?.lead ?? ""), spec.stateChars));
          const budget = this.budget();
          const item = cases.find((c) => !c.unknown && budget.value.cases[c.id] !== c.revision);
          if (!item) { set("unknown", cases.find((c) => c.unknown)?.unknown ?? "No new complete communication episode; external Lead coverage is limited.", budget.value.calls); return; }
          if (budget.value.calls >= DAILY_CALLS) { set("budget", "The machine's daily 100-call communication budget is exhausted.", budget.value.calls); return; }
          budget.value.calls++; budget.value.cases[item.id] = item.revision;
          writeJson(budget.path, budget.value);
          const askedAt = Date.now();
          const result = readCommunicationAnswers(await decide({ ...spec, retries: 0 }, key, item.state, communicationQuestions, item.id, fetch, this.halt.signal), spec.model);
          if (this.halt.signal.aborted || this.store.read().revision !== binding.revision || this.team(project).attention.communication !== "shadow") return;
          const fresh = loadLedger(project.state);
          const task = Object.values(fresh.tasks).find((t) => `${project.slug}/${t.id}` === item.id);
          if (!task || communicationCase(project, task, fresh, this.outbox.records(), this.turns.get(item.lead), spec.stateChars).revision !== item.revision) { set("unknown", "This episode changed while being assessed.", budget.value.calls); return; }
          const found = Object.entries(result.answers).filter(([, a]) => a.choice === "deficient" && a.p >= 0.9).map(([name]) => `communication_${name}`);
          await keepAssessment(project.state, { at: Date.now(), askedAt, seat: item.lead, provider: "", turnId: item.revision, running: false,
            sensor: "communication", model: spec.model, id: item.id, cost: result.cost,
            questions: Object.fromEntries(Object.entries(obligations).map(([k, instructions]) => [k, { view: "work" as const, instructions }])),
            answers: Object.fromEntries(Object.entries(result.answers).map(([k, a]) => [k, a.choice === "deficient" ? a.p : 0])),
            facts: [], found, verdicts: Object.entries(result.answers).map(([question, a]) => ({ kind: "communication", question, says: a.choice, p: a.p })), views: { work: item.state } });
          if (found.length) await this.desk.notice(project, { id: item.lead, provider: "" }, found.map((kind) => ({ kind, level: "attend", quote: `Episode ${item.id} revision ${item.revision}: review the recorded communication evidence. Shadow result; confidence is not measured accuracy.`, facts: [], model: spec.model, p: result.answers[kind.slice(14)]!.p })));
          set("shadow", `Recorded ${item.id}; ${found.length} possible gaps. Notifications remain off.`, budget.value.calls);
        } catch { set("degraded", "Communication assessment failed or its evidence/budget could not be read; no automatic retry for this episode."); }
      }));
    } finally { this.running = false; }
  }
}
