import { join } from "node:path";
import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { type Kit, type McpServers, type RoleSpec, agentDefault, seatOf } from "./kit.ts";
import { stateTargets } from "./content.ts";
import { type Team, preapprovedFor, rulesFor, skillDirsFor } from "./team.ts";

export type AgentConfig = PluginBeforeRequests["agent.create"]["config"];
export type SessionOpen = PluginBeforeRequests["agent.session_open"];
export type RenderPrompt = (role: RoleSpec) => string;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function appendAt(options: unknown, path: string, value: string): Json {
  const root: Json = isObject(options) ? { ...options } : {};
  const parts = path.split(".");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor[part] = isObject(cursor[part]) ? { ...cursor[part] } : {};
    cursor = cursor[part] as Json;
  }
  const last = parts[parts.length - 1]!;
  const list = Array.isArray(cursor[last]) ? (cursor[last] as unknown[]) : [];
  cursor[last] = [...new Set([...list, value])];
  return root;
}

/** Only the state paths the seat's content writes: state also holds the desk's record, whose `gate` runs unsandboxed in the daemon. */
export function stateWrites(kit: Kit, team: Team, role: RoleSpec, state: string): string[] {
  return stateTargets(kit, role, skillDirsFor(team, role.role), rulesFor(team, role.role)).map((segment) => join(state, segment));
}

export function applyRole(kit: Kit, team: Team, config: AgentConfig, render: RenderPrompt, state?: string, servers: McpServers = {}): AgentConfig {
  const seat = seatOf(kit, config.provider);
  if (!seat) return config;
  const { role, harness } = seat;
  const chosen = team.roles[role.role];
  const sameHarness = chosen?.harness.id === harness.id;
  const models = harness.models ?? [];
  const model =
    models.find((entry) => entry.id === config.model) ??
    (sameHarness ? chosen?.model : undefined) ??
    agentDefault(kit.roles, harness);
  const next: AgentConfig = { ...config };
  if (model) next.model = model.id;
  if (harness.provider.profileModeId) next.modeId = harness.provider.profileModeId;
  const options = harness.hasThinking === false ? [] : (model?.thinkingOptions ?? []);
  if (options.length === 0) {
    const owned = harness.hasThinking === false ? undefined : sameHarness && chosen?.model?.id === model?.id ? chosen?.thinking : undefined;
    if (owned) next.thinkingOptionId = owned;
    else delete next.thinkingOptionId;
  }
  else {
    const preferred = sameHarness && chosen?.model?.id === model?.id ? chosen?.thinking : undefined;
    const valid = (id: string | undefined) => Boolean(id) && options.some((option) => option.id === id);
    next.thinkingOptionId = [config.thinkingOptionId, preferred].find(valid) ?? (options.find((option) => option.isDefault) ?? options[0])!.id;
  }
  if (harness.systemPrompt === "config") {
    const prompt = render(role);
    next.systemPrompt = config.systemPrompt ? `${prompt}\n\n${config.systemPrompt}` : prompt;
  }
  if (harness.mcp.delivery === "launch" && Object.keys(servers).length > 0) {
    next.mcpServers = { ...(config.mcpServers ?? {}), ...servers } as AgentConfig["mcpServers"];
    if (harness.mcp.preapprove) next.toolPolicy = { preapproved: preapprovedFor(kit, team, role.role).filter((ref) => ref.server in (next.mcpServers ?? {})) };
  }
  let providerOptions: unknown = config.providerOptions;
  if (harness.stateWrites?.delivery === "launch" && state) {
    for (const path of stateWrites(kit, team, role, state)) providerOptions = appendAt(providerOptions, harness.stateWrites.path, path);
  }
  if (harness.projectContextOption && config.cwd) providerOptions = appendAt(providerOptions, harness.projectContextOption, config.cwd);
  if (providerOptions !== config.providerOptions) next.providerOptions = providerOptions as AgentConfig["providerOptions"];
  return next;
}

export function seatEnv(kit: Kit, request: SessionOpen, seatPath: string, project: { root: string; state: string }): SessionOpen {
  const seat = seatOf(kit, request.provider);
  if (!seat) return request;
  return {
    ...request,
    env: {
      ...request.env,
      [seat.harness.configDirEnv]: seatPath,
      SEATWORKS_ROLE: seat.role.role,
      SEATWORKS_PROJECT: project.root,
      SEATWORKS_STATE: project.state,
    },
  };
}
