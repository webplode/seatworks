import { type Kit, can, seatOf } from "../../catalog/kit.ts";
import type { Seen, SeatView, Seats, Stream } from "../../core/ports.ts";
import type { Sibling } from "../../desk/ledger.ts";
import { type Fact, Recovery, type Rules, afterChange, contradicted, stuck, unverified } from "./facts.ts";
import { Window } from "./window.ts";

export type WatchedSeat = { id: string; provider: string; cwd: string; title?: string | null };

/**
 * `goal` is null when the ledger could not be read, and empty until it has placed the seat. `handedBack` is the outcome of
 * a hand-back made since `at` that the desk did not gate itself.
 */
export type SeatContext = { rules: Rules; handedBack: (at: number) => string | undefined; goal: string | null; context: string; beside: Sibling[]; role: string; can: string[] };

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

export class SeatWatch {
  readonly seat: WatchedSeat;
  readonly window = new Window();
  readonly noted: Fact[] = [];
  running = false;
  turnId: string | null = null;
  startedAt = 0;
  reading: { turnId: string | null; answers: Record<string, number> } | undefined;
  readings = 0;
  spent = 0;
  readAt = 0;
  readonly peaks = new Map<string, number>();
  private readonly durations: number[] = [];
  private readonly told = new Set<string>();
  private readonly recovery = new Recovery();
  private readonly context: () => SeatContext | undefined;
  private current: SeatContext | undefined;

  constructor(seat: WatchedSeat, context: () => SeatContext | undefined) {
    this.seat = seat;
    this.context = context;
  }

  private rules(): Rules | undefined {
    return this.brief()?.rules;
  }

  see(seen: Seen, now = Date.now()): Fact[] {
    if (seen.kind === "reset") {
      this.reading = undefined;
      this.window.clear();
      this.recovery.reset();
      this.told.clear();
      this.noted.length = 0;
      return [];
    }
    if (seen.kind === "turn") {
      if (seen.phase === "started") return this.started(seen.turnId, seen.at ?? now);
      if (this.running && this.turnId !== null && seen.turnId !== null && seen.turnId !== this.turnId) return [];
      return this.ended(seen.phase, now);
    }
    const { row } = seen;
    const change = this.window.add(row);
    if (row.replay) return [];
    if (row.item.type === "user_message") {
      this.recovery.reset();
      for (const key of [...this.told]) if (key !== "long-turn") this.told.delete(key);
      this.noted.length = 0;
      // New subject: a two-in-a-row question must not pair a reading of the old instruction with the new.
      this.reading = undefined;
      return [];
    }
    const rules = this.rules();
    if (!rules) return [];
    const facts = afterChange(change, rules, (path) => this.lastRead(path, change.call?.id));
    if (change.settled && change.call && !change.call.pseudo) {
      facts.push(...this.recovery.step(change.call, rules));
      const pattern = stuck(this.window.sinceInstruction(), rules);
      if (pattern) facts.push({ kind: "stuck", level: "attend", quote: pattern });
      else this.told.delete("stuck");
    }
    return this.fresh(facts, change.call?.id);
  }

  longTurn(now: number, minutes: number): Fact[] {
    if (!this.running || !this.startedAt) return [];
    const floor = minutes * 60_000;
    const limit = this.durations.length >= 5 ? Math.max(floor, 3 * median(this.durations)) : floor;
    const took = now - this.startedAt;
    if (took < limit) return [];
    return this.fresh([{ kind: "long-turn", level: "attend", quote: `running for ${Math.round(took / 60_000)} minutes, past the ${Math.round(limit / 60_000)} this seat's turns take` }]);
  }

  private started(turnId: string | null, at: number): Fact[] {
    if (this.running && this.turnId === turnId && turnId !== null) return [];
    this.running = true;
    this.turnId = turnId;
    this.startedAt = at;
    this.current = this.context();
    this.told.clear();
    return [];
  }

  private ended(phase: "completed" | "failed" | "canceled", now: number): Fact[] {
    const since = this.startedAt;
    this.running = false;
    this.window.closeRunning();
    if (since) this.durations.push(now - since);
    if (this.durations.length > 20) this.durations.shift();
    this.startedAt = 0;
    const context = this.brief();
    if (phase !== "completed" || !context) return [];
    const handed = since ? context.handedBack(since) : undefined;
    const facts = [...unverified(this.window, context.rules, handed !== undefined), ...contradicted(this.window, context.rules, handed)];
    const pattern = stuck(this.window.sinceInstruction(), context.rules);
    if (pattern) facts.push({ kind: "stuck", level: "attend", quote: pattern });
    return this.fresh(facts);
  }

