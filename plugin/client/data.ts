import { useRpc, usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Check, FlowAsk, FlowLane, FlowSeat, FlowTask, FlowView, WatchIncident, WatchLean, WatchSeat, WatchView } from "../shared/views.ts";
import { catalogRpc, doctorRpc, flowRpc, mcpParseRpc, pathsRpc, projectsAddRpc, projectsCandidatesRpc, projectsRemoveRpc, projectsRpc, settingsReadRpc, settingsWriteRpc, statusRpc, teamRpc } from "../shared/rpc.ts";

export type { Check, FlowAsk, FlowLane, FlowSeat, FlowTask, FlowView, WatchIncident, WatchLean, WatchSeat, WatchView };

export type Scalar = string | number | boolean;
export type Connect = { type: "stdio" | "http" | "sse"; command?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
export type Parsed = { id: string; label: string; connect: Connect } | { error: string };
export type SettingSpec = { type: "number" | "string" | "boolean"; label: string; default?: Scalar };
export type ModelView = { id: string; label: string; isDefault?: boolean; thinkingOptions?: { id: string; label: string; isDefault?: boolean }[] };

export type Catalog = {
  profiles: { id: string; role: string; harness: string; label: string }[];
  roles: { id: string; label: string; description: string; can: string[]; concern: string | null; defaults: { harness: string; model?: string; thinking?: string }; follows: string | null; harnesses: string[] }[];
  harnesses: { id: string; label: string; models: ModelView[]; thinking: boolean; transports: string[] }[];
  mcp: { id: string; label: string; description: string; kind: string; transport: string; settings: Record<string, SettingSpec>; defaults: { enabled: boolean }; roles: string[] }[];
  sensor: { model: string } | null;
};

export type TeamView = {
  project: string | null;
  errors: string[];
  attention: Required<AttentionChoice>;
  checkpoints: { plan: CheckpointMode; approve: "risky" | "every"; approver: "human" | "supervisor"; risk: string; land: CheckpointMode; landApprove: "risky" | "every"; landLines: number; forced: string | null };
  critic: { by: CriticBy };
  /** A project's own checkpoint log, read for whoever chooses a check's mode; null on the machine's defaults. */
  digest: { plan: Digest; land: Digest } | null;
  rules: string;
  mcp: Record<string, { label: string; enabled: boolean; roles: string[]; settings: Record<string, Scalar>; transport: string; template: boolean; connect: Connect | null; rule: string | null }>;
  roles: Record<string, { harness: string; provider: string; model: string | null; thinking: string | null; mcp: string[]; tools: Record<string, string[]>; skills: string[]; rules: string }>;
};

export type AttentionChoice = {
  communication?: "off" | "shadow";
  tickSeconds?: number; leadIdleMinutes?: number; askRemindMinutes?: number; maxReminders?: number;
  watch?: boolean; destructive?: string; testPath?: string; repeatsAt?: number; reworksAt?: number; reviewsAt?: number; suppressed?: string;
  longTurnMinutes?: number; incidentsPerDay?: number;
  by?: "seat" | "jev"; watcherQuietSeconds?: number; watcherEveryMinutes?: number; watcherChars?: number; watcherRotateAfter?: number; watcherJudgeMinutes?: number;
};
export type CheckpointMode = "off" | "shadow" | "on";
export type CriticBy = "seat" | "off";
export type Digest = { lines: string[]; state: "ready" | "stamped" | null };
export type RoleChoice = { harness?: string; model?: string; thinking?: string; rules?: string };
export type McpChoice = { enabled?: boolean; removed?: boolean; label?: string; connect?: Connect; roles?: string[]; tools?: Record<string, string[]>; rule?: string; settings?: Record<string, Scalar> };
export type SensorChoice = { key?: string };
export type Layer = { profiles?: { disabled: string[] }; critic?: { by?: CriticBy }; checkpoints?: { plan?: CheckpointMode; approve?: "risky" | "every"; approver?: "human" | "supervisor"; risk?: string; land?: CheckpointMode; landApprove?: "risky" | "every"; landLines?: number }; roles?: Record<string, RoleChoice>; mcp?: Record<string, McpChoice>; rules?: string; attention?: AttentionChoice; flow?: { live?: boolean; everySeconds?: number }; sensor?: SensorChoice };

export type ProjectRow = { slug: string; root: string };
export type PaseoProject = { name: string; root: string };
export type Folder = { name: string; path: string; repository: boolean };
/** `root` is the repository this folder belongs to when it is not itself that repository's top. */
export type Folders = { path: string; parent: string | null; repository: boolean; root?: string | null; folders: Folder[] };
export type FlowResult = FlowView | { unchanged: true; revision: string } | { error: string };
type SettingsRead = ({ status: "ready"; revision: string; values: Layer } | { status: "invalid"; revision: string; error: string }) & { machine: Layer };
type WriteResult = { status: "saved"; revision: string; values: Layer } | { status: "conflict"; error: string } | { status: "invalid"; error: string };
type AddResult = { slug: string; root: string } | { error: string };
type RemoveResult = { removed: string } | { error: string };

export type Data =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      of: string;
      catalog: Catalog;
      team: TeamView;
      projects: ProjectRow[];
      known: PaseoProject[];
      candidates: PaseoProject[];
      values: Layer;
      machine: Layer;
      revision: string;
      settingsError: string | null;
    };

