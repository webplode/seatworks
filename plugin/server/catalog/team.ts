import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Attention,
  type HarnessSpec,
  type Kit,
  type McpEntry,
  type McpServers,
  type McpTransport,
  type ModelSpec,
  type ProxySpec,
  type RoleSpec,
  type SensorSpec,
  PASEO_SERVER,
  PASEO_TOOLS,
  TEAM_SERVER,
  can,
  supportsRole,
  agentDefault,
  paseoToolsPolicy,
  teamServer,
  toolsOf,
} from "./kit.ts";
import { type CHECKPOINT_MODES, type Connect, type Layer, type McpChoice } from "./settings.ts";

export type SettingValue = string | number | boolean;
export type McpState = {
  id: string;
  label: string;
  entry?: McpEntry;
  connect?: Connect;
  rule?: string;
  tools?: Record<string, string[]>;
  enabled: boolean;
  roles: string[];
  settings: Record<string, SettingValue>;
};
export type RoleSeat = { role: RoleSpec; harness: HarnessSpec; model?: ModelSpec; thinking?: string; rules: string; mcp: string[] };
export type Team = {
  profiles?: { disabled: string[] };
  roles: Record<string, RoleSeat>;
  mcp: Record<string, McpState>;
  attention: Attention;
  sensor?: { spec: SensorSpec; key: string };
  /** `forced` says why a check runs at its strictest though nobody chose it: settings the desk could not read. */
  checkpoints: Checkpoints;
  /** Who reads a new lane against the Human's own words before its Lead gets far: a Critic seat, or nobody. */
  critic: { by: "seat" | "off" };
  rules: string;
  errors: string[];
};

export type CheckpointMode = (typeof CHECKPOINT_MODES)[number];

/** A landing is only ever approved by the Human: landing is already the Supervisor's call, so it cannot also be the check on it. */
export type Checkpoints = {
  plan: CheckpointMode;
  approve: "risky" | "every";
  approver: "human" | "supervisor";
  risk: string;
  land: CheckpointMode;
  landApprove: "risky" | "every";
  landLines: number;
  forced?: string;
};

/** Paths whose change is risky enough that a plan touching them waits for a person: access, money, data shape, and what ships. */
export const RISKY_PATHS =
  "(^|/)(auth|login|session|passwords?|secrets?|credentials?|tokens?|payments?|billing|migrations?|schema)(/|\\.|$)|\\.sql$|(^|/)\\.github/workflows(/|$)|(^|/)(Dockerfile|docker-compose[^/]*|\\.env[^/]*)$|(^|/)(infra|deploy|terraform|k8s|helm)(/|$)";

/** More changed lines than one sitting reviews well: past a few hundred, reviewers find fewer defects. */
export const LAND_LINES = 1000;

export function templateRoles(entry: McpEntry): string[] {
  return entry.kind === "proxy" ? Object.keys(entry.tools ?? {}) : (entry.roles ?? []);
}

/** No roles named means every role working with tools, not a watcher: a pasted server's tools can write. */
export function eligibleRoles(state: McpState, kit: Kit): string[] {
  const entry = state.entry;
  if (entry?.kind === "proxy") return Object.keys(state.tools ?? entry.tools ?? {});
  // Neither reader works: a Watcher reads seats and a Critic reads a lane, and a pasted server's tools can write.
  const working = () => kit.roles.filter((role) => role.tools && !can(role, "watch") && !can(role, "critique")).map((role) => role.role);
  if (entry) return entry.roles ?? working();
  return working();
}

export function transportOf(state: McpState): McpTransport {
  if (state.entry?.kind === "proxy") return "stdio";
  return state.connect?.type ?? (state.entry?.server?.type as McpTransport | undefined) ?? "stdio";
}

export function connectToServer(connect: Connect): Record<string, unknown> | undefined {
  if (connect.type === "stdio") {
    const [command, ...args] = connect.command ?? [];
    if (!command) return undefined;
    return { type: "stdio", command, ...(args.length > 0 ? { args } : {}), ...(connect.env ? { env: connect.env } : {}) };
  }
  if (!connect.url) return undefined;
  return { type: connect.type, url: connect.url, ...(connect.headers ? { headers: connect.headers } : {}) };
}

