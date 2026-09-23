/** Types only: the RPC contracts carry `z.json()`, so hand-copied shapes on each side never met the compiler. */

export type FlowSeat = { id: string; role: string; status: string; minutes: number; waiting: string[] };
export type FlowTask = { id: string; title: string; status: string; kind: string; peer: FlowSeat | null; minutes: number; handback: number | null };
export type FlowLane = { id: string; title: string; status: string; branch: string; base?: string; lead: FlowSeat | null; tasks: FlowTask[]; taskCount: number; running: number; open: boolean; after?: string[]; held?: string };
export type FlowAsk = { id: string; kind: string; fromRole: string; to: string; minutes: number; text: string };
export type WatchLean = { title: string; p: number; bar: number };
export type WatchSeat = {
  id: string;
  name: string;
  running: boolean;
  lean: WatchLean | null;
};
export type WatchIncident = {
  id: string;
  title: string;
  level: "page" | "attend";
  name: string;
  minutes: number;
  quote: string;
  source: "code" | "jev" | "watcher";
  sure: { p: number; bar: number } | null;
  told: "lead" | "supervisor" | null;
  lane: string | null;
  held: string | null;
};
export type WatcherSeat = { id: string; status: string; minutes: number; queued: number };
export type WatchView = {
  by: "seat" | "jev";
  on: boolean;
  keyed: boolean;
  telling: boolean;
  judgeMinutes: number;
  failing: { minutes: number; detail: string } | null;
  watcher: WatcherSeat | null;
  lanes: number;
  seats: WatchSeat[];
  lastRead: number | null;
  read: { turns: number; cost: number };
  marks: { total: number; open: number; useful: number; noise: number; unknown: number };
  incidents: WatchIncident[];
  trouble: { kind: string; minutes: number; detail: string }[];
};
export type FlowView = { project: string; at: number; revision: string; supervisors: FlowSeat[]; lanes: FlowLane[]; moreLanes: number; asks: FlowAsk[]; watch: WatchView };
export type Check = { id: string; ok: boolean; detail: string };

export type CleanItem = {
  path: string;
  kind: "seat" | "copy" | "records" | "snapshot" | "backup";
  why: string;
  bytes: number;
  careful: boolean;
  held: string | null;
};
export type CleanView = { items: CleanItem[]; removed: string[]; failed: { path: string; error: string }[] };

export type UpdateCommit = { sha: string; subject: string };
export type UpdateView = {
  dir: string;
  version: string;
  next: string | null;
  head: string;
  date: string | null;
  fetched: boolean;
  branch: string | null;
  upstream: string | null;
  behind: number;
  ahead: number;
  commits: UpdateCommit[];
  installs: boolean;
  paseo: string | null;
  blocked: string | null;
  busy: string[];
  updated: { from: string; to: string } | null;
};

export type MigrateStep = {
  kind: "settings" | "block" | "seat";
  where: string;
  what: string;
  detail: string[];
  auto: boolean;
};
/** Guides and records are only told about, never replaced. */
export type ContentChange = {
  unit: string;
  kind: "guide" | "record" | "prompt" | "skill" | "team";
  change: "added" | "changed" | "removed";
  kept: boolean;
  keepable: boolean;
};
export type MigrateView = {
  stamp: string;
  since: string;
  steps: MigrateStep[];
  done: string[];
  content: ContentChange[];
  state: { upgraded: string[]; failed: { where: string; error: string }[] };
};