type Call<Input, Output> = (input: Input) => Promise<Output>;
type Calls = {
  catalog: Call<Record<string, never>, Catalog>;
  projects: Call<Record<string, never>, ProjectRow[]>;
  add: Call<{ root: string }, AddResult>;
  remove: Call<{ project: string }, RemoveResult>;
  candidates: Call<{ roots: string[] }, string[]>;
  parseMcp: Call<{ text: string }, Parsed>;
  settings: Call<{ project?: string }, SettingsRead>;
  write: Call<{ project?: string; revision: string; values: Layer }, WriteResult>;
  team: Call<{ project?: string }, TeamView>;
  doctor: Call<{ project?: string }, Check[]>;
  status: Call<{ project: string }, { text: string; error?: string }>;
  flow: Call<{ project: string; since?: string; open?: string[] }, FlowResult>;
  paths: Call<{ path?: string }, Folders | { error: string }>;
};

/** The error's own words: Paseo wraps a handler's error as "Request failed: <words>. requestType=… code=…". */
export const message = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Request failed:\s*/, "").replace(/\s*requestType=\S+(\s+code=\S+)?\s*$/, "").trim() || text;
};

export async function attachProject(root: string, values: Layer, roles: Catalog["roles"], calls: Pick<Calls, "add" | "settings" | "write">): Promise<string> {
  const added = await calls.add({ root });
  if ("error" in added) throw new Error(added.error);
  if (Object.keys(values).length) {
    const read = await calls.settings({ project: added.slug });
    if (read.status !== "ready") throw new Error(read.error);
    const merged = foldRoles(read.values, values, (id) => {
      const spec = roles.find((r) => r.id === id);
      return spec ? harnessInForce(spec, read.values, read.machine) : undefined;
    });
    const written = await calls.write({ project: added.slug, revision: read.revision, values: merged });
    if (written.status !== "saved") throw new Error(written.error);
  }
  return added.slug;
}

