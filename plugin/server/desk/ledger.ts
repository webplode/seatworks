import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "../core/store.ts";
import { errorText } from "../core/errors.ts";
import { STATE_VERSION } from "../core/state.ts";

export type LaneStatus = "waiting" | "open" | "closed";
export type TaskStatus = "waiting" | "running" | "done" | "rework" | "queued" | "merging" | "merged" | "failed" | "cut" | "stalled";
/** Free-form: the ledger carries whatever it is told, because nothing routes on it. */
export type AskKind = string;
/** What a change replaced, kept so the record says what the work was asked before it was asked again. */
export type Amendment = { at: number; by: string; why: string; was: Record<string, string | string[]> };

export type Lane = {
  id: string;
  title: string;
  outcome: string;
  acceptance: string[];
  appetite?: string;
  deadline?: string;
  outOfScope: string[];
  issue?: string;
  base: string;
  branch: string;
  detourOf?: string;
  onBranch?: boolean;
  worktree?: string;
  slot?: string;
  writeSet: string[];
  contracts: string[];
  lead?: string;
  workspaceId?: string;
  opener: string;
  status: LaneStatus;
  after?: string[];
  opening?: { isolate?: boolean; role?: string };
  held?: { why: string; tried?: boolean };
  plans?: number;
  /** A plan held until a person approves it; its tasks start only then. */
  approval?: { plan: number; by: "human" | "supervisor"; since: number; signals: string[] };
  /** When its Lead last reported it ready; an amendment takes it away, since what it was ready against has changed. */
  ready?: { at: number };
  /** A landing held for the Human, for the lane branch at `head`; approved, it lands without being asked again while that holds. */
  landApproval?: { since: number; head: string; signals: string[]; evidence: string[]; overGate: boolean; approved?: { at: number; note: string } };
  landed?: boolean;
  amended?: Amendment[];
  restoring?: Restoring;
  landing?: { by: string; writers: string[] };
  openedAt: number;
  tasks: number;
};

export type Handback = { file: string; outcome: string; commit?: string; summary: string; at: number; gate?: { ok: boolean; note: string } };

export type Task = {
  id: string;
  lane: string;
  kind: "code" | "review";
  mode: "lane" | "parallel";
  of?: string;
  title: string;
  goal: string;
  acceptance: string[];
  owned: string[];
  outOfScope: string[];
  context?: string;
  skills?: string[];
  peer?: string;
  branch?: string;
  worktree?: string;
  slot?: string;
  startSha?: string;
  mergeSha?: string;
  status: TaskStatus;
  openedAt: number;
  updatedAt: number;
  handback?: Handback;
  plan?: number;
  after?: string[];
  opening?: { role: string };
  held?: { why: string; tried?: boolean };
  amended?: Amendment[];
  reworks?: number;
  silent: number;
  peerGone?: boolean;
};

export type Ask = {
  id: string;
  from: string;
  fromRole: string;
  to: string;
  lane?: string;
  task?: string;
  kind: AskKind;
  text: string;
  default?: string;
  status: "open" | "answered";
  openedAt: number;
  remindedAt?: number;
  reminders: number;
  escalated?: boolean;
  answer?: string;
};

/** A teardown waiting on the seats still writing in the copy. On the record, so a restart does not lose it. */
export type Releasing = { writers: string[]; dropBranch?: string; into?: string };

/** A lane in the project's own copy waiting to put its branch back; it acts only on a copy still on `branch`, since a later lane may own it. */
export type Restoring = { writers: string[]; base: string; branch: string; landed?: boolean };

export type Slot = { id: string; path: string; workspaceId?: string; lane?: string; task?: string; createdAt: number; releasing?: Releasing };

export type AgentRef = { id: string; role: string; lane?: string; task?: string; recordedAt?: number; spokeAt?: number };

export type Ledger = {
  version: number;
  seq: { lane: number; ask: number; slot?: number };
  lanes: Record<string, Lane>;
  tasks: Record<string, Task>;
  asks: Record<string, Ask>;
  agents: Record<string, AgentRef>;
  slots: Record<string, Slot>;
};

export function emptyLedger(): Ledger {
  return { version: STATE_VERSION, seq: { lane: 0, ask: 0 }, lanes: {}, tasks: {}, asks: {}, agents: {}, slots: {} };
}

export function ledgerFile(state: string): string {
  return join(state, "ledger.json");
}

/** The ledger, or throws why it cannot be read: never an empty one standing in for a file that is there. Absent is empty. */
export function loadLedger(state: string): Ledger {
  const fault = ledgerFault(state);
  if (fault) throw new Error(`${fault}. Nothing was read from it as if the project had no work on record. Only the Human can repair it or move it aside; no seat may write the desk's own files.`);
  const stored = readJson<Ledger | null>(ledgerFile(state), null);
  if (!stored) return emptyLedger();
  return { ...emptyLedger(), ...stored };
}

/** Why the ledger on disk cannot be read: parsed as nothing, the next write would erase the project. Absent is not a fault. */
export function ledgerFault(state: string): string | undefined {
  const file = ledgerFile(state);
  if (!existsSync(file)) return undefined;
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(file, "utf-8"));
  } catch (error) {
    return `${file} is there but could not be read: ${errorText(error)}`;
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return `${file} does not hold a record`;
  const version = (stored as { version?: unknown }).version;
  if (typeof version === "number" && version > STATE_VERSION) return `${file} is at state ${version}, made by a newer Seatworks than this one, which reads ${STATE_VERSION}`;
  if (version !== STATE_VERSION) return `${file} is at state ${JSON.stringify(version)} and this plugin reads ${STATE_VERSION}: its upgrade did not go through; the Plugin tab says why`;
  return undefined;
}

