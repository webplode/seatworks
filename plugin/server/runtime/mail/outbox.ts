import { KeyedQueue } from "../../core/keyed-queue.ts";
import { type Posted, type SeatLook, type Seats, midTurn } from "../../core/ports.ts";
import { isRecord } from "../../core/json.ts";
import { daemonLog } from "../../core/logger.ts";
import { keptFault, readKept, writeJson } from "../../core/store.ts";

export type Letter = { id: string; to: string; key: string; text: string; at: number; wakes?: false };

const isLetter = (value: unknown): value is Letter =>
  isRecord(value) && typeof value.to === "string" && typeof value.at === "number";
type Compose = (seat: SeatLook, letters: Letter[], remaining: number) => string;
/** `delivered`: letters reached their seat, at `at`; `dropped`: a letter given up on, and why; `holding`: its lane is held. */
export type Rules = {
  dropped?: (letter: Letter, now: number, why: string) => void;
  delivered?: (letters: Letter[], at: number) => void;
  holding?: (seat: SeatLook) => boolean;
};

const KEEP_MS = 7 * 24 * 3_600_000;
const DUPLICATE_MS = 30 * 60_000;
const GRACE_MS = 10 * 60_000;
const BATCH_COUNT = 8;
const BATCH_CHARS = 12_000;
/** How long an archived seat may yet be started again for the mail that asks something of it. */
const GONE_MS = 24 * 3_600_000;
/** Rounds a seat must be missing from Paseo, each listing the rest, before its mail is given up. */
const MISSES = 3;

export class Outbox {
  private readonly file: string;
  private readonly compose: Compose;
  private readonly seats: Pick<Seats, "look" | "send">;
  private readonly rules: Rules;
  private readonly awaiting = new Map<string, number>();
  private readonly sentKeys = new Map<string, number>();
  private readonly gone = new Set<string>();
  private readonly misses = new Map<string, number>();

  /** Keyed on the reader too: desk ids are unique only per project, and this one file serves them all. */
  private static keyOf(letter: { to: string; key: string }): string {
    return `${letter.to}\n${letter.key}`;
  }
  private readonly perSeat = new KeyedQueue();
  private counter = 0;

  constructor(file: string, compose: Compose, seats: Pick<Seats, "look" | "send">, rules: Rules = {}) {
    this.file = file;
    this.compose = compose;
    this.seats = seats;
    this.rules = rules;
  }

  /** Aged-out letters included, since both writers rebuild the file from this read; one that cannot be read throws. */
  letters(): Letter[] {
    const read = readKept<unknown[]>(this.file, [], Array.isArray);
    if ("fault" in read) throw keptFault(read.fault);
    return read.value.filter(isLetter);
  }

  /** Letters kept a week are given up on whoever they were for, and it says so. */
  private keep(letters: Letter[], now: number): Letter[] {
    const kept: Letter[] = [];
    for (const letter of letters) {
      if (now - letter.at < KEEP_MS) kept.push(letter);
      else this.rules.dropped?.(letter, now, "it was kept a week and never taken");
    }
    for (const agent of this.gone) if (!kept.some((letter) => letter.to === agent)) this.gone.delete(agent);
    return kept;
  }

  private save(letters: Letter[]): void {
    writeJson(this.file, letters);
  }

  /**
   * Gives up mail for seats `listed`, a round's listing of the seats Paseo has open, does not name: word that asks nothing
   * once its seat is archived, the rest a day on, and all of it once Paseo has not known the seat for a few rounds. A
   * seat stopped on a permission or in a held lane is listed, so its mail waits; an empty listing says nothing.
   */
  async sweep(listed: Set<string>, now = Date.now()): Promise<void> {
    if (listed.size === 0) return;
    for (const to of new Set(this.letters().map((letter) => letter.to))) {
      if (listed.has(to)) this.misses.delete(to);
      else await this.perSeat.run(to, () => this.sweepOne(to, now));
    }
  }

  private async sweepOne(to: string, now: number): Promise<void> {
    const seat = await this.seats.look(to).catch(() => undefined);
    if (!seat) {
      const missed = (this.misses.get(to) ?? 0) + 1;
      this.misses.set(to, missed);
      if (missed >= MISSES) this.drop(to, now, () => true, "Paseo no longer knows its seat");
      return;
    }
    this.misses.delete(to);
    if (!seat.archivedAt) return;
    if (now - Date.parse(seat.archivedAt) >= GONE_MS)
      this.drop(to, now, () => true, "its seat has been archived a day");
    else this.drop(to, now, (letter) => letter.wakes === false, "its seat is archived, and it asked nothing");
  }

  private drop(to: string, now: number, which: (letter: Letter) => boolean, why: string): void {
    const letters = this.letters();
    const given = letters.filter((letter) => letter.to === to && which(letter));
    if (given.length === 0) return;
    this.save(letters.filter((letter) => !given.includes(letter)));
    if (!letters.some((letter) => letter.to === to && !which(letter))) this.misses.delete(to);
    for (const letter of given) this.rules.dropped?.(letter, now, why);
  }

  async post(letter: Omit<Letter, "id" | "at">): Promise<Posted> {
    const now = Date.now();
    const sentAt = this.sentKeys.get(Outbox.keyOf(letter));
    const waiting = this.letters();
    if (
      (sentAt !== undefined && now - sentAt < DUPLICATE_MS) ||
      waiting.some((entry) => entry.key === letter.key && entry.to === letter.to && now - entry.at < KEEP_MS)
    ) {
      return "duplicate";
    }
    const stored: Letter = { ...letter, id: `${now}-${process.pid}-${++this.counter}`, at: now };
    this.save([...this.keep(waiting, now), stored]);
    const sent = await this.pump(letter.to);
    return sent.has(stored.id) ? "sent" : "held";
  }