export function fill(template: string, settings: Record<string, SettingValue>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in settings ? String(settings[key]) : whole));
}

function resolveMcp(kit: Kit, layers: Layer[], errors: string[]): Record<string, McpState> {
  const states: Record<string, McpState> = {};
  const ids = new Set([...Object.keys(kit.mcp), ...layers.flatMap((layer) => Object.keys(layer.mcp ?? {}))]);
  for (const id of ids) {
    if (id === TEAM_SERVER || id === PASEO_SERVER) {
      errors.push(`The MCP server ${id} has the name of a server every seat already has, so it would replace that one; it is left out: paste it again under another name`);
      continue;
    }
    const entry = kit.mcp[id];
    const choices = layers.map((layer) => layer.mcp?.[id]).filter((choice): choice is McpChoice => choice !== undefined);
    const settings: Record<string, SettingValue> = {};
    for (const [key, spec] of Object.entries(entry?.settings ?? {})) if (spec.default !== undefined) settings[key] = spec.default;
    let enabled = entry?.defaults.enabled ?? false;
    let removed = false;
    let label = entry?.label ?? id;
    let connect: Connect | undefined;
    let rule: string | undefined;
    let tools = entry?.tools;
    let roles: string[] | undefined;
    for (const choice of choices) {
      if (choice.enabled !== undefined) enabled = choice.enabled;
      if (choice.removed !== undefined) removed = choice.removed;
      if (choice.label) label = choice.label;
      if (choice.connect) connect = choice.connect;
      if (choice.rule !== undefined) rule = choice.rule;
      if (choice.tools) tools = { ...tools, ...choice.tools };
      if (choice.roles) roles = choice.roles;
      for (const [key, value] of Object.entries(choice.settings ?? {})) {
        const spec = entry?.settings[key];
        if (!spec) errors.push(`${label} has no setting named ${key}`);
        else if (typeof value !== spec.type) errors.push(`${label} setting ${key} must be a ${spec.type}`);
        else settings[key] = value;
      }
    }
    if (removed) continue;
    if (!entry && !connect) {
      errors.push(`The MCP server ${id} has nothing to connect to; paste its connection details or remove it`);
      continue;
    }
    const state: McpState = { id, label, entry, connect, rule, tools, enabled, roles: [], settings };
    const eligible = eligibleRoles(state, kit);
    for (const role of roles ?? []) {
      if (!eligible.includes(role)) errors.push(`${label} can't be given to the ${role} role: it has nothing for that role`);
    }
    state.roles = (roles ?? eligible).filter((role) => eligible.includes(role));
    states[id] = state;
  }
  return states;
}

type Choice = { harness: string; model?: string; thinking?: string };

