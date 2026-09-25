import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { appendRolling, rolledStamps } from "../../../core/rolling.ts";
import type { Turn, View, ViewName } from "./views.ts";

/** One reading as it was kept; one kept before its `turn` was has none. */
export type Kept = {
  at: number;
  askedAt: number;
  seat: string;
  provider: string;
  turnId: string | null;
  running: boolean;
  sensor: string;
  model: string;
  id: string | null;
  cost: number | null;
  questions: Record<string, { view: ViewName; instructions: string; criteria?: { true: string; false: string } }>;
  answers: Record<string, number>;
  facts: { kind: string; level: string; quote: string }[];
  found: string[];
  verdicts: { kind: string; question: string; says: string; p: number }[];
  views: Partial<Record<ViewName, View>>;
  turn?: Turn;
};

export const ROTATE_BYTES = 32 * 1024 * 1024;
export const KEEP_BYTES = 96 * 1024 * 1024;

export const KEPT_FILE = "current.jsonl";
const ROLLED = { prefix: "", ext: ".jsonl" };

export function assessmentsDir(state: string): string {
  return join(state, "assessments");
}

/** Minutes since a reading was last kept, by one `stat` rather than parsing a megabytes-long file on every poll. */
export function lastKept(state: string, now = Date.now()): number | undefined {
  try {
    return Math.max(0, Math.round((now - statSync(join(assessmentsDir(state), KEPT_FILE)).mtimeMs) / 60_000));
  } catch {
    return undefined;
  }
}

const stamps = (names: string[], complete = false) => rolledStamps(names, ROLLED, complete);

export function keepAssessment(state: string, kept: Kept, rotateAt = ROTATE_BYTES, keepBytes = KEEP_BYTES): Promise<void> {
  return appendRolling({ dir: assessmentsDir(state), current: KEPT_FILE, ...ROLLED, rotateAt, keepBytes, plain: 0 }, `${JSON.stringify(kept)}\n`);
}

export type Tally = { turns: number; cost: number };

const tallyOf = (text: string): Tally => {
  let turns = 0;
  let cost = 0;
  for (const row of text.split("\n")) {
    if (!row.trim()) continue;
    try {
      const kept = JSON.parse(row) as { cost?: unknown };
      turns += 1;
      if (typeof kept.cost === "number") cost += kept.cost;
    } catch {}
  }
  return { turns, cost };
};

const counted = new Map<string, { ino: number; offset: number; current: Tally; rotated: Map<string, Tally> }>();

/**
 * Every kept reading for the project, counted incrementally: rotated files once, the current one from
 * the last offset, since the screen polls every few seconds and the file runs to megabytes.
 */
export function readTally(state: string): Tally {
  const dir = assessmentsDir(state);
  if (!existsSync(dir)) {
    counted.delete(dir);
    return { turns: 0, cost: 0 };
  }
  let seen = counted.get(dir);
  if (!seen) {
    seen = { ino: -1, offset: 0, current: { turns: 0, cost: 0 }, rotated: new Map() };
    counted.set(dir, seen);
  }
  const names = readdirSync(dir);
  const live = new Set(stamps(names, true));
  for (const stamp of [...seen.rotated.keys()]) if (!live.has(stamp)) seen.rotated.delete(stamp);
  for (const stamp of live) {
    if (seen.rotated.has(stamp)) continue;
    try {
      const text = names.includes(`${stamp}.jsonl.gz`) ? gunzipSync(readFileSync(join(dir, `${stamp}.jsonl.gz`))).toString("utf-8") : readFileSync(join(dir, `${stamp}.jsonl`), "utf-8");
      seen.rotated.set(stamp, tallyOf(text));
    } catch {
      // Being packed at this moment; it is counted on the next look.
    }
  }
  try {
    const file = join(dir, KEPT_FILE);
    const { ino, size } = statSync(file);
    if (ino !== seen.ino || size < seen.offset) Object.assign(seen, { ino, offset: 0, current: { turns: 0, cost: 0 } });
    if (size > seen.offset) {
      const chunk = Buffer.alloc(size - seen.offset);
      const fd = openSync(file, "r");
      try {
        readSync(fd, chunk, 0, chunk.length, seen.offset);
      } finally {
        closeSync(fd);
      }
      // Up to the last whole line: a reading being appended right now is counted next time.
      const end = chunk.lastIndexOf(0x0a) + 1;
      const more = tallyOf(chunk.subarray(0, end).toString("utf-8"));
      seen.offset += end;
      seen.current = { turns: seen.current.turns + more.turns, cost: seen.current.cost + more.cost };
    }
  } catch {
    Object.assign(seen, { ino: -1, offset: 0, current: { turns: 0, cost: 0 } });
  }
  let turns = seen.current.turns;
  let cost = seen.current.cost;
  for (const tally of seen.rotated.values()) {
    turns += tally.turns;
    cost += tally.cost;
  }
  return { turns, cost };
}

export function readAssessments(state: string): { kept: Kept[]; broken: number } {
  const dir = assessmentsDir(state);
  if (!existsSync(dir)) return { kept: [], broken: 0 };
  const names = readdirSync(dir);
  const kept: Kept[] = [];
  let broken = 0;
  const texts: string[] = [];
  for (const stamp of stamps(names, true)) {
    const zipped = () => gunzipSync(readFileSync(join(dir, `${stamp}.jsonl.gz`))).toString("utf-8");
    try {
      texts.push(names.includes(`${stamp}.jsonl.gz`) ? zipped() : readFileSync(join(dir, `${stamp}.jsonl`), "utf-8"));
    } catch {
      try {
        texts.push(zipped());
      } catch {
        broken += 1;
      }
    }
  }
  if (names.includes(KEPT_FILE)) texts.push(readFileSync(join(dir, KEPT_FILE), "utf-8"));
  for (const text of texts) {
    for (const row of text.split("\n")) {
      if (!row.trim()) continue;
      try {
        kept.push(JSON.parse(row) as Kept);
      } catch {
        broken += 1;
      }
    }
  }
  return { kept: kept.sort((a, b) => a.at - b.at), broken };
}
