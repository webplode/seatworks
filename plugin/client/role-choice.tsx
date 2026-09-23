import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsCard, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { Catalog, Layer } from "./data.ts";
import { harnessInForce, modelInForce, thinkingInForce, modelRow, setRole } from "./data.ts";
import { ModelPicker } from "./model-picker.tsx";

type Role = Catalog["roles"][number];

export function roleChoice(catalog: Catalog, role: Role, values: Layer, machine: Layer) {
  const harness = catalog.harnesses.find((h) => h.id === harnessInForce(role, values, machine));
  const models = harness?.models ?? [];
  const model = modelInForce(role, values, machine) ?? models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? "";
  const options = harness?.thinking === false ? [] : models.find((m) => m.id === model)?.thinkingOptions ?? [];
  const preferred = thinkingInForce(role, values, machine);
  const thinking = options.find((o) => o.id === preferred)?.id ?? options.find((o) => o.isDefault)?.id ?? options[0]?.id;
  return { harness, model, thinking, options };
}

export function RoleChoice({ catalog, role, values, machine, theme, disabled, onChange }: {
  catalog: Catalog; role: Role; values: Layer; machine: Layer; theme: PluginTheme; disabled?: boolean;
  onChange(values: Layer): void;
}) {
  const choice = roleChoice(catalog, role, values, machine);
  const row = modelRow(choice.model, choice.harness?.models ?? []);
  return <View style={{ gap: 8 }}>
    <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>{role.label}</Text>
    <SettingsCard>
      <SettingsSelect label={`${role.label} provider`} value={choice.harness?.id ?? role.defaults.harness}
        options={role.harnesses.map((id) => ({ value: id, label: catalog.harnesses.find((h) => h.id === id)?.label ?? id }))}
        disabled={disabled} onValueChange={(harness) => onChange(setRole(values, role.id, { harness }, true))} />
      <ModelPicker label={`${role.label} model`} value={row.value} options={row.options} theme={theme}
        hint={row.stray ? "Choose a model offered by this provider." : undefined}
        disabled={disabled} onValueChange={(model) => onChange(setRole(values, role.id, { model }))} />
      {choice.options.length ? <SettingsSelect label={`${role.label} thinking`} value={choice.thinking ?? ""}
        options={choice.options.map((o) => ({ value: o.id, label: o.label }))} disabled={disabled}
        onValueChange={(thinking) => onChange(setRole(values, role.id, { thinking }))} /> : null}
    </SettingsCard>
  </View>;
}