export function useSeatworks(project?: string) {
  const bound = {
    catalog: useRpc(catalogRpc),
    projects: useRpc(projectsRpc),
    add: useRpc(projectsAddRpc),
    remove: useRpc(projectsRemoveRpc),
    candidates: useRpc(projectsCandidatesRpc),
    parseMcp: useRpc(mcpParseRpc),
    settings: useRpc(settingsReadRpc),
    write: useRpc(settingsWriteRpc),
    team: useRpc(teamRpc),
    doctor: useRpc(doctorRpc),
    status: useRpc(statusRpc),
    flow: useRpc(flowRpc),
    paths: useRpc(pathsRpc),
  };
  const paseo = usePaseo();
  const latest = useRef(bound as unknown as Calls);
  latest.current = bound as unknown as Calls;
  const [data, setData] = useState<Data>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  // Set by a save, cleared by its reload: the controls stay locked until drawn from what it produced.
  const settling = useRef(false);
  // Tagged with its screen: the hook serves every screen, and an untagged refusal showed on all of them.
  const [refusal, setRefusal] = useState<{ of: string; text: string } | null>(null);
  // A ref, so a callback built on an earlier render still tags the screen open now.
  const here = useRef(project ?? "");
  here.current = project ?? "";
  const setSaveError = useCallback((text: string | null) => setRefusal(text === null ? null : { of: here.current, text }), []);
  const saveError = refusal?.of === (project ?? "") ? refusal.text : null;
  // Whether the last write went; inferring it from no error here read another screen's refusal as success.
  const [saved, setSaved] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const paseoProjects = async (): Promise<PaseoProject[]> => {
      try {
        const listed = (await paseo.projects.list()) as { projects?: { projectDisplayName?: string; projectRootPath?: string }[] };
        return (listed.projects ?? [])
          .filter((entry): entry is { projectDisplayName?: string; projectRootPath: string } => typeof entry.projectRootPath === "string")
          .map((entry) => ({ name: entry.projectDisplayName ?? entry.projectRootPath, root: entry.projectRootPath }));
      } catch {
        return [];
      }
    };
    const load = async (): Promise<void> => {
      const call = latest.current;
      const [catalog, projects, team, settings, known] = await Promise.all([
        call.catalog({}),
        call.projects({}),
        call.team({ project }),
        call.settings({ project }),
        paseoProjects(),
      ]);
      const offerable = new Set(known.length > 0 ? await call.candidates({ roots: known.map((entry) => entry.root) }) : []);
      if (!alive) return;
      if (settling.current) {
        settling.current = false;
        setSaving(false);
      }
      setData({
        status: "ready",
        of: project ?? "",
        catalog,
        projects,
        known,
        candidates: known.filter((entry) => offerable.has(entry.root)),
        team,
        values: settings.status === "ready" ? settings.values : {},
        machine: settings.machine ?? {},
        revision: settings.revision,
        settingsError: settings.status === "ready" ? null : settings.error,
      });
    };
    // Only a move to another screen blanks it: blanking on a save's reload remounted every section and lost its local state.
    setData((held) => (held.status === "ready" && held.of === (project ?? "") ? held : { status: "loading" }));
    load().catch((error: unknown) => {
      if (!alive) return;
      if (settling.current) {
        settling.current = false;
        setSaving(false);
      }
      setData({ status: "error", error: message(error) });
    });
    return () => {
      alive = false;
    };
  }, [project, nonce, paseo]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  /**
   * Every desk write runs inside this: locked, refusal cleared, ending in a reload the controls stay locked until;
   * unlocking earlier let a click built on the pre-save view silently undo the save.
   */
  const writing = useCallback(
    async <T,>(run: () => Promise<T>, failed: T): Promise<T> => {
      setSaving(true);
      setSaveError(null);
      try {
        return await run();
      } catch (error) {
        setSaveError(message(error));
        setSaved(false);
        return failed;
      } finally {
        settling.current = true;
        reload();
      }
    },
    [reload],
  );

  const save = useCallback(
    async (change: (values: Layer) => Layer): Promise<boolean> => {
      if (data.status !== "ready") return false;
      return writing(async () => {
        const result = await latest.current.write({ project, revision: data.revision, values: change(data.values) });
        if (result.status !== "saved") {
          setSaveError(result.error);
          setSaved(false);
          return false;
        }
        setSaved(true);
        return true;
      }, false);
    },
    [data, project, writing],
  );

  const addProject = useCallback(async (root: string): Promise<string | null> => {
    setSaveError(null);
    try {
      const result = await latest.current.add({ root });
      if ("error" in result) {
        setSaveError(result.error);
        return null;
      }
      return result.slug;
    } catch (error) {
      setSaveError(message(error));
      return null;
    }
  }, []);

  const attach = useCallback(
    async (root: string, values: Layer): Promise<string | null> => {
      return writing(async () => {
        const slug = await attachProject(root, values, data.status === "ready" ? data.catalog.roles : [], latest.current);
        setSaved(true);
        return slug;
      }, null);
    },
    // `data` for the catalog's default harness; without it the callback keeps the first render's empty catalog.
    [data, writing],
  );

  const detach = useCallback(
    async (slug: string): Promise<boolean> => {
      return writing(async () => {
        const result = await latest.current.remove({ project: slug });
        if ("error" in result) {
          setSaveError(result.error);
          setSaved(false);
          return false;
        }
        setSaved(true);
        return true;
      }, false);
    },
    [writing],
  );

  const addServer = useCallback(
    async (text: string): Promise<string | null> => {
      setSaveError(null);
      try {
        const parsed = await latest.current.parseMcp({ text });
        if ("error" in parsed) {
          setSaveError(parsed.error);
          return null;
        }
        const id = parsed.id.trim();
        if (!id) {
          setSaveError("That snippet does not name the server; paste it as {\"mcp\": {\"name\": { … }}}.");
          return null;
        }
        // Only to roles whose agent can reach it: otherwise it was refused, and the narrowing control appears only once saved.
        if (data.status !== "ready") return null;
        const harnessOf = (role: InForce) => harnessInForce(role, data.values, data.machine);
        const reachable = data.catalog.roles
          .filter((role) => (data.catalog.harnesses.find((entry) => entry.id === harnessOf(role))?.transports ?? []).includes(parsed.connect.type))
          .map((role) => role.id);
        if (reachable.length === 0) {
          setSaveError(`No role's agent can reach a ${parsed.connect.type} server, so there is nobody to give it to.`);
          return null;
        }
        // A re-paste updates the connection, so the owner's narrowing is kept, intersected with what can reach the transport.
        const narrowed = data.values.mcp?.[id]?.roles;
        const roles = keptRoles(narrowed, reachable);
        if (narrowed?.length && roles.length === 0) {
          setSaveError(`This server is given to ${narrowed.join(", ")}, and no agent of theirs can reach a ${parsed.connect.type} server. Widen the roles on its own tab first.`);
          return null;
        }
        const saved = await save((values) => setMcp(values, id, { enabled: true, label: parsed.label || id, connect: parsed.connect, removed: false, roles }));
        // The snippet is the owner's only copy of what they pasted; it is not thrown away on a refusal.
        return saved ? id : null;
      } catch (error) {
        setSaveError(message(error));
        return null;
      }
    },
    [data, save],
  );

  const listFolders = useCallback((path?: string) => latest.current.paths(path ? { path } : {}), []);
  const runDoctor = useCallback(() => latest.current.doctor({ project }), [project]);
  const readStatus = useCallback((slug: string) => latest.current.status({ project: slug }), []);
  // The setup screen needs the layers of the project it is pointed at, which is not the one open here.
  const readSettings = useCallback((slug: string) => latest.current.settings({ project: slug }), []);
  return { data, save, reload, saving, saved, saveError, addProject, addServer, attach, detach, listFolders, runDoctor, readStatus, readSettings };
}

