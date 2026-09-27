import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configFault, formatConfig, readConfig, readConfigStrict, writeConfigAtomic } from "../../core/config-file.ts";
import { errorText } from "../../core/errors.ts";
import { gitCommonDir } from "../../core/git.ts";
import { LeftAlone, ensureLink, isLink, present, writeIfChanged } from "../../core/fs.ts";
import { type Json, getPath, isRecord, layered, sameJson, setPath } from "../../core/json.ts";
import { daemonLog } from "../../core/logger.ts";
import { expandHome } from "../../core/paths.ts";
import { projectBlock, skillProblems, skillSources } from "../kit/content.ts";
import type { HarnessSpec, Kit, McpServers, RoleSpec } from "../kit/kit.ts";
import { harnessFileSources, roleSettingsFile } from "../kit/harness-files.ts";
import { can } from "../kit/roles.ts";
import { projectImports, stateWrites } from "./launch.ts";
import { refusalLines, refusalSettings } from "./refusals.ts";
import { snapshot } from "./snapshots.ts";
import { type Team, skillDirsFor } from "../team/team.ts";

type Recorder = { changes: string[]; note(changed: boolean, what: string): void; removed(what: string): void };

export function recorder(): Recorder {
  const changes: string[] = [];
  return {
    changes,
    note: (changed, what) => {
      if (changed) changes.push(what);
    },
    removed: (what) => changes.push(`${what} removed`),
  };
}

function writeConfigIfChanged(path: string, value: unknown): boolean {
  if (present(path) && !isLink(path) && sameJson(readConfig(path, null), value)) return false;
  mkdirSync(dirname(path), { recursive: true });
  if (isLink(path)) unlinkSync(path);
  writeConfigAtomic(path, formatConfig(path, value));
  return true;
}

function removeIfPresent(path: string, what: string, record: Recorder): void {
  if (!present(path)) return;
  unlinkSync(path);
  record.removed(what);
}

/** Copies the project's record templates into its state, once: an owner's own text there is never overwritten. */
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

/** The keys a harness takes from the owner's own config: which model providers exist is theirs to say, not the kit's. */
function inherited(harness: HarnessSpec, homeDir: string): Json {
  const inherits = harness.settings.inherits;
  if (!inherits) return {};
  const path = expandHome(inherits.from, homeDir);
  const fault = configFault(path);
  if (fault) daemonLog.error(`${fault}, so ${harness.label} seats take none of its ${inherits.keys.join(", ")}`);
  const own = readConfig<Json>(path, {});
  return Object.fromEntries(inherits.keys.filter((key) => own[key] !== undefined).map((key) => [key, own[key]]));
}

export function writeRoleSettings(
  kit: Kit,
  harness: HarnessSpec,
  role: RoleSpec,
  seat: { dir: string; homeDir: string; state?: string; root?: string },
  record: Recorder,
  catalog: Json,
): void {
  const { file, source } = harness.settings;
  const roleFile = roleSettingsFile(kit, harness, role);
  if (!existsSync(roleFile)) throw new Error(`${role.role}: ${roleFile} is missing`);
  // Read strictly: a role's settings stood in as empty would seat it without its sandbox and its denials.
  const kitSettings = layered(
    readConfigStrict<Json>(join(kit.dir, "harness", harness.id, source)),
    readConfigStrict<Json>(roleFile),
  ) as Json;
  const extra = layered(
    layered(catalog, stateWritesSetting(harness, role, seat.state, kitSettings, seat.root)),
    refusalSettings(kit, harness, role, seat.homeDir),
  ) as Json;
  const wanted = layered(layered(inherited(harness, seat.homeDir), kitSettings), extra) as Json;
  record.note(writeConfigIfChanged(join(seat.dir, file), wanted), file);
}

const catalogs = new Map<string, string>();

