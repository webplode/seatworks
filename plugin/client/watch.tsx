import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsAction, SettingsCard, SettingsInput, type SettingsInputHandle, SettingsRow, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { type ReactElement, useRef, useState } from "react";
import { Text } from "react-native";
import { KEPT } from "../shared/rpc.ts";
import { sourceLabel } from "./bits.tsx";
import type { Catalog, Layer, TeamView } from "./data.ts";
import { setAttention, setSensorKey, sourceOf } from "./data.ts";
import { TabBar } from "./tabs.tsx";

type Props = {
  catalog: Catalog;
  team: TeamView;
  values: Layer;
  machine: Layer;
  layer: "machine" | "project";
  theme: PluginTheme;
  disabled: boolean;
  role: Catalog["roles"][number];
  rows: ReactElement[];
  save(change: (values: Layer) => Layer): Promise<boolean>;
};

const CHOSEN = {
  here: { machine: "Chosen here, for every project that sets nothing.", project: "This project chose it." },
  machine: { machine: "", project: "Not chosen here; following this machine." },
  default: { machine: "Not chosen anywhere; the built-in default.", project: "Not chosen anywhere; the built-in default." },
} as const;

/** The watch settings, on the Watcher's chip only: what reads the seats, then its agent or Jev's key, then mail. */
export function WatcherSettings({ catalog, team, values, machine, layer, theme, disabled, rows, save }: Props) {
  const [draft, setDraft] = useState("");
  const field = useRef<SettingsInputHandle>(null);
  const by = team.attention.by;
  // The key never comes back from the server, only whether one is set; it lives on the machine for every project.
  const set = (layer === "machine" ? values : machine).sensor?.key === KEPT;
  const typed = draft.trim();
  const mailFrom = CHOSEN[sourceOf(values, machine, (entry) => entry.attention?.watch, layer)][layer];
  const byFrom = sourceLabel(sourceOf(values, machine, (entry) => entry.attention?.by, layer), layer);

  const write = (key: string | null) => {
    void save((current) => setSensorKey(current, key)).then((saved) => {
      // The typed key is the owner's only copy, so it is cleared only once saved.
      if (!saved) return;
      setDraft("");
      field.current?.replaceText("");
    });
  };

  const jev: ReactElement[] =
    layer === "machine"
      ? [
          <SettingsInput
            key="key"
            ref={field}
            label="OpenRouter key"
            hint={set ? "Kept on this machine and never shown again. Type another to replace it." : "Jev cannot watch without one, and Seatworks never switches to a Watcher agent on its own."}
            placeholder="sk-or-…"
            secureTextEntry
            onChangeText={setDraft}
            disabled={disabled}
          />,
          <SettingsAction
            key="save"
            label={set ? "Replace the key" : "Save the key"}
            hint="A key starts paid calls: one per watched agent once it goes quiet, at least one every thirty seconds while it works, and one right away whenever a turn ends or something goes wrong."
            actionLabel="Save key"
            onPress={() => write(typed)}
            disabled={disabled || typed.length === 0}
          />,
          ...(set
            ? [<SettingsAction key="forget" label="Forget the key" hint="Jev stops at its next check, and nothing is watched or recorded until there is a key again." actionLabel="Forget key" onPress={() => write(null)} disabled={disabled} />]
            : []),
        ]
      : [
          <SettingsRow key="key" label="OpenRouter key" hint="Kept on this machine and used by every project. Add or remove it under Machine defaults, on the Watcher.">
            <Text style={{ color: set ? theme.colors.foreground : theme.colors.statusWarning, fontSize: 14 }}>{set ? "set" : "not set"}</Text>
          </SettingsRow>,
        ];
  if (catalog.sensor) {
    jev.push(
      <SettingsRow key="sensor" label="Jev's model" hint="Called through OpenRouter">
        <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{catalog.sensor.model}</Text>
      </SettingsRow>,
    );
  }

  return (
    <>
      <SettingsCard>
        <SettingsRow label="Who watches" hint={`Jev is a paid model outside the team, called through OpenRouter. ${byFrom}`}>
          <TabBar
            theme={theme}
            active={by}
            disabled={disabled}
            onPick={(next) => void save((current) => setAttention(current, { by: next as "seat" | "jev" }))}
            tabs={[
              { id: "seat", label: "Watcher agent" },
              { id: "jev", label: "Jev" },
            ]}
          />
        </SettingsRow>
        {by === "seat" ? rows : jev}
        <SettingsSwitch
          label="Send notices"
          hint={`To the Lead of the work stream, or the Supervisor. Never to the agent being watched. ${mailFrom}`.trim()}
          value={team.attention.watch}
          onValueChange={(next) => void save((current) => setAttention(current, { watch: next }))}
          disabled={disabled}
        />
      </SettingsCard>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {by === "seat"
          ? "One Watcher agent per project. It starts while a work stream is open and stops when none is. It shows on the Flow tab beside the Supervisor, like any agent."
          : "No Watcher agent runs while Jev watches. The Watcher agent's settings are kept for when you switch back."}
      </Text>
    </>
  );
}
