import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Kit, can, providerId, reloadTeam, rolesThatCan, seatOf, supportsRole } from "../catalog/kit.ts";
import { type Connect, type Layer, MachineLayerSchema, ProjectLayerSchema, type SettingsView, type WriteResult, layerValues, readLayer, withKey, withoutKey, writeLayer } from "../catalog/settings.ts";
import { type Team, resolveTeam, rulesFor, skillDirsFor, templateRoles, transportOf } from "../catalog/team.ts";
import { gitCommonDir } from "../core/git.ts";
import type { SeatView, Seats } from "../core/ports.ts";
import { seatProblems } from "../catalog/seats.ts";
import { expandHome, guidesDir, home, stateRoot, worktreeRoot } from "../core/paths.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { digestOf } from "../desk/checkpoints.ts";
import { flowView } from "../desk/flow.ts";
import type { CleanView, MigrateView, UpdateView, WatchView } from "../../shared/views.ts";
import { removeGarbage, scanGarbage } from "../upkeep/clean.ts";
import { type LiveSeat, migrate, migrationPlan } from "../upkeep/migrate.ts";
import { applyUpdate, checkUpdate, npmInstall, reloadSoon } from "../upkeep/update.ts";
import { contentChanges, decide } from "../upkeep/content.ts";
import type { StateReport } from "../upkeep/state.ts";
import { loadLedger, readLedger } from "../desk/ledger.ts";
import { type Project, gitRoot, loadConfig, projectOf } from "../desk/project.ts";
import { statusText } from "../desk/status.ts";
import { type Check, doctor, gitIdentityCheck } from "./doctor.ts";
import type { Control } from "./rpc.ts";
import type { Seating } from "./seating.ts";
import type { TeamSource } from "./team-source.ts";
import { seatPairs, labelFor } from "../catalog/providers.ts";
import { errorText } from "../core/errors.ts";

type Target = { file: string; schema: typeof MachineLayerSchema | typeof ProjectLayerSchema; project?: Project };

/** The folders in `dir`, leaving out hidden ones and macOS's Library. */
function foldersIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "Library").map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/** Folders named like `typed` where people keep projects: the home folder, each folder in it, and the folders holding projects Seatworks has seen. Git repositories first, then names that start with it. */
function named(typed: string): string[] {
  const want = typed.toLowerCase();
  const places = new Set([homedir(), ...foldersIn(homedir())]);
  for (const state of foldersIn(join(stateRoot(), "projects"))) {
    try {
      const root = (JSON.parse(readFileSync(join(state, "meta.json"), "utf-8")) as { root?: unknown }).root;
      if (typeof root === "string") places.add(dirname(root));
    } catch {}
  }
  const hits = [...places].flatMap(foldersIn).filter((path, i, all) => all.indexOf(path) === i && basename(path).toLowerCase().includes(want));
  const rank = (path: string) => (existsSync(join(path, ".git")) ? 0 : 2) + (basename(path).toLowerCase().startsWith(want) ? 0 : 1);
  return hits.sort((a, b) => rank(a) - rank(b) || basename(a).length - basename(b).length).slice(0, 20);
}

const unknownProject = (slug: string) => `No project named ${slug} has been seen on this machine.`;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Pasted snippets write ports and flags as numbers; a value with no text form is named back, not dropped. */
const scalar = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;

/** The words, or — as a string — the one that is not a word. */
const words = (value: unknown): string[] | string | undefined => {
  if (value === undefined || value === null) return undefined;
  const out: string[] = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    const text = scalar(item);
    if (text === undefined) return JSON.stringify(item);
    out.push(text);
  }
  return out;
};

/** The names and their values, or — as a string — the name whose value has no text form. */
const table = (value: unknown): Record<string, string> | string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return JSON.stringify(value);
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    const text = scalar(item);
    if (text === undefined) return name;
    out[name] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