  private lastRead(path: string, skip?: string): string | undefined {
    for (let index = this.window.units.length - 1; index >= 0; index--) {
      const unit = this.window.units[index]!;
      if (unit.kind !== "call" || unit.call.id === skip || unit.call.detail.filePath !== path) continue;
      if (unit.call.detail.type === "read" && typeof unit.call.detail.content === "string") return unit.call.detail.content;
      if (unit.call.detail.type === "write" && unit.call.ended && typeof unit.call.detail.content === "string") return unit.call.detail.content;
    }
    return undefined;
  }

  /** Re-read until the ledger places the seat: a Peer's first turn starts before `start_task` writes its task. */
  brief(): SeatContext | undefined {
    if (!this.current?.goal) this.current = this.context();
    return this.current;
  }

  private fresh(facts: Fact[], call?: string): Fact[] {
    const kept = facts.filter((fact) => {
      const key = fact.kind === "stuck" || fact.kind === "long-turn" || fact.kind === "unverified" ? fact.kind : `${fact.kind}\n${call ?? fact.quote}`;
      if (this.told.has(key)) return false;
      this.told.add(key);
      return true;
    });
    this.noted.push(...kept);
    if (this.noted.length > 20) this.noted.splice(0, this.noted.length - 20);
    return kept;
  }
}

export type WatchDeps = {
  kit: Kit;
  seats: Seats;
  context: (seat: WatchedSeat) => SeatContext | undefined;
  found: (watch: SeatWatch, facts: Fact[]) => void;
  on: (seat: WatchedSeat) => boolean;
  moment?: (watch: SeatWatch, urgent: boolean) => void;
  dropped?: (id: string) => void;
  log?: (line: string, error?: unknown) => void;
};

export class Watches {
  private readonly deps: WatchDeps;
  private readonly followed = new Map<string, { stream: Stream; watch: SeatWatch }>();

  constructor(deps: WatchDeps) {
    this.deps = deps;
  }

  watched(provider: string | null | undefined): boolean {
    return can(seatOf(this.deps.kit, provider)?.role, "watched");
  }

  get(id: string): SeatWatch | undefined {
    return this.followed.get(id)?.watch;
  }

  all(): SeatWatch[] {
    return [...this.followed.values()].map((entry) => entry.watch);
  }

  private on(seat: WatchedSeat): boolean {
    return this.watched(seat.provider) && this.deps.on(seat);
  }

  follow(seat: WatchedSeat): void {
    if (this.followed.has(seat.id) || !this.on(seat)) return;
    const watch = new SeatWatch(seat, () => this.deps.context(seat));
    let stream: Stream;
    try {
      stream = this.deps.seats.watch(seat.id, (seen) => this.seen(watch, seen));
    } catch (error) {
      this.log(`${seat.id} could not be watched:`, error);
      return;
    }
    const entry = { stream, watch };
    this.followed.set(seat.id, entry);
    stream.ready.catch((error) => {
      if (this.followed.get(seat.id) === entry) this.followed.delete(seat.id);
      this.log(`${seat.id} could not be watched:`, error);
    });
  }

  drop(id: string): void {
    const entry = this.followed.get(id);
    if (!entry) return;
    this.followed.delete(id);
    entry.stream.stop();
    this.deps.dropped?.(id);
  }

  urgent(id: string): void {
    const watch = this.get(id);
    if (watch?.running) this.deps.moment?.(watch, true);
  }

  sync(live: Iterable<SeatView>): void {
    const ids = new Set<string>();
    for (const seat of live) {
      if (seat.archivedAt) continue;
      // Settings are read every round, so switching off lets the seat go within one, with no reload.
      if (this.on(seat)) ids.add(seat.id);
      this.follow(seat);
    }
    for (const id of [...this.followed.keys()]) if (!ids.has(id)) this.drop(id);
  }

  round(now: number, minutes: (watch: SeatWatch) => number): void {
    for (const { watch } of this.followed.values()) this.found(watch, watch.longTurn(now, minutes(watch)));
  }

  dispose(): void {
    for (const id of [...this.followed.keys()]) this.drop(id);
  }

  private seen(watch: SeatWatch, seen: Seen): void {
    const facts = watch.see(seen);
    this.found(watch, facts);
    if (!this.deps.moment) return;
    if (seen.kind === "turn" && seen.phase !== "started" && !watch.running) this.deps.moment(watch, true);
    else if (seen.kind === "row" && !seen.row.replay && watch.running) this.deps.moment(watch, facts.some((fact) => fact.kind === "call-failed" || fact.kind === "gate-failed" || fact.level === "page"));
  }

  private found(watch: SeatWatch, facts: Fact[]): void {
    if (facts.length === 0) return;
    try {
      this.deps.found(watch, facts);
    } catch (error) {
      this.log(`what ${watch.seat.id} did could not be recorded:`, error);
    }
  }

  private log(line: string, error?: unknown): void {
    (this.deps.log ?? ((text, cause) => console.error(`seatworks-v2: ${text}`, cause ?? "")))(line, error);
  }
}
