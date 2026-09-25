import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { appendRolling } from "../core/rolling.ts";
import type { Ledger } from "./ledger.ts";

export const RECORD_ROTATE_BYTES = 8 * 1024 * 1024;
export const RECORD_KEEP_BYTES = 24 * 1024 * 1024;
export const GATE_LOGS_PER_OWNER = 5;

/** The newest roll stays text, because the retrospective greps a period that may straddle it. */
export function appendRecord(state: string, name: "events" | "attention" | "checkpoints", line: string): void {
  const roll = { dir: state, current: `${name}.log`, prefix: `${name}.`, ext: ".log", rotateAt: RECORD_ROTATE_BYTES, keepBytes: RECORD_KEEP_BYTES, plain: 1 };
  appendRolling(roll, line).catch((error: unknown) => console.error(`seatworks-v2: packing a rolled ${name}.log failed:`, error));
}

export type Named = { dir: string; name: string; owner: string; lane: string; at: number };

/** Gate logs are `gates/<lane or task>-<ms>.log`, hand-backs `handbacks/<task>-<ms>.md`; a task id starts with its lane's. */
export function laneRecords(state: string): Named[] {
  return [
    ["gates", ".log"],
    ["handbacks", ".md"],
  ].flatMap(([dir, ext]) => {
    const path = join(state, dir!);
    if (!existsSync(path)) return [];
    const shape = new RegExp(`^((L\\d+)(?:-[A-Z]\\d+)?)-(\\d+)\\${ext}$`);
    return readdirSync(path).flatMap((name) => {
      const match = shape.exec(name);
      return match ? [{ dir: dir!, name, owner: match[1]!, lane: match[2]!, at: Number(match[3]) }] : [];
    });
  });
}

/** A lane still in the ledger keeps every record but the gate runs a newer run of the same owner replaced. */
export function tidyRecords(state: string, ledger: Ledger): string[] {
  const logs = laneRecords(state)
    .filter((record) => record.dir === "gates" && ledger.lanes[record.lane])
    .sort((a, b) => b.at - a.at);
  const seen = new Map<string, number>();
  const dropped: string[] = [];
  for (const log of logs) {
    const rank = (seen.get(log.owner) ?? 0) + 1;
    seen.set(log.owner, rank);
    if (rank <= GATE_LOGS_PER_OWNER) continue;
    unlinkSync(join(state, log.dir, log.name));
    dropped.push(join(log.dir, log.name));
  }
  return dropped;
}
