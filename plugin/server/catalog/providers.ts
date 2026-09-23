import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { type HarnessSpec, type Kit, type ModelSpec, type RoleSpec, agentDefault, paseoToolsPolicy, providerId, supportsRole } from "./kit.ts";
import { writeConfigAtomic } from "../core/config-file.ts";
import { paseoConfigPath } from "../core/paths.ts";
import { sameJson } from "../core/store.ts";
import type { Team } from "./team.ts";

type Json = Record<string, any>;

export function labelFor(kit: Kit, role: RoleSpec, harness: HarnessSpec): string {
  const tag = kit.prefix.replace(/[-_]+$/, "");
  const base = `${role.label} · ${harness.label}`;
  return tag ? `${base} (${tag})` : base;
}

export function seatPairs(kit: Kit): { role: RoleSpec; harness: HarnessSpec }[] {
  const pairs: { role: RoleSpec; harness: HarnessSpec }[] = [];
  for (const role of kit.roles) {
    for (const harness of Object.values(kit.harnesses)) if (supportsRole(kit, harness, role)) pairs.push({ role, harness });
  }
  return pairs;
}

function choiceFor(team: Team, role: RoleSpec, harness: HarnessSpec): { model?: string; thinking?: string } {
  const seat = team.roles[role.role];
  if (seat && seat.harness.id === harness.id) return { model: seat.model?.id, thinking: seat.thinking };
  const preset = harness.id === role.defaults.harness ? role.defaults : undefined;
  const listed = harness.models?.find((entry) => entry.id === preset?.model);
  if (preset?.model && !listed) return { model: preset.model, thinking: harness.hasThinking === false ? undefined : preset.thinking };
  const model = listed ?? agentDefault(Object.values(team.roles).map((seat) => seat.role), harness);
  const options = harness.hasThinking === false ? [] : (model?.thinkingOptions ?? []);
  return { model: model?.id, thinking: (options.find((option) => option.id === preset?.thinking) ?? options.find((option) => option.isDefault) ?? options[0])?.id };
}

function defaultModel(harness: HarnessSpec, choice: { model?: string }): ModelSpec[] {
  if (!choice.model) return [];
  const label = harness.models?.find((entry) => entry.id === choice.model)?.label ?? choice.model;
  return [{ id: choice.model, label, isDefault: true }];
}

export function desiredProvider(kit: Kit, team: Team, role: RoleSpec, harness: HarnessSpec): Json {
  const entry: Json = {
    extends: harness.baseProvider,
    label: labelFor(kit, role, harness),
    env: { ...(harness.provider.env ?? {}), SEATWORKS_ROLE: role.role, SEATWORKS_KIT: kit.dir },
  };
  if (role.description) entry.description = role.description;
  const command = (harness.provider.command ?? []).map((part) => part.replaceAll("KIT", kit.dir));
  if (command.length > 0) entry.command = command;
  const models = defaultModel(harness, choiceFor(team, role, harness));
  if (models.length > 0) entry.additionalModels = models;
  const tools = paseoToolsPolicy(role);
  if (tools) entry.paseoTools = tools;
  return entry;
}

export function desiredProfile(kit: Kit, team: Team, role: RoleSpec, harness: HarnessSpec): Json {
  const id = providerId(kit, role.role, harness.id);
  const choice = choiceFor(team, role, harness);
  const profile: Json = { id, name: labelFor(kit, role, harness), provider: id };
  if (choice.model) profile.model = choice.model;
  if (harness.provider.profileModeId) profile.modeId = harness.provider.profileModeId;
  if (choice.thinking) profile.thinkingOptionId = choice.thinking;
  return profile;
}

function managedEnvKeys(kit: Kit): Set<string> {
  const keys = new Set<string>();
  for (const harness of Object.values(kit.harnesses)) {
    keys.add(harness.configDirEnv);
    for (const key of Object.keys(harness.provider.env ?? {})) keys.add(key);
  }
  return keys;
}

export function reconcile(config: Json, kit: Kit, team: Team): { config: Json; changed: string[] } {
  const next: Json = structuredClone(config);
  next.agents ??= {};
  next.agents.providers ??= {};
  next.daemon ??= {};
  next.daemon.agentProfiles ??= [];
  const managed = managedEnvKeys(kit);
  const changed: string[] = [];
  const pairs = seatPairs(kit);
  const wanted = new Set(pairs.map((pair) => providerId(kit, pair.role.role, pair.harness.id)));
  if (kit.prefix) {
    for (const id of Object.keys(next.agents.providers)) {
      if (id.startsWith(kit.prefix) && !wanted.has(id)) {
        delete next.agents.providers[id];
        changed.push(`provider ${id} removed`);
      }
    }
    next.daemon.agentProfiles = next.daemon.agentProfiles.filter((entry: Json) => {
      const stale = typeof entry.id === "string" && entry.id.startsWith(kit.prefix) && !wanted.has(entry.id);
      if (stale) changed.push(`profile ${entry.id} removed`);
      return !stale;
    });
  }
  for (const { role, harness } of pairs) {
    const id = providerId(kit, role.role, harness.id);
    const have: Json = next.agents.providers[id] ?? {};
    const want = desiredProvider(kit, team, role, harness);
    const kept = Object.fromEntries(Object.entries(have.env ?? {}).filter(([key]) => !key.startsWith("SEATWORKS_") && !managed.has(key)));
    const merged: Json = { ...have, ...want, env: { ...kept, ...want.env } };
    for (const key of ["command", "models", "additionalModels", "paseoTools", "description"]) if (!(key in want)) delete merged[key];
    if (!sameJson(merged, have)) {
      next.agents.providers[id] = merged;
      changed.push(`provider ${id}`);
    }
    const profile = desiredProfile(kit, team, role, harness);
    const profiles: Json[] = next.daemon.agentProfiles;
    const index = profiles.findIndex((entry) => entry.id === profile.id);
    if (team.profiles?.disabled.includes(profile.id)) {
      if (index >= 0) { profiles.splice(index, 1); changed.push(`profile ${profile.id} disabled`); }
      continue;
    }
    const current = index >= 0 ? profiles[index] : undefined;
    const mergedProfile: Json = { ...(current ?? {}), ...profile };
    for (const key of ["model", "modeId", "thinkingOptionId"]) if (!(key in profile)) delete mergedProfile[key];
    if (!current || !sameJson(mergedProfile, current)) {
      if (index >= 0) profiles[index] = mergedProfile;
      else profiles.push(mergedProfile);
      changed.push(`profile ${profile.id}`);
    }
  }
  return { config: next, changed };
}

export function applyReconcile(kit: Kit, team: Team): string[] {
  const configPath = paseoConfigPath();
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as Json;
  const { config: next, changed } = reconcile(config, kit, team);
  // Staged and renamed: a daemon killed mid-write could not parse its own config. The mode is kept so a private config is not widened.
  if (changed.length > 0) writeConfigAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`, statSync(configPath).mode & 0o777);
  return changed;
}

export function reloadDaemon(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("paseo", ["daemon", "reload"], { timeout: 30_000 }, (error, _stdout, stderr) => {
      if (error) console.error("seatworks-v2: paseo daemon reload failed:", stderr || error.message);
      resolve(!error);
    });
  });
}