  /** A seat starting a turn is there to read, an archived one Paseo started again included. */
  turnStarted(agentId: string): void {
    this.gone.delete(agentId);
  }

  turnEnded(agentId: string): void {
    this.forget(agentId);
  }

  /** A seat Paseo archived takes nothing more: its mail waits for someone to pass it on, and it is not looked up again. */
  archived(agentId: string): void {
    this.forget(agentId);
    this.gone.add(agentId);
  }

  private forget(agentId: string): void {
    this.awaiting.delete(agentId);
  }

  /** Every letter not yet sent, with when it is given up on: nothing else is sent a gone seat's mail. */
  held(): (Letter & { until: number })[] {
    return this.letters().map((letter) => ({ ...letter, until: letter.at + KEEP_MS }));
  }

  /** Takes back a letter its seat has not been sent, as one that says the same newer takes its place: whether it was still held. */
  withdraw(to: string, key: string): Promise<boolean> {
    return this.perSeat.run(to, async () => {
      const letters = this.letters();
      const kept = letters.filter((letter) => letter.to !== to || letter.key !== key);
      if (kept.length === letters.length) return false;
      this.save(kept);
      return true;
    });
  }

  pending(agentId: string): Letter[] {
    return this.letters().filter((letter) => letter.to === agentId);
  }

  /** The seat, when it is there to be sent mail: not gone, and not archived. */
  private async reachable(to: string): Promise<SeatLook | undefined> {
    if (this.gone.has(to)) return undefined;
    // Held, not thrown: mail must not be lost, and one unanswerable address must not stop the round.
    const seat = await this.seats.look(to).catch(() => undefined);
    if (!seat?.archivedAt) return seat;
    this.archived(to);
    return undefined;
  }

  /**
   * Everything held for a seat, as one text for the reply to a call of its own: read inside the turn it makes the call
   * in, with no send to replace that turn, so word that asks nothing goes too. Held as a pump holds it otherwise, and
   * kept when the reply is no longer `wanted` by the time it is taken.
   */
  take(to: string, wanted: () => boolean = () => true): Promise<string | undefined> {
    return this.perSeat.run(to, async () => {
      const mine = this.pending(to);
      const seat = mine.length > 0 ? await this.reachable(to) : undefined;
      // As a pump holds it: a permission waiting, or its lane on hold.
      if (!seat || (seat.pendingPermissions?.length ?? 0) > 0 || this.rules.holding?.(seat)) return undefined;
      if (!wanted()) return undefined;
      const batch = batchOf(mine);
      const ids = new Set(batch.map((letter) => letter.id));
      this.save(this.letters().filter((letter) => !ids.has(letter.id)));
      this.sent(batch, Date.now());
      return this.compose(seat, batch, mine.length - batch.length);
    });
  }

  /** Letters that reached their seat: a second post of one soon after is the same letter, and whoever waits hears. */
  private sent(letters: Letter[], now: number): void {
    for (const [key, at] of this.sentKeys) if (now - at >= DUPLICATE_MS) this.sentKeys.delete(key);
    for (const letter of letters) this.sentKeys.set(Outbox.keyOf(letter), now);
    this.rules.delivered?.(letters, now);
  }

  pump(to: string): Promise<Set<string>> {
    return this.perSeat.run(to, async () => {
      const mine = this.pending(to);
      const seat = mine.length > 0 ? await this.reachable(to) : undefined;
      if (!seat) return new Set<string>();
      if ((seat.pendingPermissions?.length ?? 0) > 0) return new Set<string>();
      if (this.rules.holding?.(seat)) return new Set<string>();
      const since = this.awaiting.get(to);
      const waiting = since !== undefined && Date.now() - since < GRACE_MS;
      // Never into a turn under way: a seat cut into while it thinks or writes loses the thought, and several hand-backs
      // steered in one by one scatter it. Its queue waits for the turn's end, or rides the reply to its next desk call.
      if (midTurn(seat.status) || waiting) return new Set<string>();
      // Word that asks nothing of an idle seat waits for a letter that does, or for a turn it is already in.
      if (mine.every((letter) => letter.wakes === false)) return new Set<string>();
      const batch = batchOf(mine);
      const text = this.compose(seat, batch, mine.length - batch.length);
      const kinds = [...new Set(batch.map((letter) => letter.key.split(":")[0]!))];
      try {
        await this.seats.send(to, text, kinds);
      } catch (error) {
        // Kept for the next pump: what posted it has already happened, and a retry would do it twice.
        daemonLog.error(`mail for ${to} was not taken:`, error);
        return new Set<string>();
      }
      const now = Date.now();
      this.awaiting.set(to, now);
      const ids = new Set(batch.map((letter) => letter.id));
      this.save(this.letters().filter((letter) => !ids.has(letter.id)));
      this.sent(batch, now);
      return ids;
    });
  }
}

/** The oldest letters that fit one intake boundary; the first always goes, so an oversized letter cannot block its queue. */
function batchOf(letters: Letter[]): Letter[] {
  const batch: Letter[] = [];
  let chars = 0;
  for (const letter of letters) {
    if (batch.length >= BATCH_COUNT || (batch.length > 0 && chars + letter.text.length > BATCH_CHARS)) break;
    batch.push(letter);
    chars += letter.text.length;
  }
  return batch;
}