/** `origin` is where the role starts before any layer: its own defaults, or what the role it follows has in force. */
function resolveRole(kit: Kit, role: RoleSpec, layers: Layer[], mcp: Record<string, McpState>, errors: string[], origin: Choice = role.defaults): RoleSeat | undefined {
  let choice: Choice = { ...origin };
  const ownRules: string[] = [];
  for (const layer of layers) {
    const next = layer.roles?.[role.role];
    if (!next) continue;
    // Back on the role's own harness restores the preset; reset to the harness alone, it lost the preset's model and thinking.
    if (next.harness && next.harness !== choice.harness) choice = next.harness === origin.harness ? { ...origin } : { harness: next.harness };
    if (next.model) choice.model = next.model;
    if (next.thinking) choice.thinking = next.thinking;
    if (next.rules?.trim()) ownRules.push(next.rules.trim());
  }
  if (role.tools && !kit.toolSets[role.tools]) {
    errors.push(
      `The ${role.label} is given the tool set ${role.tools}, which this kit does not have. A seat with no tools starts, offers none and can never answer; the sets it can be given are ${Object.keys(kit.toolSets).sort().join(", ") || "none"}.`,
    );
  }
  const unknownTools = (role.paseoTools?.allow ?? []).filter((tool) => !PASEO_TOOLS.includes(tool));
  if (unknownTools.length > 0) {
    errors.push(
      `The ${role.label} is allowed Paseo tools this kit does not know: ${unknownTools.join(", ")}. An allow list is applied by denying everything else, so an unknown name denies the ${role.label} every Paseo tool rather than granting it one.`,
    );
  }
  const harness = kit.harnesses[choice.harness];
  if (!harness) {
    errors.push(`The ${role.label} runs on ${choice.harness}, which is not in the harness catalog`);
    return undefined;
  }
  if (!supportsRole(kit, harness, role)) {
    errors.push(`${harness.label} has no ${role.role} settings under harness/${harness.id}/settings, so it can't run the ${role.label}`);
  }
  const models = harness.models ?? [];
  // The catalog is an offer, not a fence: which model a seat runs is the owner's choice.
  let model = choice.model ? (models.find((entry) => entry.id === choice.model) ?? { id: choice.model, label: choice.model }) : undefined;
  model ??= agentDefault(kit.roles, harness);
  // Paseo refuses a bare provider before the daemon, which surfaced only as a format error at open_lane.
  if (!model) errors.push(`Paseo has listed no models for ${harness.label} yet and none is chosen for the ${role.label}; Paseo starts an agent only with one, so refresh the models or choose one`);
  let thinking: string | undefined;
  const options = harness.hasThinking === false ? [] : (model?.thinkingOptions ?? []);
  if (options.length > 0) {
    if (choice.thinking && !options.some((option) => option.id === choice.thinking)) {
      errors.push(`${model!.label} on ${harness.label} has no thinking option ${choice.thinking} for the ${role.label}`);
    }
    thinking = options.some((option) => option.id === choice.thinking) ? choice.thinking : (options.find((option) => option.isDefault) ?? options[0])!.id;
  } else if (choice.thinking && harness.hasThinking !== false && model && !models.some((entry) => entry.id === model!.id)) {
    // No thinking options listed is not a list of none: the owner's choice is kept.
    thinking = choice.thinking;
  }
  const enabled = Object.values(mcp)
    .filter((state) => state.enabled && state.roles.includes(role.role))
    .sort((a, b) => (a.entry?.order ?? 100) - (b.entry?.order ?? 100))
    .map((state) => state.id);
  for (const id of enabled) {
    const transport = transportOf(mcp[id]!);
    if (!harness.mcp.transports.includes(transport)) {
      errors.push(`${harness.label} can't reach ${mcp[id]!.label} over ${transport}, so the ${role.label} can't use it`);
    }
  }
  return { role, harness, model, thinking, rules: ownRules.join("\n\n"), mcp: enabled };
}

export function jevOn(team: Pick<Team, "attention" | "sensor">): boolean {
  return team.attention.by === "jev" && Boolean(team.sensor);
}

export function watchOn(team: Pick<Team, "attention" | "sensor">): boolean {
  return team.attention.by === "seat" || jevOn(team);
}

