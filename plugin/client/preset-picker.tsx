import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import { PRESETS, type Preset, type PresetId, missingModels } from "../shared/presets.ts";
import type { Catalog, Layer } from "./data.ts";
import { roleChoice } from "./role-choice.tsx";

export const projectRoles = (catalog: Catalog) => catalog.roles.filter((r) => r.can.includes("lead") || r.can.includes("write") || r.can.includes("review"));

/** "Lead Claude Code · Opus 5.5 · high" for each role the preset starts, as the catalog names them. */
export function presetLines(catalog: Catalog, preset: Preset, machine: Layer): string[] {
  return projectRoles(catalog).map((role) => {
    const set = preset.roles[role.id];
    const choice = set ?? (() => { const c = roleChoice(catalog, role, {}, machine); return { harness: c.harness?.id ?? "", model: c.model, thinking: c.thinking }; })();
    const harness = catalog.harnesses.find((h) => h.id === choice.harness);
    const model = harness?.models.find((m) => m.id === choice.model)?.label ?? choice.model;
    return `${role.label} · ${harness?.label ?? choice.harness} · ${model}${choice.thinking ? ` · ${choice.thinking}` : ""}`;
  });
}

export function presetMissing(catalog: Catalog, preset: Preset): string[] {
  return missingModels(preset, (id) => { const models = catalog.harnesses.find((h) => h.id === id)?.models; return models?.length ? models.map((m) => m.id) : undefined; });
}

export function PresetPicker({ catalog, machine, selected, theme, disabled, onSelect }: {
  catalog: Catalog; machine: Layer; selected: PresetId | "custom"; theme: PluginTheme; disabled?: boolean; onSelect(id: PresetId): void;
}) {
  const c = theme.colors;
  return <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
    {PRESETS.map((preset) => {
      const on = selected === preset.id;
      const missing = presetMissing(catalog, preset);
      return <Pressable key={preset.id} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: disabled || missing.length > 0 }} accessibilityLabel={preset.label}
        disabled={disabled || missing.length > 0} onPress={() => onSelect(preset.id)}
        style={{ padding: 12, gap: 4, borderRadius: 8, borderWidth: 1, borderColor: on ? c.accent : c.border, backgroundColor: on ? c.surface2 : c.surface1, opacity: missing.length ? 0.5 : 1 }}>
        <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>{on ? "●" : "○"}  {preset.label} <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>· {preset.hint}</Text></Text>
        {missing.length ? <Text style={{ color: c.statusWarning, fontSize: 12 }}>Paseo does not list {missing.join(", ")} yet. Refresh the models in Team defaults.</Text>
          : presetLines(catalog, preset, machine).map((line) => <Text key={line} numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>{line}</Text>)}
      </Pressable>;
    })}
    {selected === "custom" ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>This project has its own mix of models. Choosing a preset replaces it.</Text> : null}
  </View>;
}
