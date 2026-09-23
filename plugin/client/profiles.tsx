import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { useSeatworks, type Catalog, type Layer } from "./data.ts";
import { Button } from "./bits.tsx";
import { RoleChoice } from "./role-choice.tsx";

export function ProfilesSection({ catalog, values, theme, disabled, save }: { catalog: Catalog; values: Layer; theme: PluginTheme; disabled: boolean; save(change: (values: Layer) => Layer): Promise<boolean> }) {
  const [role, setRole] = useState(catalog.roles[0]?.id ?? "");
  return <View style={{ gap: 12 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "600" }}>Agent launch profiles</Text>
    <Text style={{ color: theme.colors.foregroundMuted, lineHeight: 20 }}>Choose which Seatworks profiles appear in Paseo's profile picker. This controls launch shortcuts; it does not disable providers, stop agents or change the team's models.</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>{catalog.profiles.filter(p => !values.profiles?.disabled.includes(p.id)).length} of {catalog.profiles.length} launch profiles shown</Text>
    <Button label="Show only Supervisor shortcuts" theme={theme} disabled={disabled} onPress={() => void save(current => ({ ...current, profiles: { disabled: [...new Set([...(current.profiles?.disabled ?? []), ...catalog.profiles.filter(p => !catalog.roles.find(r => r.id === p.role)?.can.includes("supervise")).map(p => p.id)])] } }))} />
    <Text style={{ color: theme.colors.foregroundMuted }}>Seatworks starts the rest of the team for you. Provider aliases remain runtime identities used to attach the correct role and tools; hiding a shortcut does not remove them.</Text>
    <SettingsCard><SettingsSelect label="Role" value={role} options={catalog.roles.map((r) => ({ value: r.id, label: r.label }))} onValueChange={setRole} />
      {catalog.profiles.filter((p) => p.role === role).map((p) => <SettingsSwitch key={p.id} label={p.label} value={!values.profiles?.disabled.includes(p.id)} disabled={disabled} onValueChange={(enabled) => void save((current) => ({ ...current, profiles: { disabled: enabled ? (current.profiles?.disabled ?? []).filter((id) => id !== p.id) : [...new Set([...(current.profiles?.disabled ?? []), p.id])] } }))} />)}
    </SettingsCard>
  </View>;
}

export function SeatworksSettings({ theme, layout }: PluginSurfaceProps) {
  const { data, save, saving, saveError } = useSeatworks();
  const [roleId, setRoleId] = useState<string | null>(null);
  if (data.status !== "ready") return <Text style={{ padding: 24, color: theme.colors.foregroundMuted }}>{data.status === "error" ? data.error : "Loading Seatworks settings…"}</Text>;
  const role = data.catalog.roles.find((r) => r.id === roleId) ?? data.catalog.roles.find((r) => r.can.includes("supervise")) ?? data.catalog.roles[0];
  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 24 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 24, fontWeight: "600" }}>Seatworks settings</Text>
    {saveError || data.settingsError ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{saveError ?? data.settingsError}</Text> : null}
    <ProfilesSection catalog={data.catalog} values={data.values} theme={theme} disabled={saving || Boolean(data.settingsError)} save={save} />
    <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "600" }}>Default team models</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>Overall Supervisor uses these defaults. Projects can override their own team. Existing sessions keep their current model.</Text>
    <SettingsCard><SettingsSelect label="Role to configure" value={role?.id ?? ""} options={data.catalog.roles.map((r) => ({ value: r.id, label: r.label }))} onValueChange={setRoleId} /></SettingsCard>
    {role ? <RoleChoice catalog={data.catalog} role={role} values={data.values} machine={{}} theme={theme} disabled={saving || Boolean(data.settingsError)} onChange={(values) => void save(() => values)} /> : null}
  </ScrollView>;
}