/** `unread` layers are reported, since resolving to nothing looked like a complete team the owner never wrote. */
export function resolveTeam(kit: Kit, machine: Layer = {}, project: Layer = {}, unread: string[] = []): Team {
  const errors: string[] = [...unread];
  const layers = [machine, project];
  layers.forEach((layer, index) => {
    const where = index === 0 ? "The machine settings" : "The project settings";
    for (const name of Object.keys(layer.roles ?? {})) if (!kit.roles.some((role) => role.role === name)) errors.push(`${where} name an unknown role ${name}`);
  });
  const mcp = resolveMcp(kit, layers, errors);
  const own: Record<string, RoleSeat> = {};
  for (const role of kit.roles) {
    if (role.follows !== undefined) continue;
    const seat = resolveRole(kit, role, layers, mcp, errors);
    if (seat) own[role.role] = seat;
  }
  const roles: Record<string, RoleSeat> = {};
  for (const role of kit.roles) {
    const followed = role.follows === undefined ? undefined : own[role.follows];
    const origin = followed ? { harness: followed.harness.id, model: followed.model?.id, thinking: followed.thinking } : undefined;
    const seat = role.follows === undefined ? own[role.role] : resolveRole(kit, role, layers, mcp, errors, origin);
    if (seat) roles[role.role] = seat;
  }
  const sensors = Object.values(kit.sensors);
  if (sensors.length > 1) errors.push(`The kit ships ${sensors.length} sensors, and the desk can use one`);
  const spec = sensors.length === 1 ? sensors[0] : undefined;
  return {
    roles,
    mcp,
    profiles: machine.profiles,
    ...(spec && machine.sensor?.key ? { sensor: { spec, key: machine.sensor.key } } : {}),
    attention: { ...kit.attention, ...stripUndefined(machine.attention), ...stripUndefined(project.attention) },
    // A check the Human turned on must not fall silently to its default when the file that says so cannot be read.
    checkpoints:
      unread.length > 0
        ? { plan: "on", approve: "every", approver: "human", risk: RISKY_PATHS, land: "on", landApprove: "every", landLines: LAND_LINES, forced: unread.join("; ") }
        : {
            plan: project.checkpoints?.plan ?? machine.checkpoints?.plan ?? "shadow",
            approve: project.checkpoints?.approve ?? machine.checkpoints?.approve ?? "risky",
            approver: project.checkpoints?.approver ?? machine.checkpoints?.approver ?? "human",
            risk: project.checkpoints?.risk ?? machine.checkpoints?.risk ?? RISKY_PATHS,
            land: project.checkpoints?.land ?? machine.checkpoints?.land ?? "shadow",
            landApprove: project.checkpoints?.landApprove ?? machine.checkpoints?.landApprove ?? "risky",
            landLines: project.checkpoints?.landLines ?? machine.checkpoints?.landLines ?? LAND_LINES,
          },
    critic: { by: project.critic?.by ?? machine.critic?.by ?? "seat" },
    rules: [machine.rules, project.rules].filter((text) => text && text.trim()).join("\n\n"),
    errors,
  };
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function withHarness(team: Team, roleName: string, harness: HarnessSpec): Team {
  const seat = team.roles[roleName];
  if (!seat || seat.harness.id === harness.id) return team;
  const models = harness.models ?? [];
  const preset = harness.id === seat.role.defaults.harness ? seat.role.defaults : undefined;
  // The kit's own model for its own harness, whether or not the catalog lists it, as resolveRole keeps it.
  const model = preset?.model ? (models.find((entry) => entry.id === preset.model) ?? { id: preset.model, label: preset.model }) : agentDefault(Object.values(team.roles).map((entry) => entry.role), harness);
  const options = harness.hasThinking === false ? [] : (model?.thinkingOptions ?? []);
  const offCatalog = Boolean(preset?.model) && !models.some((entry) => entry.id === preset!.model);
  const thinking = offCatalog && harness.hasThinking !== false ? preset!.thinking : (options.find((option) => option.id === preset?.thinking) ?? options.find((option) => option.isDefault) ?? options[0])?.id;
  return { ...team, roles: { ...team.roles, [roleName]: { ...seat, harness, model, thinking } } };
}

/** A server needing what the project lacks (an IDE's folder) is switched off, or a Peer is told to use a tool that cannot answer. */
export function servingProject(team: Team, root: string): Team {
  const lacking = new Set(Object.values(team.mcp).filter((state) => state.enabled && (state.entry?.requires ?? []).some((path) => !existsSync(join(root, path)))).map((state) => state.id));
  if (lacking.size === 0) return team;
  return {
    ...team,
    mcp: Object.fromEntries(Object.entries(team.mcp).map(([id, state]) => [id, lacking.has(id) ? { ...state, enabled: false } : state])),
    roles: Object.fromEntries(Object.entries(team.roles).map(([name, seat]) => [name, { ...seat, mcp: seat.mcp.filter((id) => !lacking.has(id)) }])),
  };
}

export type IndexedProxy = ProxySpec & { id: string; label: string; backend: { type: "http"; url: string } };

export function proxyOf(state: McpState): ProxySpec | undefined {
  return state.entry?.proxy ? (JSON.parse(fill(JSON.stringify(state.entry.proxy), state.settings)) as ProxySpec) : undefined;
}

export function indexedProxies(team: Team): IndexedProxy[] {
  const found: IndexedProxy[] = [];
  for (const state of Object.values(team.mcp)) {
    const proxy = state.enabled ? proxyOf(state) : undefined;
    // Keyed on opening alone, a preset without an open tool lost the sync and git exclude, and a Peer could commit `.idea/`.
    const serves = Boolean(proxy?.open || proxy?.close || proxy?.sync || proxy?.gitExclude?.length);
    if (proxy && serves && proxy.backend.type === "http") found.push({ ...proxy, backend: proxy.backend, id: state.id, label: state.label });
  }
  return found;
}

export function serversFor(kit: Kit, team: Team, roleName: string, context: { node: string; spool: string }): McpServers {
  const seat = team.roles[roleName];
  if (!seat) return {};
  const desk = teamServer(kit, seat.role, context.spool, context.node);
  const servers: McpServers = desk[TEAM_SERVER] && seat.harness.mcp.desk ? { [TEAM_SERVER]: { ...(desk[TEAM_SERVER] as object), ...seat.harness.mcp.desk } } : { ...desk };
  for (const id of seat.mcp) {
    const state = team.mcp[id]!;
    const { entry } = state;
    if (entry?.kind === "proxy") {
      const tools = (state.tools ?? entry.tools)?.[roleName] ?? [];
      if (tools.length === 0) continue;
      const config = { name: id, label: state.label, instructions: entry.instructions ?? "", tools, ...proxyOf(state) };
      servers[id] = { type: "stdio", command: context.node, args: [join(kit.dir, "mcp", "code.mjs"), JSON.stringify(config)] };
      continue;
    }
    const shaped = state.connect ? connectToServer(state.connect) : entry?.server ? JSON.parse(fill(JSON.stringify(entry.server), state.settings)) : undefined;
    if (shaped) servers[id] = shaped;
  }
  return servers;
}

export function preapprovedFor(kit: Kit, team: Team, roleName: string): { kind: "mcp"; server: string; tool: string }[] {
  const seat = team.roles[roleName];
  if (!seat) return [];
  const refs = (server: string, tools: string[]) => tools.map((tool) => ({ kind: "mcp" as const, server, tool }));
  const approved = seat.role.tools ? refs(TEAM_SERVER, toolsOf(kit, seat.role)) : [];
  // Paseo adds its own server at launch, unless a seat's config already names one; only the tools this role is allowed there.
  const paseo = paseoToolsPolicy(seat.role);
  if (paseo?.enabled !== false) approved.push(...refs(PASEO_SERVER, PASEO_TOOLS.filter((tool) => !paseo?.disabledTools?.includes(tool))));
  for (const id of seat.mcp) {
    const state = team.mcp[id]!;
    if (state.entry?.kind === "proxy") approved.push(...refs(id, (state.tools ?? state.entry.tools)?.[roleName] ?? []));
  }
  return approved;
}

export function rulesFor(team: Team, roleName: string): string {
  const seat = team.roles[roleName];
  if (!seat) return "";
  const parts: string[] = [];
  for (const id of seat.mcp) {
    const state = team.mcp[id]!;
    const { entry } = state;
    const lines: string[] = [];
    const rule = state.rule ?? (entry?.rule ? readFileSync(join(entry.dir, entry.rule), "utf-8").trim() : "");
    if (rule.trim()) lines.push(rule.trim());
    const tools = entry?.kind === "proxy" ? ((state.tools ?? entry.tools)?.[roleName] ?? []) : [];
    if (tools.length > 0) lines.push(`Your ${state.label} tools: ${tools.map((tool) => `\`${tool}\``).join(", ")}.`);
    const note = entry?.roleNotes?.[roleName];
    if (note) lines.push(note);
    if (lines.length > 0) parts.push(lines.join("\n\n"));
  }
  if (seat.harness.mcp.rule && seat.mcp.length > 0) parts.push(seat.harness.mcp.rule);
  if (team.rules) parts.push(`## Rules from the Human\n\n${team.rules.trim()}`);
  if (seat.rules) parts.push(`## Rules from the Human, for the ${seat.role.label}\n\n${seat.rules}`);
  return parts.length > 0 ? `# Working rules\n\n${parts.join("\n\n")}\n` : "";
}

export function skillDirsFor(team: Team, roleName: string): Map<string, string> {
  const found = new Map<string, string>();
  const seat = team.roles[roleName];
  if (!seat) return found;
  for (const id of seat.mcp) {
    const { entry } = team.mcp[id]!;
    if (entry) for (const skill of entry.skills ?? []) found.set(skill, join(entry.dir, "skills", skill));
  }
  return found;
}
