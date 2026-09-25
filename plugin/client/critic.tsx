import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsCard, SettingsRow } from "@getpaseo/plugin/client/ui";
import type { ReactElement } from "react";
import { Text } from "react-native";
import { sourceLabel } from "./bits.tsx";
import type { CriticBy, Layer, TeamView } from "./data.ts";
import { setCritic, sourceOf } from "./data.ts";
import { TabBar } from "./tabs.tsx";

type Props = {
  team: TeamView;
  values: Layer;
  machine: Layer;
  layer: "machine" | "project";
  theme: PluginTheme;
  disabled: boolean;
  rows: ReactElement[];
  save(change: (values: Layer) => Layer): Promise<boolean>;
};

/** The Critic's chip: whether a Critic reads each new lane, then its agent while it does. */
export function CriticSettings({ team, values, machine, layer, theme, disabled, rows, save }: Props) {
  const by = team.critic.by;
  return (
    <>
      <SettingsCard>
        <SettingsRow label="Critic by" hint={`Who reads each new lane against what the Human actually wrote. ${sourceLabel(sourceOf(values, machine, (entry) => entry.critic?.by, layer), layer)}.`}>
          <TabBar
            theme={theme}
            active={by}
            disabled={disabled}
            onPick={(next) => void save((current) => setCritic(current, next as CriticBy))}
            tabs={[
              { id: "seat", label: "Seat" },
              { id: "off", label: "Off" },
            ]}
          />
        </SettingsRow>
        {by === "seat" ? rows : null}
      </SettingsCard>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {by === "seat"
          ? "A fresh Critic reads each lane the Supervisor opens, once: only what the Human wrote, CONTEXT.md and the lane, never the Supervisor's reasoning. It hands the Supervisor what may not agree, then goes. Another model family than the Supervisor's misses less of what it missed."
          : "No lane is read against the Human's words. The Agent, Model and Thinking set for the Critic are kept for when it is back on."}
      </Text>
    </>
  );
}