function connectFrom(value: unknown): Connect | string {
  if (!isRecord(value)) return "A server needs a JSON object with its connection details.";
  const raw = typeof value.type === "string" ? value.type.toLowerCase() : "";
  const run = words(value.command);
  if (typeof run === "string") return `The server's command has ${run} in it, which is not text.`;
  const rest = words(value.args);
  if (typeof rest === "string") return `The server's args have ${rest} in them, which is not text.`;
  const command = [...(run ?? []), ...(rest ?? [])];
  const url = typeof value.url === "string" ? value.url : undefined;
  const type = raw === "local" || raw === "stdio" ? "stdio" : raw === "sse" ? "sse" : raw === "remote" || raw === "http" ? "http" : command.length > 0 ? "stdio" : url ? "http" : undefined;
  if (!type) return "Give the server a command to run or a url to reach.";
  if (type === "stdio") {
    if (command.length === 0) return "A local server needs a command to run.";
    const env = table(value.env);
    if (typeof env === "string") return `The server's env gives ${env} a value that is not text.`;
    return { type, command, ...(env ? { env } : {}) };
  }
  if (!url) return "A remote server needs a url.";
  const headers = table(value.headers);
  if (typeof headers === "string") return `The server's headers give ${headers} a value that is not text.`;
  return { type, url, ...(headers ? { headers } : {}) };
}

export function describeCatalog(kit: Kit): unknown {
  return {
    profiles: seatPairs(kit).map(({ role, harness }) => ({ id: providerId(kit, role.role, harness.id), role: role.role, harness: harness.id, label: labelFor(kit, role, harness) })),
    roles: kit.roles.map((role) => ({
      id: role.role,
      label: role.label,
      description: role.description ?? "",
      can: role.can ?? [],
      concern: role.concern ?? null,
      defaults: role.defaults,
      follows: role.follows ?? null,
      harnesses: Object.values(kit.harnesses)
        .filter((harness) => supportsRole(kit, harness, role))
        .map((harness) => harness.id),
    })),
    harnesses: Object.values(kit.harnesses).map((harness) => ({
      id: harness.id,
      label: harness.label,
      models: harness.models ?? [],
      thinking: harness.hasThinking !== false,
      transports: harness.mcp.transports,
    })),
    mcp: Object.values(kit.mcp)
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.description ?? "",
        kind: entry.kind,
        transport: entry.kind === "proxy" ? "stdio" : (entry.server?.type ?? "stdio"),
        settings: entry.settings,
        defaults: entry.defaults,
        roles: templateRoles(entry),
        template: true,
      })),
    sensor: Object.values(kit.sensors)[0] ? { model: Object.values(kit.sensors)[0]!.model } : null,
  };
}

export function describeTeam(kit: Kit, team: Team, project?: Project): unknown {
  return {
    project: project?.slug ?? null,
    errors: team.errors,
    attention: team.attention,
    checkpoints: { ...team.checkpoints, forced: team.checkpoints.forced ?? null },
    critic: team.critic,
    // A project's own log, read where its mode is chosen; the machine's defaults have none.
    digest: project
      ? Object.fromEntries(
          (["plan", "land"] as const).map((checkpoint) => {
            const { lines, state } = digestOf(project, checkpoint, team.checkpoints.forced ? "on" : team.checkpoints[checkpoint]);
            return [checkpoint, { lines, state: state ?? null }];
          }),
        )
      : null,
    rules: team.rules,
    mcp: Object.fromEntries(
      Object.entries(team.mcp).map(([id, state]) => [
        id,
        {
          label: state.label,
          enabled: state.enabled,
          roles: state.roles,
          settings: state.settings,
          transport: transportOf(state),
          template: Boolean(state.entry),
          connect: state.connect ?? null,
          rule: state.rule ?? null,
        },
      ]),
    ),
    roles: Object.fromEntries(
      Object.entries(team.roles).map(([name, seat]) => [
        name,
        {
          harness: seat.harness.id,
          provider: providerId(kit, name, seat.harness.id),
          model: seat.model?.id ?? null,
          thinking: seat.thinking ?? null,
          mcp: seat.mcp,
          tools: Object.fromEntries(seat.mcp.map((id) => [id, (team.mcp[id]!.tools ?? team.mcp[id]!.entry?.tools)?.[name] ?? []])),
          skills: [...skillDirsFor(team, name).keys()],
          rules: rulesFor(team, name),
        },
      ]),
    ),
  };
}

export type ControlDeps = {
  kit: Kit;
  source: TeamSource;
  seating: Seating;
  reconcile: (team: Team) => void;
  models: () => Promise<Record<string, { at: string; error: string | null; models: unknown[] }>>;
  state: () => StateReport;
  seats: Seats;
  held: () => { to: string; text: string; at: number }[];
  watch: (project: Project, seats: Iterable<SeatView>) => WatchView;
  folders: (query: string) => Promise<string[]>;
  /** Takes a detached project out of the Supervisor's scope too, so no agent keeps rights to it. */
  unbind?: (root: string) => void;
  decidePlan: (project: Project, lane: string, approve: boolean, note: string) => Promise<{ ok: boolean; text: string }>;
  decideLand: (project: Project, lane: string, approve: boolean, note: string) => Promise<{ ok: boolean; text: string }>;
  approveReady: (project: Project, lane: string) => Promise<{ ok: boolean; text: string }>;
};

