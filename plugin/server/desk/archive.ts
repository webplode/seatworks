import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { lastBytes } from "../core/gate.ts";
import { appendRolling } from "../core/rolling.ts";
import type { AgentRef, Ask, Lane, Ledger, Task } from "./ledger.ts";
import { laneRecords } from "./records.ts";

export const KEEP_CLOSED_LANES = 20;
export const ARCHIVE_KEEP_BYTES = 64 * 1024 * 1024;
export const DESK_ROTATE_BYTES = 8 * 1024 * 1024;
export const DESK_KEEP_BYTES = 16 * 1024 * 1024;
export const RECORD_TAIL_BYTES = 1024 * 1024;

/** A lane that left the ledger, one file each: its entries and the records it wrote, by path under the state directory. */
export type LaneArchive = { lane?: Lane; tasks: Task[]; asks: Ask[]; agents: AgentRef[]; records: Record<string, string> };
export type Taken = { lanes: LaneArchive[]; agents: AgentRef[]; asks: Ask[] };

export function archiveDir(state: string): string {
  return join(state, "archive");
}

const laneNumber = (id: string) => Number(id.slice(1));

/** Lane ids the open work names, a hand-back or a `lane/l7-…` branch included; naming one too many only keeps it longer. */
function carriedOn(ledger: Ledger): Set<string> {
  const open = new Set(Object.values(ledger.lanes).filter((lane) => lane.status !== "closed").map((lane) => lane.id));
  const text = [
    ...Object.values(ledger.lanes).filter((lane) => open.has(lane.id)).flatMap((lane) => [lane.title, lane.outcome, lane.base, lane.issue ?? "", ...lane.acceptance, ...(lane.after ?? [])]),
    ...Object.values(ledger.tasks).filter((task) => open.has(task.lane)).flatMap((task) => [task.title, task.goal, task.context ?? "", ...task.acceptance]),
    ...Object.values(ledger.asks).filter((ask) => ask.status === "open").map((ask) => ask.text),
  ].join("\n");
  return new Set((text.match(/\bL\d+\b/gi) ?? []).map((id) => id.toUpperCase()));
}

/**
 * Takes out what nothing reads again: closed lanes past the newest few once nothing of theirs is pending or named by open
 * work, gone seats with no lane but each role's newest, and answered asks with no lane whose asker left.
 */
export function takeFinished(ledger: Ledger, gone: (agentId: string) => boolean): Taken | undefined {
  const carried = carriedOn(ledger);
  const closed = Object.values(ledger.lanes)
    .filter((lane) => lane.status === "closed")
    .sort((a, b) => laneNumber(b.id) - laneNumber(a.id))
    .slice(KEEP_CLOSED_LANES);
  const taken: Taken = { lanes: [], agents: [], asks: [] };
  for (const lane of closed) {
    const tasks = Object.values(ledger.tasks).filter((task) => task.lane === lane.id);
    const asks = Object.values(ledger.asks).filter((ask) => ask.lane === lane.id);
    const agents = Object.values(ledger.agents).filter((agent) => agent.lane === lane.id);
    const taskIds = new Set(tasks.map((task) => task.id));
    const seats = new Set([lane.lead, ...tasks.map((task) => task.peer), ...agents.map((agent) => agent.id)].filter((id): id is string => Boolean(id)));
    const pending =
      carried.has(lane.id) ||
      lane.restoring !== undefined ||
      Object.values(ledger.slots).some((slot) => slot.lane === lane.id || (slot.task !== undefined && taskIds.has(slot.task)) || slot.id === lane.slot) ||
      tasks.some((task) => task.status === "queued" || task.status === "merging") ||
      asks.some((ask) => ask.status === "open") ||
      [...seats].some((id) => !gone(id));
    if (pending) continue;
    delete ledger.lanes[lane.id];
    for (const task of tasks) delete ledger.tasks[task.id];
    for (const ask of asks) delete ledger.asks[ask.id];
    for (const agent of agents) delete ledger.agents[agent.id];
    taken.lanes.push({ lane, tasks, asks, agents, records: {} });
  }
  const newest = new Map<string, string>();
  for (const agent of Object.values(ledger.agents)) if (!agent.lane) newest.set(agent.role, agent.id);
  for (const agent of Object.values(ledger.agents)) {
    if (agent.lane || newest.get(agent.role) === agent.id || !gone(agent.id)) continue;
    if (Object.values(ledger.asks).some((ask) => ask.status === "open" && (ask.from === agent.id || ask.to === agent.id))) continue;
    delete ledger.agents[agent.id];
    taken.agents.push(agent);
  }
  for (const ask of Object.values(ledger.asks)) {
    if (ask.lane || ask.status !== "answered" || ledger.agents[ask.from] || !gone(ask.from)) continue;
    delete ledger.asks[ask.id];
    taken.asks.push(ask);
  }
  return taken.lanes.length + taken.agents.length + taken.asks.length > 0 ? taken : undefined;
}