export function useFlow(project: string | undefined, everyMs = 5000, openKey = ""): { flow: FlowView | null; error: string | null } {
  const call = useRpc(flowRpc) as unknown as Call<{ project: string; since?: string; open?: string[] }, FlowResult>;
  const latest = useRef(call);
  latest.current = call;
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) {
      setFlow(null);
      setError(null);
      return;
    }
    let alive = true;
    let since: string | undefined;
    const read = async (): Promise<void> => {
      try {
        const open = openKey ? openKey.split(",") : [];
        const answer = await latest.current(since ? { project, since, open } : { project, open });
        if (!alive) return;
        if ("error" in answer) {
          setError(answer.error);
          return;
        }
        setError(null);
        if ("unchanged" in answer) return;
        since = answer.revision;
        setFlow(answer);
      } catch (problem) {
        if (alive) setError(message(problem));
      }
    };
    void read();
    const timer = setInterval(() => void read(), everyMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [project, everyMs, openKey]);

  return { flow, error };
}

export type Source = "here" | "machine" | "default";

export function sourceOf(values: Layer, machine: Layer, pick: (layer: Layer) => unknown, layer: "machine" | "project"): Source {
  if (pick(values) !== undefined) return "here";
  if (layer === "project" && pick(machine) !== undefined) return "machine";
  return "default";
}