export function saveLedger(state: string, ledger: Ledger): void {
  cached.delete(state);
  writeJson(ledgerFile(state), ledger);
}

const cached = new Map<string, { mtimeMs: number; size: number; ledger: Ledger }>();

export function readLedger(state: string): Ledger {
  let stamp: { mtimeMs: number; size: number };
  try {
    stamp = statSync(ledgerFile(state));
  } catch {
    cached.delete(state);
    return emptyLedger();
  }
  const hit = cached.get(state);
  if (hit && hit.mtimeMs === stamp.mtimeMs && hit.size === stamp.size) return hit.ledger;
  const ledger = loadLedger(state);
  cached.set(state, { mtimeMs: stamp.mtimeMs, size: stamp.size, ledger });
  return ledger;
}

/** Sets what `changes` gives and keeps what it replaced in the entry's history; undefined when nothing would change. */
export function amend(entry: Lane | Task, changes: Record<string, string | string[]>, by: string, why: string, at = Date.now()): Amendment | undefined {
  const fields = entry as unknown as Record<string, string | string[]>;
  const was: Amendment["was"] = {};
  for (const [field, value] of Object.entries(changes)) {
    if (JSON.stringify(fields[field]) === JSON.stringify(value)) continue;
    was[field] = fields[field]!;
    fields[field] = value;
  }
  if (Object.keys(was).length === 0) return undefined;
  const amendment = { at, by, why, was };
  entry.amended = [...(entry.amended ?? []), amendment];
  return amendment;
}

export function nextLaneId(ledger: Ledger): string {
  ledger.seq.lane += 1;
  return `L${ledger.seq.lane}`;
}

export function nextTaskId(lane: Lane, kind: Task["kind"]): string {
  lane.tasks += 1;
  return `${lane.id}-${kind === "review" ? "R" : "T"}${lane.tasks}`;
}

/** Never handed out twice: a reused id gave a copy the sweep was removing the same path as the next one created. */
export function nextSlotId(ledger: Ledger): string {
  const taken = Object.keys(ledger.slots)
    .map((id) => Number(id.replace(/^S/, "")))
    .filter((n) => Number.isInteger(n));
  const next = Math.max(ledger.seq.slot ?? -1, ...taken) + 1;
  ledger.seq.slot = next;
  return `S${next}`;
}

export function nextAskId(ledger: Ledger): string {
  ledger.seq.ask += 1;
  return `A${ledger.seq.ask}`;
}

export function findTask(ledger: Ledger, id: string): Task | undefined {
  return ledger.tasks[id.trim().toUpperCase()];
}

export function findLane(ledger: Ledger, id: string): Lane | undefined {
  return ledger.lanes[id.trim().toUpperCase()];
}

export function laneOfLead(ledger: Ledger, agentId: string): Lane | undefined {
  return Object.values(ledger.lanes).find((lane) => lane.lead === agentId && lane.status === "open");
}

export function taskOfPeer(ledger: Ledger, agentId: string): Task | undefined {
  return Object.values(ledger.tasks).find((task) => task.peer === agentId);
}

export function openAsksTo(ledger: Ledger, agentId: string): Ask[] {
  return Object.values(ledger.asks).filter((ask) => ask.status === "open" && ask.to === agentId);
}

export function openAsksFrom(ledger: Ledger, agentId: string): Ask[] {
  return Object.values(ledger.asks).filter((ask) => ask.status === "open" && ask.from === agentId);
}

/** The lane in the project's own copy: an open one without a copy of its own, or a closed one whose Lead is still ending a turn there. */
export function ownCopyHolder(lanes: Lane[]): Lane | undefined {
  return lanes.find((lane) => lane.status === "open" && !lane.slot) ?? lanes.find((lane) => lane.restoring);
}

export function tasksOf(ledger: Ledger, laneId: string): Task[] {
  return Object.values(ledger.tasks).filter((task) => task.lane === laneId);
}

export const ACTIVE: TaskStatus[] = ["running", "rework", "queued", "merging"];

/** A task written beside this one and the paths it owns, so a Peer's goal says a stub is somebody else's work in progress. */
export type Sibling = { task: string; title: string; owned: string[] };

/** The tasks of `task`'s lane still being written, each in a copy of its own, and what each owns. */
export function alongside(ledger: Ledger, task: Task): Sibling[] {
  return tasksOf(ledger, task.lane)
    .filter((other) => other.id !== task.id && ACTIVE.includes(other.status))
    .map((other) => ({ task: other.id, title: other.title, owned: other.owned }));
}

export function activeTasks(ledger: Ledger, laneId: string): Task[] {
  return tasksOf(ledger, laneId).filter((task) => ACTIVE.includes(task.status));
}

/** Cut between words when a title runs past `max`, so a branch never ends in half a word. */
export function slugify(text: string, max = 32): string {
  const whole = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (whole.length <= max) return whole || "work";
  const cut = whole.slice(0, max + 1);
  return cut.includes("-") ? cut.slice(0, cut.lastIndexOf("-")) : cut.slice(0, max);
}