export class SettingsControl implements Control {
  private readonly deps: ControlDeps;

  constructor(deps: ControlDeps) {
    this.deps = deps;
  }

  catalog(): unknown {
    return describeCatalog(this.deps.kit);
  }

  readSettings(slug?: string): SettingsView {
    const machine = withoutKey(slug ? this.deps.source.machineLayer() : {});
    const target = this.target(slug);
    if (typeof target === "string") return { status: "invalid", revision: "", error: target, machine };
    const read = readLayer(target.file, target.schema);
    return { ...(read.status === "ready" ? { ...read, values: withoutKey(read.values) } : read), machine };
  }

  writeSettings(slug: string | undefined, revision: string, values: unknown): WriteResult {
    const { kit, source, seating, reconcile } = this.deps;
    const target = this.target(slug);
    if (typeof target === "string") return { status: "invalid", error: target };
    const resolve = (layer: Layer) => (target.project ? resolveTeam(kit, source.machineLayer(), layer) : resolveTeam(kit, layer));
    const paths = { guides: guidesDir(), state: target.project?.state ?? "$SEATWORKS_STATE" };
    const unbuildable = (team: Team) => Object.keys(team.roles).flatMap((role) => seatProblems(kit, team, role, paths));
    const check = (layer: Layer) => {
      const team = resolve(layer);
      if (team.errors.length > 0) return team.errors;
      // Only what this save introduces is refused: a bad rule refuses a seat's whole build, long after the save.
      const already = new Set(unbuildable(resolve(layerValues(target.file, target.schema))));
      return unbuildable(team).filter((problem) => !already.has(problem));
    };
    const result = writeLayer(target.file, target.schema, revision, withKey(values, layerValues(target.file, target.schema)), check);
    if (result.status === "saved") {
      seating.forget();
      if (!target.project) reconcile(source.teamFor());
      return { ...result, values: withoutKey(result.values) };
    }
    return result;
  }

  projects(): unknown {
    return this.deps.source.known().map((project) => ({ slug: project.slug, root: project.root }));
  }

  addProject(root: string): unknown {
    const path = root.trim();
    if (!path || !existsSync(path) || !statSync(path).isDirectory()) return { error: `${path || "That path"} is not a directory on this machine.` };
    const project = projectOf(path);
    this.deps.source.record(project);
    // record() only logs failures; an attach whose slug cannot be found leaves every screen for it dead.
    if (!this.deps.source.named(project.slug)) return { error: `${project.root} could not be put on record; see the daemon log.` };
    return { slug: project.slug, root: project.root };
  }

  candidateProjects(roots: string[]): unknown {
    const attached = new Set(this.deps.source.known().map((project) => project.root));
    const worktrees = worktreeRoot();
    const keep: string[] = [];
    for (const given of roots) {
      const path = given.trim();
      if (!path || path === worktrees || path.startsWith(`${worktrees}/`)) continue;
      let real: string;
      try {
        if (!statSync(path).isDirectory()) continue;
        real = realpathSync(path);
      } catch {
        continue;
      }
      if (!gitCommonDir(real)) continue;
      const project = projectOf(real);
      if (project.root !== real || attached.has(project.root)) continue;
      keep.push(given);
    }
    return keep;
  }