function prune<T extends object>(values: Layer, key: "roles" | "mcp", id: string, entry: T): Layer {
  const group = { ...(values[key] as Record<string, T> | undefined) };
  if (Object.keys(entry).length === 0) delete group[id];
  else group[id] = entry;
  const next = { ...values };
  if (Object.keys(group).length === 0) delete next[key];
  else (next[key] as Record<string, T>) = group;
  return next;
}

/** Folds a setup draft into a project's layer; a role moved to another agent must drop the old agent's model, which nothing downstream fences. */
export function foldRoles(into: Layer, draft: Layer, harnessNow: (role: string) => string | undefined): Layer {
  return Object.entries(draft.roles ?? {}).reduce((values, [role, choice]) => {
    // Only a named harness counts as replaced; an unrecorded one is the kit default, whose picked model must survive.
    const now = harnessNow(role);
    const moved = Boolean(choice.harness) && now !== undefined && choice.harness !== now;
    return setRole(values, role, choice, moved);
  }, into);
}

export function setRole(values: Layer, role: string, choice: RoleChoice, newHarness = false): Layer {
  const current = values.roles?.[role] ?? {};
  // A new harness drops the old one's model and thinking, but not the seat's rules: those are the owner's writing.
  const base: RoleChoice = newHarness ? (current.rules ? { rules: current.rules } : {}) : current;
  return prune(values, "roles", role, { ...base, ...choice });
}

/** An emptied list is a narrowing to nobody, so a re-paste keeps it rather than hand the new token to every role. */
export function keptRoles(narrowed: string[] | undefined, reachable: string[]): string[] {
  return narrowed ? narrowed.filter((role) => reachable.includes(role)) : reachable;
}

type InForce = { id: string; follows?: string | null; defaults: { harness: string; model?: string; thinking?: string } };

/** Nearest layer first: draft, project, machine, kit default; skipping the middle two offered the wrong agent's models. */
export function harnessInForce(role: InForce, ...layers: (Layer | undefined)[]): string {
  for (const layer of layers) {
    const named = layer?.roles?.[role.id]?.harness;
    if (named) return named;
  }
  // The kit gave a follower the followed role's defaults, so that role's own walk ends in the same place.
  return role.follows ? harnessInForce({ id: role.follows, defaults: role.defaults }, ...layers) : role.defaults.harness;
}

/** Walked lowest layer up, as the resolver does: a layer naming another agent drops the models chosen below it. */
export function modelInForce(role: InForce, ...nearestFirst: (Layer | undefined)[]): string | undefined {
  // Where the resolver starts it: its defaults, or what the role it follows has in force.
  const followed = role.follows ? { id: role.follows, defaults: role.defaults } : undefined;
  const origin = followed ? { harness: harnessInForce(followed, ...nearestFirst), model: modelInForce(followed, ...nearestFirst) } : role.defaults;
  let harness = origin.harness;
  let model = origin.model;
  for (const layer of [...nearestFirst].reverse()) {
    const choice = layer?.roles?.[role.id];
    if (!choice) continue;
    if (choice.harness && choice.harness !== harness) {
      harness = choice.harness;
      model = choice.harness === origin.harness ? origin.model : undefined;
    }
    if (choice.model) model = choice.model;
  }
  return model;
}

export function thinkingInForce(role: InForce, ...nearestFirst: (Layer | undefined)[]): string | undefined {
  const followed = role.follows ? { id: role.follows, defaults: role.defaults } : undefined;
  const origin = followed ? { harness: harnessInForce(followed, ...nearestFirst), thinking: thinkingInForce(followed, ...nearestFirst) } : role.defaults;
  let harness = origin.harness;
  let thinking = origin.thinking;
  for (const layer of [...nearestFirst].reverse()) {
    const choice = layer?.roles?.[role.id];
    if (!choice) continue;
    if (choice.harness && choice.harness !== harness) {
      harness = choice.harness;
      thinking = choice.harness === origin.harness ? origin.thinking : undefined;
    }
    if (choice.thinking) thinking = choice.thinking;
  }
  return thinking;
}