function catalogText(command: string[]): string {
  const key = command.join("\0");
  const cached = catalogs.get(key);
  if (cached !== undefined) return cached;
  const [bin, ...args] = command;
  const text = execFileSync(bin!, args, {
    encoding: "utf-8",
    timeout: 20_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  catalogs.set(key, text);
  return text;
}

/** The catalog is the harness's own, with what it must not offer taken out; failing to build it refuses the seat. */
export function writeModelCatalog(harness: HarnessSpec, dir: string, record: Recorder): Json {
  const spec = harness.modelCatalog;
  if (!spec) return {};
  const from = `\`${spec.command.join(" ")}\``;
  let catalog: unknown;
  try {
    catalog = JSON.parse(catalogText(spec.command));
  } catch (error) {
    throw new Error(`${harness.label}'s model list could not be read from ${from}: ${errorText(error)}`, {
      cause: error,
    });
  }
  const list = getPath(catalog, spec.list.split("."));
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(`${from} lists no ${spec.list}, so ${harness.label}'s models could not be limited`);
  for (const entry of list) if (isRecord(entry)) for (const key of spec.clear) entry[key] = null;
  const path = join(dir, spec.file);
  record.note(writeIfChanged(path, `${JSON.stringify(catalog)}\n`), spec.file);
  const setting: Json = {};
  setPath(setting, spec.setting.split("."), path);
  return setting;
}

/** What the role writes under the project's state, as roots and, where its settings name a permission profile, as grants there, which reads no roots. */
function stateWritesSetting(
  harness: HarnessSpec,
  role: RoleSpec,
  state: string | undefined,
  settings: Json,
  root?: string,
): Json {
  const spec = harness.stateWrites;
  if (spec?.delivery !== "file" || !state) return {};
  // A role that commits needs the repository's own git directory: a worktree keeps its index and refs there.
  const git = can(role, "write") && root ? gitCommonDir(root) : undefined;
  const paths = [...stateWrites(role, state), ...(git ? [git] : [])];
  const setting: Json = {};
  setPath(setting, spec.path.split("."), paths);
  const profile = spec.profile && settings[spec.profile.key];
  if (spec.profile && typeof profile === "string" && !profile.startsWith(":"))
    // Paths hold dots, so they are keys set whole rather than dot paths.
    setPath(
      setting,
      spec.profile.at.replace("PROFILE", profile).split("."),
      Object.fromEntries(paths.map((path) => [path, spec.profile!.value])),
    );
  return setting;
}

export function writeFiles(kit: Kit, harness: HarnessSpec, role: RoleSpec, dir: string, record: Recorder): void {
  const refused = refusalLines(kit, harness);
  for (const [path, sources] of Object.entries(harnessFileSources(kit, harness, role))) {
    const text = [...sources.map((source) => readFileSync(source, "utf-8").trimEnd()), refused[path] ?? ""]
      .filter(Boolean)
      .join("\n\n");
    record.note(writeIfChanged(join(dir, path), `${text}\n`), path);
  }
}

export function linkShared(harness: HarnessSpec, dir: string, homeDir: string, record: Recorder): void {
  for (const link of harness.links ?? []) {
    const target = expandHome(link.target, homeDir);
    const path = join(dir, link.link);
    if (existsSync(target)) {
      try {
        record.note(ensureLink(path, target), link.link);
      } catch (error) {
        if (!(error instanceof LeftAlone)) throw error;
        daemonLog.error(error.message);
      }
    } else if (link.optional && isLink(path)) {
      unlinkSync(path);
      record.removed(link.link);
    }
  }
}

function clearMcp(harness: HarnessSpec, current: Json): Json {
  const next = structuredClone(current);
  const clear = harness.mcp.clear;
  if (!clear) return next;
  for (const [path, value] of Object.entries(clear.set ?? {})) setPath(next, path.split("."), structuredClone(value));
  for (const path of clear.remove ?? []) setPath(next, path.split("."), undefined);
  for (const [path, fields] of Object.entries(clear.setInEach ?? {})) {
    const group = getPath(next, path.split("."));
    if (!isRecord(group)) continue;
    for (const [key, item] of Object.entries(group))
      group[key] = { ...(isRecord(item) ? item : {}), ...structuredClone(fields) };
  }
  return next;
}

export function writeMcpFile(harness: HarnessSpec, dir: string, servers: McpServers, record: Recorder): void {
  const file = join(dir, harness.mcp.file);
  const fault = configFault(file);
  // A launch-delivery harness keeps its own account data in this file; a file-delivery one holds only the seat's two tools here.
  if (fault && harness.mcp.delivery !== "file") {
    daemonLog.error(`${fault}, so its MCP servers were left alone`);
    return;
  }
  if (fault) daemonLog.error(`${fault}, and the plugin owns that file, so it was written again`);
  const seed = structuredClone(harness.mcp.seed ?? {});
  const next = clearMcp(harness, fault ? seed : readConfig<Json>(file, seed));
  const { delivery, key } = harness.mcp;
  if (delivery === "file" && key) setPath(next, key.split("."), servers);
  record.note(writeConfigIfChanged(file, next), harness.mcp.file);
}

/**
 * The seat's own instructions file: the kit's block for the project, which a copy made before the block was committed
 * lacks, then what it takes in of the project's own instructions its agent misses.
 */
export function writeInstructions(
  kit: Kit,
  team: Team,
  roleName: string,
  dir: string,
  record: Recorder,
  root?: string,
): void {
  const { harness } = team.roles[roleName]!;
  if (!harness.contextFile) return;
  const text = [projectBlock(kit).trim(), projectImports(harness, root).trim()].filter(Boolean).join("\n\n");
  const contextPath = join(dir, harness.contextFile);
  if (text) record.note(writeIfChanged(contextPath, `${text}\n`), harness.contextFile);
  else removeIfPresent(contextPath, harness.contextFile, record);
}

export function linkSkills(
  kit: Kit,
  team: Team,
  roleName: string,
  seat: { dir: string; homeDir: string },
  record: Recorder,
): void {
  const { role, harness } = team.roles[roleName]!;
  const skillsDir = join(seat.dir, harness.skillsDir);
  mkdirSync(skillsDir, { recursive: true });
  const wanted = skillSources(kit, role, skillDirsFor(team, roleName));
  for (const [name, source] of wanted) {
    const problems = skillProblems(role, name, source);
    if (problems.length > 0) throw new Error(problems.join("; "));
    try {
      record.note(ensureLink(join(skillsDir, name), snapshot(source, name, seat.homeDir)), `skill ${name}`);
    } catch (error) {
      // Thrown, the launch hook refused the seat for ever, since nothing removes that directory.
      if (!(error instanceof LeftAlone)) throw error;
      daemonLog.error(`skill ${name} for the ${role.role}: ${error.message}`);
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
