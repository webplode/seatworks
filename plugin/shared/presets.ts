/** A project's team in one choice: Balanced follows the machine's team, the others set Lead, Peer and Reviewer outright. */
export type PresetId = "cheap" | "balanced" | "max";
export type PresetRole = { harness: string; model: string; thinking?: string };
export type Preset = { id: PresetId; label: string; hint: string; roles: Record<string, PresetRole> };

export const PRESETS: Preset[] = [
  {
    id: "cheap", label: "Cheap", hint: "Smaller models and less thinking, for routine work",
    roles: {
      lead: { harness: "claude", model: "claude-sonnet-5", thinking: "medium" },
      peer: { harness: "codex", model: "gpt-5.6-luna", thinking: "low" },
      reviewer: { harness: "codex", model: "gpt-5.6-luna", thinking: "medium" },
    },
  },
  { id: "balanced", label: "Balanced", hint: "Your team defaults", roles: {} },
  {
    id: "max", label: "Max", hint: "The strongest models and the most thinking, for hard work",
    roles: {
      lead: { harness: "claude", model: "claude-opus-5-5", thinking: "xhigh" },
      peer: { harness: "codex", model: "gpt-6-astra", thinking: "high" },
      reviewer: { harness: "codex", model: "gpt-6-astra", thinking: "xhigh" },
    },
  },
];

type Choice = { harness?: string; model?: string; thinking?: string; rules?: string };

/** Which preset a project's own role choices are, or "custom" when they are some other mix. */
export function presetOf(roles: Record<string, Choice | undefined> | undefined): PresetId | "custom" {
  const set = Object.entries(roles ?? {}).filter(([, choice]) => choice && (choice.harness || choice.model || choice.thinking));
  if (set.length === 0) return "balanced";
  for (const preset of PRESETS) {
    const ids = Object.keys(preset.roles);
    if (ids.length !== set.length) continue;
    if (set.every(([id, choice]) => { const want = preset.roles[id]; return want && choice!.harness === want.harness && choice!.model === want.model && (choice!.thinking ?? undefined) === want.thinking; })) return preset.id;
  }
  return "custom";
}

/** The project's roles with the preset in force: its own words to a role (`rules`) are kept. */
export function withPreset(roles: Record<string, Choice | undefined> | undefined, preset: Preset): Record<string, Choice> {
  const next: Record<string, Choice> = {};
  for (const [id, choice] of Object.entries(roles ?? {})) if (choice?.rules) next[id] = { rules: choice.rules };
  for (const [id, choice] of Object.entries(preset.roles)) next[id] = { ...next[id], ...choice };
  return next;
}

/** A preset model Paseo does not list for its agent, so choosing it would start nobody. */
export function missingModels(preset: Preset, listed: (harness: string) => string[] | undefined): string[] {
  return Object.values(preset.roles).filter((choice) => { const models = listed(choice.harness); return models !== undefined && !models.includes(choice.model); }).map((choice) => choice.model);
}
