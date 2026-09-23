import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type PromptPaths, renderPrompt, renderText, skillProblems, skillSources } from "./content.ts";
import { type HarnessSpec, type Kit, type McpServers, type RoleSpec, can, harnessFileSources, roleSettingsFile } from "./kit.ts";
import { gitCommonDir } from "../core/git.ts";
import { stateWrites } from "./launch.ts";
import { contentRoot, expandHome, guidesDir, home } from "../core/paths.ts";
import { configFault, formatConfig, readConfig, writeConfigAtomic } from "../core/config-file.ts";
import { sameJson } from "../core/store.ts";
import { type Team, rulesFor, skillDirsFor } from "./team.ts";
import { errorText } from "../core/errors.ts";

type Json = Record<string, unknown>;

export type SeatProject = { slug: string; state: string; root?: string };

export function seatDir(kit: Kit, role: RoleSpec, harness: HarnessSpec, homeDir = home(), project?: SeatProject): string {
  const name = `${kit.prefix}${role.role}-${harness.id}${project ? `-${project.slug}` : ""}`;
  return join(expandHome(harness.profileRoot, homeDir), name);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function ensureLink(path: string, target: string): boolean {
  if (isLink(path)) {
    if (readlinkSync(path) === target) return false;
    unlinkSync(path);
  } else if (present(path)) {
    // Likely a directory the harness made itself: deleting it loses its contents, throwing leaves the seat unbuilt.
    throw new LeftAlone(`${path} exists and is not a link, so it was left alone`);
  }
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return true;
}

const SNAPSHOT_DAYS = 14;

export function digest(sources: string[]): string {
  const hash = createHash("sha256");
  for (const [index, source] of sources.entries()) {
    if (!existsSync(source)) continue;
    const files = statSync(source).isDirectory() ? readdirSync(source, { recursive: true }).map(String).filter((file) => statSync(join(source, file)).isFile()).sort() : [""];
    for (const file of files) hash.update(`${index}/${file}\0`).update(readFileSync(join(source, file))).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/** Copied under the state root, never linked, so it resolves outside every repo: Devin loads the AGENTS.md above a file's real path. */
export function snapshot(source: string, name: string, homeDir = home()): string {
  const target = join(contentRoot(homeDir), `${name}-${digest([source])}`);
  if (!existsSync(target)) {
    const building = `${target}.${process.pid}.building`;
    rmSync(building, { recursive: true, force: true });
    cpSync(source, building, { recursive: true, dereference: true });
    try {
      renameSync(building, target);
    } catch (error) {
      rmSync(building, { recursive: true, force: true });
      if (!existsSync(target)) throw error;
    }
  }
  const now = new Date();
  utimesSync(target, now, now);
  return target;
}

/** Every seat that starts touches the copies it links, so one untouched for two weeks has no reader left. */
export function sweepSnapshots(homeDir = home(), now = Date.now()): void {
  const root = contentRoot(homeDir);
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (now - statSync(path).mtimeMs > SNAPSHOT_DAYS * 86_400_000) rmSync(path, { recursive: true, force: true });
  }
}

export function placeGuides(kit: Kit, homeDir = home()): void {
  ensureLink(guidesDir(homeDir), snapshot(join(kit.dir, "content", "guides"), "guides", homeDir));
}

export function writeReal(path: string, text: string): boolean {
  if (isLink(path)) unlinkSync(path);
  if (present(path) && readFileSync(path, "utf-8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

function isPlain(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlain(base) || !isPlain(over)) return over === undefined ? base : over;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = deepMerge(base[key], value);
  return out;
}

export function layerSettings(base: unknown, over: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(over)) return [...new Set([...base, ...over])];
  if (!isPlain(base) || !isPlain(over)) return over === undefined ? base : over;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = layerSettings(base[key], value);
  return out;
}

function getPath(value: unknown, path: string[]): unknown {
  let cursor = value;
  for (const part of path) cursor = isPlain(cursor) ? cursor[part] : undefined;
  return cursor;
}

function setPath(target: Json, path: string[], value: unknown): void {
  let cursor = target;
  for (const part of path.slice(0, -1)) {
    if (!isPlain(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Json;
  }
  const last = path[path.length - 1];
  if (last === undefined) return;
  if (value === undefined) delete cursor[last];
  else cursor[last] = value;
}

export function composeSettings(existing: Json, kitValue: Json, owned: string[]): Json {
  const merged = deepMerge(existing, kitValue) as Json;
  for (const dotted of owned) {
    const path = dotted.split(".");
    setPath(merged, path, getPath(kitValue, path));
  }
  return merged;
}

function writeConfigIfChanged(path: string, value: unknown): boolean {
  if (present(path) && !isLink(path) && sameJson(readConfig(path, null), value)) return false;
  mkdirSync(dirname(path), { recursive: true });
  if (isLink(path)) unlinkSync(path);
  writeConfigAtomic(path, formatConfig(path, value));
  return true;
}

export function seedRecords(kit: Kit, state: string): string[] {
  const templates = join(kit.dir, "content", "records");
  mkdirSync(state, { recursive: true });
  if (!existsSync(templates)) return [];
  const seeded: string[] = [];
  for (const name of readdirSync(templates)) {
    const target = join(state, name);
    if (present(target)) continue;
    writeFileSync(target, readFileSync(join(templates, name), "utf-8"));
    seeded.push(name);
  }
  return seeded;
}

function clearMcp(harness: HarnessSpec, current: Json): Json {
  const next = structuredClone(current);
  const clear = harness.mcp.clear;
  if (!clear) return next;
  for (const [path, value] of Object.entries(clear.set ?? {})) setPath(next, path.split("."), structuredClone(value));
  for (const path of clear.remove ?? []) setPath(next, path.split("."), undefined);
  for (const [path, fields] of Object.entries(clear.setInEach ?? {})) {
    const group = getPath(next, path.split("."));
    if (!isPlain(group)) continue;
    for (const [key, item] of Object.entries(group)) group[key] = { ...(isPlain(item) ? item : {}), ...structuredClone(fields) };
  }
  return next;
}

function mcpState(harness: HarnessSpec, current: Json, servers: McpServers): Json {
  const next = clearMcp(harness, current);
  const { delivery, key } = harness.mcp;
  if (delivery !== "file" || !key) return next;
  setPath(next, key.split("."), servers as Json);
  return next;
}

type Recorder = { changes: string[]; note(changed: boolean, what: string): void; removed(what: string): void };

function recorder(): Recorder {
  const changes: string[] = [];
  return {
    changes,
    note: (changed, what) => {
      if (changed) changes.push(what);
    },
    removed: (what) => changes.push(`${what} removed`),
  };
}

/** The keys a harness takes from the owner's own config: which model providers exist is theirs to say, not the kit's. */
function inherited(harness: HarnessSpec, homeDir: string): Json {
  const inherits = harness.settings.inherits;
  if (!inherits) return {};
  const own = readConfig<Json>(expandHome(inherits.from, homeDir), {});
  return Object.fromEntries(inherits.keys.filter((key) => own[key] !== undefined).map((key) => [key, own[key]]));
}

function writeRoleSettings(kit: Kit, harness: HarnessSpec, role: RoleSpec, dir: string, homeDir: string, record: Recorder, extra: Json): void {
  const { file, source, ownedPaths } = harness.settings;
  const roleFile = roleSettingsFile(kit, harness, role);
  if (!existsSync(roleFile)) throw new Error(`${role.role}: ${roleFile} is missing`);
  const kitSettings = layerSettings(readConfig<Json>(join(kit.dir, "harness", harness.id, source), {}), readConfig<Json>(roleFile, {}));
  const wanted = layerSettings(layerSettings(inherited(harness, homeDir), kitSettings), extra) as Json;
  const settingsFile = join(dir, file);
  const next = ownedPaths ? composeSettings(isLink(settingsFile) ? {} : readConfig<Json>(settingsFile, {}), wanted, ownedPaths) : wanted;
  record.note(writeConfigIfChanged(settingsFile, next), file);
}

const catalogs = new Map<string, string>();

function catalogText(command: string[]): string {
  const key = command.join("\0");
  const cached = catalogs.get(key);
  if (cached !== undefined) return cached;
  const [bin, ...args] = command;
  const text = execFileSync(bin!, args, { encoding: "utf-8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  catalogs.set(key, text);
  return text;
}

/** The catalog is the harness's own, with what it must not offer taken out; failing to build it refuses the seat. */
function writeModelCatalog(harness: HarnessSpec, dir: string, record: Recorder): Json {
  const spec = harness.modelCatalog;
  if (!spec) return {};
  const from = `\`${spec.command.join(" ")}\``;
  let catalog: unknown;
  try {
    catalog = JSON.parse(catalogText(spec.command));
  } catch (error) {
    throw new Error(`${harness.label}'s model list could not be read from ${from}: ${errorText(error)}`);
  }
  const list = getPath(catalog, spec.list.split("."));
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${from} lists no ${spec.list}, so ${harness.label}'s models could not be limited`);
  for (const entry of list) if (isPlain(entry)) for (const key of spec.clear) entry[key] = null;
  const path = join(dir, spec.file);
  record.note(writeReal(path, `${JSON.stringify(catalog)}\n`), spec.file);
  const setting: Json = {};
  setPath(setting, spec.setting.split("."), path);
  return setting;
}

function stateWritesSetting(kit: Kit, team: Team, roleName: string, project?: SeatProject): Json {
  const { role, harness } = team.roles[roleName]!;
  if (harness.stateWrites?.delivery !== "file" || !project) return {};
  const setting: Json = {};
  // A role that commits needs the repository's own git directory: a lane's working copy keeps its index and refs there.
  const git = (can(role, "work") || can(role, "write")) && project.root ? gitCommonDir(project.root) : undefined;
  setPath(setting, harness.stateWrites.path.split("."), [...stateWrites(kit, team, role, project.state), ...(git ? [git] : [])]);
  return setting;
}

function writeFiles(kit: Kit, harness: HarnessSpec, role: RoleSpec, dir: string, record: Recorder): void {
  for (const [path, sources] of Object.entries(harnessFileSources(kit, harness, role))) {
    const text = sources.map((source) => readFileSync(source, "utf-8").trimEnd()).join("\n\n");
    record.note(writeReal(join(dir, path), `${text}\n`), path);
  }
}

export class LeftAlone extends Error {}

function linkShared(harness: HarnessSpec, dir: string, homeDir: string, record: Recorder): void {
  for (const link of harness.links ?? []) {
    const target = expandHome(link.target, homeDir);
    const path = join(dir, link.link);
    if (existsSync(target)) {
      try {
        record.note(ensureLink(path, target), link.link);
      } catch (error) {
        if (!(error instanceof LeftAlone)) throw error;
        console.error(`seatworks-v2: ${error.message}`);
      }
    }
    else if (link.optional && isLink(path)) {
      unlinkSync(path);
      record.removed(link.link);
    }
  }
}

function writeMcpFile(harness: HarnessSpec, dir: string, servers: McpServers, record: Recorder): void {
  const file = join(dir, harness.mcp.file);
  const fault = configFault(file);
  // A launch-delivery harness keeps its own account data in this file; a file-delivery one holds only the seat's two tools here.
  if (fault && harness.mcp.delivery !== "file") {
    console.error(`seatworks-v2: ${fault}, so its MCP servers were left alone`);
    return;
  }
  if (fault) console.error(`seatworks-v2: ${fault}, and the plugin owns that file, so it was written again`);
  const current = fault ? structuredClone(harness.mcp.seed ?? {}) : readConfig<Json>(file, structuredClone(harness.mcp.seed ?? {}));
  record.note(writeConfigIfChanged(file, mcpState(harness, current, servers)), harness.mcp.file);
}

function removeIfPresent(path: string, what: string, record: Recorder): void {
  if (!present(path)) return;
  unlinkSync(path);
  record.removed(what);
}

function writeInstructions(kit: Kit, team: Team, roleName: string, dir: string, paths: PromptPaths, record: Recorder): void {
  const { role, harness } = team.roles[roleName]!;
  const rules = renderText(role, rulesFor(team, roleName), paths);
  if (harness.systemPrompt === "file" && harness.promptFile) {
    const promptPath = join(dir, harness.promptFile);
    const prompt = renderPrompt(kit, role, paths);
    record.note(writeReal(promptPath, rules ? `${prompt.trimEnd()}\n\n${rules}` : prompt), harness.promptFile);
    return;
  }
  if (!harness.contextFile) return;
  const contextPath = join(dir, harness.contextFile);
  if (rules) record.note(writeReal(contextPath, rules), harness.contextFile);
  else removeIfPresent(contextPath, harness.contextFile, record);
}

function linkSkills(kit: Kit, team: Team, roleName: string, dir: string, homeDir: string, record: Recorder): void {
  const { role, harness } = team.roles[roleName]!;
  const skillsDir = join(dir, harness.skillsDir);
  mkdirSync(skillsDir, { recursive: true });
  const wanted = skillSources(kit, role, skillDirsFor(team, roleName));
  for (const [name, source] of wanted) {
    const problems = skillProblems(role, name, source);
    if (problems.length > 0) throw new Error(problems.join("; "));
    try {
      record.note(ensureLink(join(skillsDir, name), snapshot(source, name, homeDir)), `skill ${name}`);
    } catch (error) {
      // Thrown, the launch hook refused the seat for ever, since nothing removes that directory.
      if (!(error instanceof LeftAlone)) throw error;
      console.error(`seatworks-v2: skill ${name} for the ${role.role}: ${error.message}`);
    }
  }
  for (const name of readdirSync(skillsDir)) {
    const path = join(skillsDir, name);
    if (!wanted.has(name) && isLink(path)) {
      unlinkSync(path);
      record.removed(`skill ${name}`);
    }
  }
}

/** Checked before anything is written: refusing mid-build left a seat booting with config and MCP but no instructions. */
export function seatProblems(kit: Kit, team: Team, roleName: string, paths: PromptPaths): string[] {
  const seat = team.roles[roleName];
  if (!seat) return [`the team has no ${roleName} seat`];
  const problems: string[] = [];
  const say = (error: unknown) => problems.push(errorText(error));
  try {
    renderText(seat.role, rulesFor(team, roleName), paths);
    if (seat.harness.systemPrompt === "file" && seat.harness.promptFile) renderPrompt(kit, seat.role, paths);
  } catch (error) {
    say(error);
  }
  for (const [name, source] of skillSources(kit, seat.role, skillDirsFor(team, roleName))) {
    problems.push(...skillProblems(seat.role, name, source));
  }
  for (const [path, sources] of Object.entries(harnessFileSources(kit, seat.harness, seat.role))) {
    for (const source of sources) if (!existsSync(source)) problems.push(`${seat.harness.label} lays down ${path} from ${source}, which is missing`);
  }
  return problems;
}

export function materialize(kit: Kit, team: Team, roleName: string, homeDir = home(), project?: SeatProject, servers: McpServers = {}): string[] {
  const seat = team.roles[roleName];
  if (!seat) throw new Error(`the team has no ${roleName} seat`);
  const dir = seatDir(kit, seat.role, seat.harness, homeDir, project);
  const paths = { guides: guidesDir(homeDir), state: project?.state ?? "$SEATWORKS_STATE" };
  const problems = seatProblems(kit, team, roleName, paths);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const record = recorder();
  mkdirSync(dir, { recursive: true });
  const extra = layerSettings(writeModelCatalog(seat.harness, dir, record), stateWritesSetting(kit, team, roleName, project)) as Json;
  writeRoleSettings(kit, seat.harness, seat.role, dir, homeDir, record, extra);
  writeFiles(kit, seat.harness, seat.role, dir, record);
  linkShared(seat.harness, dir, homeDir, record);
  writeMcpFile(seat.harness, dir, servers, record);
  writeInstructions(kit, team, roleName, dir, paths, record);
  linkSkills(kit, team, roleName, dir, homeDir, record);
  return record.changes;
}