  parseMcp(text: string): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { error: `That is not JSON: ${errorText(error)}` };
    }
    if (!isRecord(parsed)) return { error: "Paste a JSON object, not a list or a bare value." };
    const map = isRecord(parsed.mcp) ? parsed.mcp : isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
    if (map) {
      const names = Object.keys(map);
      if (names.length !== 1) return { error: `Paste one server at a time; this one names ${names.length}.` };
      const id = names[0]!;
      const connect = connectFrom(map[id]);
      return typeof connect === "string" ? { error: connect } : { id, label: id, connect };
    }
    const direct = connectFrom(parsed);
    if (typeof direct === "string") {
      const names = Object.keys(parsed);
      if (names.length === 1 && isRecord(parsed[names[0]!])) {
        const id = names[0]!;
        const nested = connectFrom(parsed[id]);
        return typeof nested === "string" ? { error: nested } : { id, label: id, connect: nested };
      }
      return { error: direct };
    }
    return { id: "", label: "", connect: direct };
  }

  async removeProject(slug: string): Promise<unknown> {
    const project = this.deps.source.named(slug);
    if (!project) return { error: unknownProject(slug) };
    // A seat still working in the project records it again on the next round, so detaching it first would not hold.
    let live: string[];
    try {
      live = (await this.deps.seats.open()).filter((seat) => !seat.archivedAt && seatOf(this.deps.kit, seat.provider)?.role.tools && projectOf(seat.cwd).slug === slug).map((seat) => seat.id);
    } catch (error) {
      return { error: `Paseo did not say which seats are working in ${slug} (${errorText(error)}), so its settings stay.` };
    }
    if (live.length > 0) return { error: `${slug} stays: ${live.length} seat${live.length === 1 ? " is" : "s are"} still working in it (${live.join(", ")}): archive ${live.length === 1 ? "it" : "them"} first, since a working seat puts the project back on record.` };
    // Live work only: lanes and tasks are never removed, so counting them made Detach impossible after the first lane.
    const ledger = loadLedger(project.state);
    const open = Object.values(ledger.lanes).filter((lane) => lane.status !== "closed").length;
    // A closed lane still restoring the owner's copy is live: detached, the repo stays on its branch for good.
    const restoring = Object.values(ledger.lanes).filter((lane) => lane.restoring).length;
    // A free slot row left by a failed checkout is the desk's pool, not a copy anyone holds.
    const copies = Object.values(ledger.slots).filter((slot) => slot.lane || slot.task || slot.releasing).length;
    if (open > 0 || copies > 0 || restoring > 0) {
      const held = [
        open > 0 ? `${open} unfinished piece${open === 1 ? "" : "s"} of work` : "",
        // restore.held in events.log says why: a seat still writing there, or changes that stop the switch.
        restoring > 0 ? "a folder the team is still putting back on its main branch" : "",
        copies > 0 ? `${copies} team cop${copies === 1 ? "y" : "ies"} of the project still in use` : "",
      ].filter(Boolean);
      return { error: `${slug} still has ${held.join(" and ")}, so it can't be detached yet.${open > 0 ? " Finish or close that work first, then try again." : " Try again in a moment."}` };
    }
    for (const name of ["settings.json", "meta.json"]) rmSync(join(project.state, name), { force: true });
    try {
      if (readdirSync(project.state).length === 0) rmSync(project.state, { recursive: true, force: true });
    } catch {}
    this.deps.source.forget(slug);
    this.deps.seating.forget();
    this.deps.unbind?.(project.root);
    return { removed: slug };
  }

  team(slug?: string): unknown {
    const project = slug ? this.deps.source.named(slug) : undefined;
    if (slug && !project) return { errors: [unknownProject(slug)] };
    return describeTeam(this.deps.kit, this.deps.source.teamFor(project), project);
  }

  async doctor(slug?: string): Promise<Check[]> {
    const project = slug ? this.deps.source.named(slug) : undefined;
    if (slug && !project) return [{ id: "project", ok: false, detail: unknownProject(slug) }];
    const checks = await doctor(this.deps.kit, this.deps.source.teamFor(project));
    if (project) checks.push(gitIdentityCheck(project.root));
    return checks;
  }

  /** The name and email this project's commits are signed with, set in the project alone. */
  setGitIdentity(slug: string, name: string, email: string): Check {
    const project = this.deps.source.named(slug);
    if (!project) return { id: "git:identity", ok: false, detail: unknownProject(slug) };
    try {
      execFileSync("git", ["-C", project.root, "config", "user.name", name.trim()], { stdio: "ignore", timeout: 5000 });
      execFileSync("git", ["-C", project.root, "config", "user.email", email.trim()], { stdio: "ignore", timeout: 5000 });
    } catch (error) {
      return { id: "git:identity", ok: false, detail: `Git could not save your name and email: ${errorText(error)}` };
    }
    return gitIdentityCheck(project.root);
  }

  async status(slug: string): Promise<unknown> {
    const project = this.deps.source.named(slug);
    if (!project) return { text: "", error: unknownProject(slug) };
    const seats = new Map((await this.deps.seats.open()).map((seat) => [seat.id, seat]));
    // Built with these two, or the owner's copy could never show a seat waiting on them or unclaimed mail.
    const waiting = [...seats.values()].filter(
      (seat) => can(seatOf(this.deps.kit, seat.provider)?.role, "supervise") && projectOf(seat.cwd).slug === project.slug && (seat.pendingPermissions?.length ?? 0) > 0,
    );
    return { text: statusText(project, loadLedger(project.state), loadConfig(project.state), seats, Date.now(), { waiting, held: this.deps.held(), checks: this.deps.source.teamFor(project).checkpoints }) };
  }

  /** The Human's own word on a held plan: the panel is the one place it comes from, since no seat may give it for them. */
  async decidePlan(slug: string, lane: string, approve: boolean, note: string): Promise<unknown> {
    const project = this.deps.source.named(slug);
    if (!project) return { error: unknownProject(slug) };
    const decided = await this.deps.decidePlan(project, lane, approve, note.trim());
    return decided.ok ? { decided: decided.text } : { error: decided.text };
  }

  /** The Human's own word on a held landing, from the panel like a plan's: landing is already the Supervisor's call. */
  async decideLand(slug: string, lane: string, approve: boolean, note: string): Promise<unknown> {
    const project = this.deps.source.named(slug);
    if (!project) return { error: unknownProject(slug) };
    const decided = await this.deps.decideLand(project, lane, approve, note.trim());
    return decided.ok ? { decided: decided.text } : { error: decided.text };
  }

  /** The Human's Merge on a ready card, recorded as their approval before the Supervisor lands it. */
  async approveReady(slug: string, lane: string): Promise<unknown> {
    const project = this.deps.source.named(slug);
    if (!project) return { error: unknownProject(slug) };
    const approved = await this.deps.approveReady(project, lane);
    return approved.ok ? { decided: approved.text } : { error: approved.text };
  }

  async flow(slug: string, since?: string, open?: string[]): Promise<unknown> {
    const project = this.deps.source.named(slug);
    if (!project) return { error: unknownProject(slug) };
    const seats = new Map((await this.deps.seats.open()).map((seat) => [seat.id, seat]));
    const supervises = new Set(rolesThatCan(this.deps.kit, "supervise").map((role) => role.role));
    const seated = [...seats.values()]
      .map((seat) => ({ seat, role: seatOf(this.deps.kit, seat.provider)?.role }))
      .filter(({ seat, role }) => can(role, "supervise") && Boolean(seat.cwd) && projectOf(seat.cwd).slug === project.slug)
      .sort((a, b) => Date.parse(b.seat.updatedAt) - Date.parse(a.seat.updatedAt))
      .map(({ seat, role }) => ({ id: seat.id, role: role!.role }));
    const view = flowView(project, readLedger(project.state), seats, Date.now(), new Set(open ?? []), supervises, seated);
    // Live state, but part of the revision, or the card freezes whenever the ledger does not change.
    const watch = this.deps.watch(project, seats.values());
    const revision = createHash("sha1").update(`${view.revision}${JSON.stringify(watch)}`).digest("hex").slice(0, 16);
    return since && since === revision ? { unchanged: true, revision } : { ...view, watch, revision };
  }

  /** Paseo's own fuzzy search, with a typed path put first so pasting one still works: "~/a/b", "/a/b", or "a/b" read from the home folder, and a last part still being typed completes from its folder. */
  async findPaths(query: string): Promise<unknown> {
    const typed = query.trim();
    const found: string[] = [];
    const asked = /^[~/]/.test(typed) ? expandHome(typed) : typed.includes("/") ? join(homedir(), typed) : null;
    if (asked) {
      try {
        const here = realpathSync(asked);
        if (statSync(here).isDirectory()) found.push(here);
      } catch {
        try {
          const parent = realpathSync(dirname(asked)), start = basename(asked).toLowerCase();
          for (const entry of readdirSync(parent, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name.toLowerCase().startsWith(start)) found.push(join(parent, entry.name));
            if (found.length >= 10) break;
          }
        } catch {}
      }
    }
    try {
      const searched = await this.deps.folders(typed);
      // Paseo's search knows only folders it has seen; a bare name it has not seen is looked for where projects usually live.
      for (const path of searched.length || typed.length < 2 || /[~/]/.test(typed) ? searched : named(typed)) if (!found.includes(path)) found.push(path);
    } catch (error) {
      if (found.length === 0) return { error: `Paseo's folder search did not answer: ${errorText(error)}` };
    }
    const homeDir = homedir();
    return {
      folders: found.slice(0, 30).map((path) => ({
        path,
        label: path === homeDir ? "~" : path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path,
        repository: existsSync(join(path, ".git")),
      })),
    };
  }

  listPaths(path?: string): unknown {
    const asked = path && path.trim() ? expandHome(path.trim()) : homedir();
    let here: string;
    try {
      here = realpathSync(asked);
      if (!statSync(here).isDirectory()) return { error: `${asked} is not a directory on this machine.` };
    } catch {
      return { error: `${asked} is not a directory on this machine.` };
    }
    const parent = dirname(here);
    let children: string[];
    try {
      // Listable is not readable; the screen handles a refusal but not a rejected promise.
      children = readdirSync(here, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => join(here, entry.name));
    } catch {
      return { error: `${asked} is on this machine but could not be read.` };
    }
    // One stat per child, not a git process: hundreds of spawns block the loop serving the seats' tool calls.
    const looksLikeRepo = (child: string) => existsSync(join(child, ".git"));
    const folders = children
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 300)
      .map((child) => ({ name: child.slice(here.length + 1), path: child, repository: looksLikeRepo(child) }));
    // True in subdirectories too; the root is named so browsing `/repo/src` shows `/repo` is already a project.
    const root = gitRoot(here);
    return { path: here, parent: parent === here ? null : parent, repository: Boolean(gitCommonDir(here)), root: root === here ? null : root, folders };
  }

  async refreshModels(): Promise<unknown> {
    const cache = await this.deps.models();
    return Object.fromEntries(Object.entries(cache).map(([id, entry]) => [id, { at: entry.at, error: entry.error, count: entry.models.length }]));
  }

  async clean(remove?: string[]): Promise<CleanView> {
    const { kit, source } = this.deps;
    const ctx = { kit, home: home(), known: source.known(), teamFor: (project: Project) => source.teamFor(project), live: await this.live() };
    if (!remove) return { items: await scanGarbage(ctx), removed: [], failed: [] };
    const cleaned = await removeGarbage(ctx, remove);
    for (const project of ctx.known) if (!source.named(project.slug)) source.forget(project.slug);
    return cleaned;
  }

  async update(apply: boolean, fetch = true): Promise<UpdateView> {
    const counts = new Map<string, number>();
    for (const seat of await this.live()) counts.set(seat.slug, (counts.get(seat.slug) ?? 0) + 1);
    const busy = [...counts].map(([slug, count]) => `${slug}: ${count} agent${count === 1 ? "" : "s"}`);
    const ctx = { dir: this.deps.kit.dir, managedRoot: join(home(), ".paseo", "plugins"), busy, install: npmInstall, reload: reloadSoon };
    return apply ? applyUpdate(ctx) : checkUpdate(ctx, fetch);
  }

  async migrate(apply: boolean): Promise<MigrateView> {
    const { kit, source } = this.deps;
    const known = source.known();
    const ctx = {
      kit,
      home: home(),
      known,
      settings: [
        { where: "machine", file: source.machineFile(), schema: MachineLayerSchema },
        ...known.map((project) => ({ where: project.slug, file: source.projectFile(project), schema: ProjectLayerSchema })),
      ],
      live: await this.live(),
      now: Date.now(),
    };
    const content = await contentChanges(kit, stateRoot());
    const state = this.deps.state();
    if (!apply) return { ...migrationPlan(ctx), content, state };
    const done = migrate(ctx);
    this.deps.reconcile(source.teamFor());
    return { ...done, content, state };
  }

  async decide(unit: string, choice: "new" | "mine" | "seen"): Promise<MigrateView> {
    await decide(this.deps.kit, stateRoot(), unit, choice);
    // The team block is read once a load, and a seat's skills when it is built: both follow the answer now.
    reloadTeam(this.deps.kit);
    this.deps.seating.forget();
    return this.migrate(false);
  }

  private async live(): Promise<LiveSeat[]> {
    const seats = await this.deps.seats.open();
    return seats.flatMap((seat) => {
      const found = seatOf(this.deps.kit, seat.provider);
      if (!found) return [];
      const name = [found.role.label, found.harness.label, seat.title].filter(Boolean).join(" · ");
      return [{ provider: seat.provider.split("/")[0]!, slug: projectOf(seat.cwd).slug, createdAt: seat.createdAt, name }];
    });
  }

  private target(slug?: string): Target | string {
    if (!slug) return { file: this.deps.source.machineFile(), schema: MachineLayerSchema };
    const project = this.deps.source.named(slug);
    if (!project) return unknownProject(slug);
    return { file: this.deps.source.projectFile(project), schema: ProjectLayerSchema, project };
  }
}
