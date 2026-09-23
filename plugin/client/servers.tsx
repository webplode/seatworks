import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Chips, sourceLabel } from "./bits.tsx";
import type { Catalog, Layer, McpChoice, Scalar, SettingSpec, TeamView } from "./data.ts";
import { dropMcp, setMcp, sourceOf } from "./data.ts";
import { TabBar } from "./tabs.tsx";

type Entry = Catalog["mcp"][number];

type Props = {
  catalog: Catalog;
  team: TeamView;
  values: Layer;
  machine: Layer;
  layer: "machine" | "project";
  theme: PluginTheme;
  disabled: boolean;
  save(change: (values: Layer) => Layer): Promise<boolean> | void;
  addServer(text: string): Promise<string | null>;
};

const ADD = "__add__";
const EXAMPLE = '{\n  "mcp": {\n    "context7": {\n      "type": "local",\n      "command": ["npx", "-y", "@upstash/context7-mcp"],\n      "enabled": true\n    }\n  }\n}';

function Tuning({ entry, current, disabled, save, labelOf }: {
  entry: Entry;
  current: Record<string, Scalar>;
  disabled: boolean;
  save: Props["save"];
  labelOf(key: string): string;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const value = (key: string, spec: SettingSpec): Scalar => {
    const text = draft[key] ?? String(current[key] ?? "");
    return spec.type === "number" ? Number(text) : text;
  };
  const edited = Object.keys(draft).filter((key) => draft[key] !== String(current[key] ?? ""));
  // An emptied field is not zero: `Number("")` is, and the port or limit the owner cleared was saved as 0.
  const wrong = edited.some((key) => entry.settings[key]?.type === "number" && (!draft[key]!.trim() || !Number.isFinite(Number(draft[key]))));
  return (
    <>
      {Object.entries(entry.settings).map(([key, spec]) =>
        spec.type === "boolean" ? (
          <SettingsSwitch
            key={key}
            label={spec.label}
            hint={labelOf(key)}
            value={Boolean(current[key] ?? spec.default ?? false)}
            onValueChange={(next) => save((values) => setMcp(values, entry.id, { settings: { [key]: next } }))}
            disabled={disabled}
          />
        ) : (
          <SettingsInput
            key={key}
            label={spec.label}
            hint={labelOf(key)}
            initialValue={String(current[key] ?? spec.default ?? "")}
            onChangeText={(text) => setDraft((last) => ({ ...last, [key]: text }))}
            disabled={disabled}
          />
        ),
      )}
      {edited.length > 0 ? (
        <SettingsAction
          label={wrong ? "That needs a number" : "Unsaved change"}
          error={wrong ? "That needs a number" : null}
          actionLabel="Save"
          disabled={disabled || wrong}
          onPress={() => {
            const settings = Object.fromEntries(edited.map((key) => [key, value(key, entry.settings[key]!)]));
            // Cleared only once kept: cleared first, a refused save dropped the unsaved row and showed a value never stored.
            void Promise.resolve(save((values) => setMcp(values, entry.id, { settings }))).then((kept) => {
              if (kept !== false) setDraft({});
            });
          }}
        />
      ) : null}
    </>
  );
}

export function ServersSection({ catalog, team, values, machine, layer, theme, disabled, save, addServer }: Props) {
  const ids = Object.keys(team.mcp);
  // A removed template keeps its tab: resolving drops removed servers, which left no way to add it back.
  const put = catalog.mcp.map((item) => item.id).filter((id) => !ids.includes(id));
  const [active, setActive] = useState(ids[0] ?? ADD);
  const [paste, setPaste] = useState("");
  const state = team.mcp[active];
  // Forgotten only where this layer added it; a machine server shown on a project has nothing there to forget.
  const addedHere = layer === "machine" || machine.mcp?.[active] === undefined;
  const entry = catalog.mcp.find((item) => item.id === active);
  const tabs = [...ids.map((id) => ({ id, label: team.mcp[id]!.label })), ...put.map((id) => ({ id, label: catalog.mcp.find((item) => item.id === id)?.label ?? id })), { id: ADD, label: "Add a server" }];
  const styles = useMemo(
    () => ({
      block: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 16, gap: 8 },
      label: { color: theme.colors.foreground, fontSize: 14, fontWeight: "500" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
      box: { marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 8, backgroundColor: theme.colors.surface2 },
      boxText: { color: theme.colors.foreground, fontSize: 12, lineHeight: 18, minHeight: 190 },
    }),
    [theme],
  );

  if (!state && entry) {
    return (
      <SettingsSection title="MCP servers" info={entry.description ?? ""}>
        <TabBar theme={theme} active={active} disabled={disabled} onPick={setActive} tabs={tabs} />
        <SettingsCard>
          <SettingsAction
            label={`${entry.label} was removed`}
            hint="It is still in the built-in list. Adding it back brings its switch and its settings with it."
            actionLabel="Add it back"
            disabled={disabled}
            onPress={() => void save((current) => setMcp(current, entry.id, { removed: false }))}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  if (active === ADD || !state) {
    return (
      <SettingsSection title="MCP servers" info="Paste the snippet a server gives you. Everything else you choose here afterwards.">
        <TabBar theme={theme} active={ADD} disabled={disabled} onPick={setActive} tabs={tabs} />
        <SettingsCard>
          <SettingsRow label="Connection" hint="Anything the server hands you: mcp, mcpServers, or a bare object." />
          <View style={styles.box}>
            <TextInput
              style={styles.boxText}
              value={paste}
              onChangeText={setPaste}
              placeholder={EXAMPLE}
              placeholderTextColor={theme.colors.foregroundMuted}
              editable={!disabled}
              multiline
              textAlignVertical="top"
              accessibilityLabel="The server's connection snippet"
            />
          </View>
          <SettingsAction
            label="Add it"
            hint={paste.trim() ? "Saved switched on, given to the roles whose agent can reach it. Narrow it below." : "Paste the snippet first. One server at a time."}
            actionLabel="Add"
            disabled={disabled || !paste.trim()}
            onPress={() =>
              void addServer(paste).then((id) => {
                if (!id) return;
                setPaste("");
                setActive(id);
              })
            }
          />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const roles = state.roles;
  const on = state.enabled;
  const source = (field: keyof McpChoice) => sourceOf(values, machine, (current) => current.mcp?.[active]?.[field], layer);

  return (
    <SettingsSection title="MCP servers" info={entry?.description ?? (state.connect ? "Added here from a pasted snippet." : "")}>
      <TabBar theme={theme} active={active} disabled={disabled} onPick={setActive} tabs={tabs} />
      <SettingsCard>
        <SettingsSwitch
          label="Switched on"
          hint={sourceLabel(source("enabled"), layer)}
          value={on}
          onValueChange={(next) => save((current) => setMcp(current, active, { enabled: next }))}
          disabled={disabled}
        />
        <View style={styles.block}>
          <View>
            <Text style={styles.label}>Roles that get it</Text>
            <Text style={styles.hint}>{on ? sourceLabel(source("roles"), layer) : "The server is switched off, so no role reaches it."}</Text>
          </View>
          <Chips
            theme={theme}
            disabled={disabled || !on}
            chosen={roles}
            options={(entry ? entry.roles : catalog.roles.filter((role) => role.can.length > 0).map((role) => role.id)).map((role) => ({ id: role, label: role }))}
            onToggle={(role, want) =>
              save((current) => setMcp(current, active, { roles: want ? [...new Set([...roles, role])] : roles.filter((other) => other !== role) }))
            }
          />
        </View>
        {entry ? (
          <Tuning
            entry={entry}
            current={state.settings}
            disabled={disabled}
            save={(change) => save(change)}
            labelOf={(key) => sourceLabel(sourceOf(values, machine, (current) => current.mcp?.[active]?.settings?.[key], layer), layer)}
          />
        ) : null}
        <SettingsAction
          label="Remove this server"
          hint={
            state.template
              ? "It stays in the built-in list; add it again whenever you want."
              : addedHere
                ? "It was added here, so removing it forgets it — its url and any token with it."
                : "It comes from the machine's defaults, so removing it here switches it off for this project only; the switch above turns it back on."
          }
          actionLabel="Remove"
          disabled={disabled}
          onPress={() =>
            save((current) => {
              // Switched off, not removed: removed, the resolver drops it and its tab, leaving no way to switch it back on.
              const next = state.template ? setMcp(current, active, { removed: true, enabled: false }) : addedHere ? dropMcp(current, active) : setMcp(current, active, { enabled: false });
              setActive(ids.find((id) => id !== active) ?? ADD);
              return next;
            })
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