/** Keyed by lane, so doing it again after a crash rewrites the same file; an unreadable one is started over, not left to stop every round. */
function fileLane(state: string, id: string, change: (archive: LaneArchive) => void): void {
  const file = join(archiveDir(state), `${id}.json.gz`);
  let archive: LaneArchive = { tasks: [], asks: [], agents: [], records: {} };
  if (existsSync(file)) {
    try {
      archive = JSON.parse(gunzipSync(readFileSync(file)).toString("utf-8")) as LaneArchive;
    } catch (error) {
      console.error(`seatworks-v2: ${file} could not be read and is started over:`, error);
    }
  }
  change(archive);
  mkdirSync(archiveDir(state), { recursive: true });
  writeFileSync(`${file}.part`, gzipSync(JSON.stringify(archive)));
  renameSync(`${file}.part`, file);
}

/** Written before the ledger is saved: a crash between the two files a lane again, never loses it. */
export function keepArchived(state: string, taken: Taken): void {
  for (const entry of taken.lanes) fileLane(state, entry.lane!.id, (archive) => Object.assign(archive, { lane: entry.lane, tasks: entry.tasks, asks: entry.asks, agents: entry.agents }));
  if (taken.agents.length + taken.asks.length === 0) return;
  const roll = { dir: archiveDir(state), current: "desk.log", prefix: "desk.", ext: ".log", rotateAt: DESK_ROTATE_BYTES, keepBytes: DESK_KEEP_BYTES, plain: 1 };
  const line = `${JSON.stringify({ at: new Date().toISOString(), agents: taken.agents, asks: taken.asks })}\n`;
  appendRolling(roll, line).catch((error: unknown) => console.error("seatworks-v2: packing a rolled archive/desk.log failed:", error));
}

/**
 * Moves the records of lanes the ledger no longer holds into their archive, keeping every hand-back and each owner's
 * last gate run, then drops the oldest lanes' archives past `keepBytes`. Only ids this ledger gave out are its to move.
 */
export function fileRecords(state: string, ledger: Ledger, keepBytes = ARCHIVE_KEEP_BYTES): string[] {
  const loose = laneRecords(state)
    .filter((record) => !ledger.lanes[record.lane] && laneNumber(record.lane) <= ledger.seq.lane)
    .sort((a, b) => b.at - a.at);
  const moved: string[] = [];
  for (const lane of new Set(loose.map((record) => record.lane))) {
    const records = loose.filter((record) => record.lane === lane);
    const last = new Set<string>();
    fileLane(state, lane, (archive) => {
      for (const record of records) {
        const key = `${record.dir}:${record.owner}`;
        if (record.dir === "gates" && last.has(key)) continue;
        last.add(key);
        const file = join(state, record.dir, record.name);
        // Only the tail: a gate that printed hundreds of megabytes brought the plugin down whole, and its failure is at the end.
        const cut = statSync(file).size > RECORD_TAIL_BYTES ? `[the start of this log was cut; its last ${RECORD_TAIL_BYTES} bytes follow]\n` : "";
        archive.records[`${record.dir}/${record.name}`] = cut + lastBytes(file, RECORD_TAIL_BYTES);
      }
    });
    for (const record of records) {
      rmSync(join(state, record.dir, record.name), { force: true });
      moved.push(`${record.dir}/${record.name}`);
    }
  }
  const dir = archiveDir(state);
  if (!existsSync(dir)) return moved;
  let total = 0;
  const number = (name: string) => laneNumber(name.split(".")[0]!);
  const filed = readdirSync(dir).filter((name) => /^L\d+\.json\.gz$/.test(name));
  for (const name of filed.sort((a, b) => number(b) - number(a))) {
    total += statSync(join(dir, name)).size;
    if (total > keepBytes) rmSync(join(dir, name), { force: true });
  }
  return moved;
}
