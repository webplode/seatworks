import type { SeatLook, Seats } from "../core/ports.ts";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DeliveryGuard } from "../../shared/supervision.ts";
import { Operation } from "../../shared/supervision.ts";
import { writeJson } from "../core/store.ts";

export const LetterSchema = z.object({
  id: z.string(), to: z.string(), key: z.string(), text: z.string(), at: z.number(),
  state: z.enum(["queued", "sending", "delivered", "unknown", "acknowledged", "revoked", "expired"]),
  detail: z.string().optional(), deliveredAt: z.number().optional(), acknowledgedAt: z.number().optional(),
  guard: z.object({ revision: z.number(), actor: z.string(), project: z.string(), workspace: z.string(), operation: Operation, recipient: z.literal("supervisor").optional() }).optional(),
});
export type Letter = z.infer<typeof LetterSchema>;
export type Posting = { to: string; key: string; text: string; guard?: DeliveryGuard };
export type Validate = (letter: Letter, seat: SeatLook) => string | undefined;
export type Posted = "sent" | "held" | "duplicate";
export type Compose = (to: string, letters: Letter[]) => string | Promise<string>;
/** Told when a letter is given up on, so that the one thing the desk must not lose is not lost quietly. */
export type Dropped = (letter: Letter, now: number) => void;
/** Whether the seat's harness takes a text into a running turn rather than replacing the turn with it. */
export type Steers = (seat: SeatLook) => boolean;

const KEEP_MS = 7 * 24 * 3_600_000;
const DUPLICATE_MS = 30 * 60_000;
const GRACE_MS = 10 * 60_000;
const SETTLE_MS = 60_000;

export function busy(status: string | null | undefined): boolean {
  return status === "running" || status === "initializing";
}

export class Outbox {
  private readonly file: string;
  private readonly compose: Compose;
  private readonly seats: Seats;
  private readonly dropped: Dropped | undefined;
  private readonly steers: Steers;
  private readonly awaiting = new Map<string, number>();
  private readonly started = new Map<string, number>();
  private recovered = false;
  private readonly validate: Validate;

  /** Keyed on the reader too: desk ids are unique only per project, and this one file serves them all. */
  private static held(letter: { to: string; key: string }): string {
    return `${letter.to}\n${letter.key}`;
  }
  private readonly lanes = new Map<string, Promise<unknown>>();


  constructor(file: string, compose: Compose, seats: Seats, dropped?: Dropped, steers: Steers = () => false, validate: Validate = () => undefined) {
    this.file = file;
    this.compose = compose;
    this.seats = seats;
    this.dropped = dropped;
    this.steers = steers;
    this.validate = validate;
  }

  records(): Letter[] {
    if (!existsSync(this.file)) return [];
    const records = z.array(LetterSchema).parse(JSON.parse(readFileSync(this.file, "utf8")));
    if (!this.recovered) {
      this.recovered = true;
      let changed = false;
      for (const letter of records) if (letter.state === "sending") {
        letter.state = "unknown";
        letter.detail = "Process stopped around SDK send. Inspect the conversation before issuing a new command.";
        changed = true;
      }
      if (changed) this.save(records);
    }
    return records;
  }

  letters(): Letter[] {
    return this.records().filter((letter) => letter.state === "queued");
  }

  private save(letters: Letter[]): void {
    writeJson(this.file, letters);
  }

  private update(ids: Set<string>, change: (letter: Letter) => void): void {
    const records = this.records();
    for (const letter of records) if (ids.has(letter.id)) change(letter);
    this.save(records);
  }

  acknowledge(id: string, actor: string): void {
    const letter = this.records().find((entry) => entry.id === id);
    if (!letter || letter.to !== actor || letter.state !== "delivered") throw new Error("Only the addressed agent can acknowledge confirmed delivery.");
    this.update(new Set([id]), (entry) => { entry.state = "acknowledged"; entry.acknowledgedAt = Date.now(); });
  }