/** The resolver does not fence models against the catalogue, so show the one in force and flag it when the agent does not list it. */
export function modelRow(model: string, models: { id: string; label: string }[]): { value: string; options: { label: string; value: string }[]; stray: boolean } {
  const known = models.map((entry) => ({ label: entry.label, value: entry.id }));
  const stray = Boolean(model) && !models.some((entry) => entry.id === model);
  return { value: model, stray, options: stray ? [...known, { label: model, value: model }] : known };
}

export function setAttention(values: Layer, choice: AttentionChoice): Layer {
  return { ...values, attention: { ...values.attention, ...choice } };
}

export function setCritic(values: Layer, by: CriticBy): Layer {
  return { ...values, critic: { ...values.critic, by } };
}

export function setCheckpoint(values: Layer, choice: NonNullable<Layer["checkpoints"]>): Layer {
  return { ...values, checkpoints: { ...values.checkpoints, ...choice } };
}

/** Three places below a dollar, since a lane costs cents and two would print most seats as $0.00. */
export const spent = (cost: number): string => (cost === 0 ? "nothing yet" : `$${cost.toFixed(cost < 1 ? 3 : 2)}`);

const since = (minutes: number): string => {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} hour${hours === 1 ? "" : "s"} ago` : `${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? "" : "s"} ago`;
};

const pct = (p: number): string => `${Math.round(p * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What the card's header says of Jev: the one line to read first, and the word at its right. */
export type JevHeader = { title: string; sub: string; word: string; tone: "success" | "warning" | "muted" };

export function jevHeader(watch: WatchView): JevHeader {
  const word = watch.telling ? "sending notices" : "recording only";
  if (!watch.keyed) return { title: "Jev is not watching", sub: "Jev, the paid watch model, needs an OpenRouter key on this machine. Until there is one, nothing is watched or recorded.", word: "", tone: "warning" };
  if (watch.failing) {
    return {
      title: "Jev is not answering",
      sub: `Its last check failed ${since(watch.failing.minutes)}: ${watch.failing.detail}. Built-in checks still run on every turn; anything waiting for Jev's second look is sent after ${watch.judgeMinutes} minutes.`,
      word: "not answering",
      tone: "warning",
    };
  }
  const tally = `${watch.read.turns.toLocaleString("en-US")} turns read · ${spent(watch.read.cost)} spent so far`;
  const running = watch.seats.filter((seat) => seat.running).length;
  if (running > 0) {
    return { title: `Jev is watching ${plural(running, "agent")}${watch.lanes > 1 ? ` in ${watch.lanes} pieces of work` : ""}`, sub: `Last check ${watch.lastRead === null ? "not yet" : since(watch.lastRead)} · ${tally}`, word, tone: "success" };
  }
  return { title: "Nothing is running", sub: watch.lastRead === null ? "Jev has not checked a turn here yet." : `Jev last checked a turn here ${since(watch.lastRead)} · ${tally}`, word, tone: "muted" };
}

/** An incident's lines as the card shows them: who and when, how it was raised, and where it has got to. */
export type IncidentLines = { sub: string; source: string; state: string; danger: boolean };

export function incidentLines(item: WatchIncident, watch: Pick<WatchView, "by" | "judgeMinutes" | "failing">): IncidentLines {
  const reader = watch.by === "seat" ? "the Watcher" : "Jev";
  const source = item.source === "watcher" ? "noticed by the Watcher" : item.source === "jev" ? (item.sure ? `Jev ${pct(item.sure.p)} sure · reports at ${pct(item.sure.bar)}` : "noticed by Jev") : "built-in check";
  let state: string;
  if (item.told === "lead") state = item.lane ? `told Lead ${item.lane}` : "told its Lead";
  else if (item.told === "supervisor") state = "told the Supervisor";
  else if (item.held === "awaiting") state = watch.failing ? `held · Jev is not answering, sent after ${watch.judgeMinutes} min` : watch.by === "seat" ? `held · waiting for the Watcher, up to ${watch.judgeMinutes} min` : `held · Jev takes a second look, up to ${watch.judgeMinutes} min`;
  else if (item.held === "vetoed") state = `held back by ${reader}`;
  else if (item.held === "budget") state = "held · today's limit is reached";
  else if (item.held === "nobody") state = "held · no agent is running to tell";
  else if (item.held === "shadow") state = "recorded · mail is off";
  else state = "recorded";
  return { sub: `${item.name} · ${since(item.minutes)}`, source, state, danger: item.told === "supervisor" && item.level === "page" };
}

/** The seats leaning towards something, closest to their bar first, and the names of the rest. */
export function leaning(seats: WatchSeat[]): { leaning: (WatchSeat & { lean: WatchLean })[]; quiet: string[] } {
  const on = seats.filter((seat): seat is WatchSeat & { lean: WatchLean } => seat.lean !== null).sort((a, b) => b.lean.p - b.lean.bar - (a.lean.p - a.lean.bar));
  return { leaning: on, quiet: seats.filter((seat) => seat.lean === null).map((seat) => seat.name) };
}

/** How right the watch has been here, from the marks: noise and useful are what is counted. */
export function trackRecord(marks: WatchView["marks"]): { title: string; percent: string | null; parts: [number, number, number]; hint: string } {
  const judged = marks.useful + marks.noise;
  const parts: [number, number, number] = [marks.useful, marks.noise, marks.unknown];
  if (judged + marks.unknown === 0) return { title: "Nothing marked yet", percent: null, parts, hint: "The Leads and the Supervisor mark each notice as useful, noise or unknown." };
  const tune = judged >= 20 ? "there are enough marks now to run node bin/calibrate.ts." : "with 20 or more marks, run node bin/calibrate.ts.";
  return {
    title: `${marks.useful} of ${judged} marked notices were useful`,
    percent: judged > 0 ? pct(marks.useful / judged) : null,
    parts,
    hint: `${marks.useful} useful · ${marks.noise} noise · ${marks.unknown} unknown, as the Leads and the Supervisor marked them. Noise is what the reporting thresholds are tuned against: ${tune}`,
  };
}

/** The Watcher seat as the Flow canvas draws it, beside the Supervisor. */
export function watcherState(watcher: WatchView["watcher"]): { state: string; alive: boolean } {
  if (!watcher) return { state: "not started · starts once work begins", alive: false };
  const waiting = watcher.queued > 0 ? ` · ${plural(watcher.queued, "check")} waiting` : "";
  return { state: `${watcher.status}${waiting}`, alive: watcher.status !== "closed" };
}

export function setFlow(values: Layer, choice: { live?: boolean; everySeconds?: number }): Layer {
  return { ...values, flow: { ...values.flow, ...choice } };
}

/** `KEPT` stands in for a set key so every whole-layer save carries it back untouched; `null` forgets it and its paid calls. */
export function setSensorKey(values: Layer, key: string | null): Layer {
  const next = { ...values };
  if (key === null) delete next.sensor;
  else next.sensor = { ...next.sensor, key };
  return next;
}

/** A pasted server has no kit template to re-enable it, so it is dropped, url and token with it, not marked removed. */
export function dropMcp(values: Layer, id: string): Layer {
  return prune(values, "mcp", id, {});
}

export function setMcp(values: Layer, id: string, choice: McpChoice): Layer {
  const current = values.mcp?.[id] ?? {};
  const settings = { ...current.settings, ...choice.settings };
  const entry: McpChoice = { ...current, ...choice };
  if (Object.keys(settings).length > 0) entry.settings = settings;
  else delete entry.settings;
  return prune(values, "mcp", id, entry);
}

/** Lanes start collapsed and the Lead's line is the only place a seat waiting on a permission shows, so counts must not hide it. */
export function countsInstead(lane: { taskCount: number; open: boolean; lead: { status: string; waiting: string[] } | null }): boolean {
  if (lane.taskCount === 0 || lane.open) return false;
  return Boolean(lane.lead) && lane.lead!.status !== "gone" && lane.lead!.waiting.length === 0;
}

/** A folder as a person reads it: the home folder as ~. */
export const shortPath = (root: string) => root.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