  private lane<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (this.lanes.get(key) ?? Promise.resolve()).then(run, run);
    this.lanes.set(key, next.catch(() => undefined));
    return next;
  }

  async post(letter: Posting): Promise<Posted> {
    const now = Date.now();
    const records = this.records();
    if (records.some((entry) => Outbox.held(entry) === Outbox.held(letter) &&
      (entry.guard || ["queued", "sending", "unknown"].includes(entry.state) || now - (entry.deliveredAt ?? entry.at) < DUPLICATE_MS))) return "duplicate";
    const stored: Letter = { ...letter, id: randomUUID(), at: now, state: "queued" };
    this.save([...records, stored]);
    const sent = await this.pump(letter.to);
    return sent.has(stored.id) ? "sent" : "held";
  }

  turnStarted(agentId: string, now = Date.now()): void {
    this.started.set(agentId, now);
  }

  turnEnded(agentId: string): void {
    this.awaiting.delete(agentId);
    this.started.delete(agentId);
  }

  archived(agentId: string): void {
    this.awaiting.delete(agentId);
    this.started.delete(agentId);
    const ids = new Set(this.pending(agentId).filter((letter) => letter.guard).map((letter) => letter.id));
    if (ids.size) this.update(ids, (letter) => { letter.state = "revoked"; letter.detail = "The addressed agent was archived."; });
  }

  pending(agentId: string): Letter[] {
    return this.letters().filter((letter) => letter.to === agentId);
  }

  pump(to: string): Promise<Set<string>> {
    return this.lane(to, async () => {
      let mine = this.pending(to);
      if (mine.length === 0) return new Set<string>();
      // Held, not thrown: mail must not be lost, and one unanswerable address must not stop the round.
      const seat = await this.seats.look(to).catch(() => undefined);
      if (!seat) return new Set<string>();
      for (const letter of mine) {
        const reason = this.validate(letter, seat);
        const expired = Date.now() - letter.at >= KEEP_MS;
        if (reason || expired) this.update(new Set([letter.id]), (entry) => {
          entry.state = reason ? "revoked" : "expired";
          entry.detail = reason ?? "Delivery window expired.";
          if (expired) this.dropped?.(entry, Date.now());
        });
      }
      mine = this.pending(to);
      if (!mine.length) return new Set<string>();
      if (seat.archivedAt) {
        this.archived(to);
        return new Set<string>();
      }
      if ((seat.pendingPermissions?.length ?? 0) > 0) return new Set<string>();
      const since = this.awaiting.get(to);
      const waiting = since !== undefined && Date.now() - since < GRACE_MS;
      // A turn this desk never saw start — one running across a restart — is not known to be settled.
      const began = this.started.get(to);
      const steer = seat.status === "running" && began !== undefined && Date.now() - began >= SETTLE_MS && this.steers(seat);
      if (!steer && (busy(seat.status) || waiting)) return new Set<string>();
      const text = await this.compose(to, mine);
      const fresh = await this.seats.look(to).catch(() => undefined);
      if (!fresh || fresh.archivedAt || fresh.pendingPermissions?.length || (!steer && busy(fresh.status))) return new Set<string>();
      const invalid = mine.filter((letter) => this.validate(letter, fresh));
      for (const letter of invalid) this.update(new Set([letter.id]), (entry) => { entry.state = "revoked"; entry.detail = this.validate(letter, fresh); });
      if (invalid.length) return new Set<string>();
      const ids = new Set(mine.map((letter) => letter.id));
      this.update(ids, (letter) => { letter.state = "sending"; });
      try {
        await this.seats.send(to, text, steer);
      } catch (error) {
        this.update(ids, (letter) => { letter.state = "unknown"; letter.detail = "SDK send failed without a provable delivery outcome. Inspect before retrying."; });
        return new Set<string>();
      }
      const now = Date.now();
      this.awaiting.set(to, now);
      this.update(ids, (letter) => { letter.state = "delivered"; letter.deliveredAt = now; });
      return ids;
    });
  }
}
