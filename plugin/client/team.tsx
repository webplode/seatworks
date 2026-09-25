import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { type ReactElement, useState } from "react";
import { modelsRpc } from "../shared/rpc.ts";
import { Text } from "react-native";
import { sourceLabel } from "./bits.tsx";
import type { Catalog, CheckpointMode, Digest, Layer, RoleChoice, TeamView } from "./data.ts";
import { message, modelRow, setCheckpoint, setRole, sourceOf } from "./data.ts";
import { ModelPicker } from "./model-picker.tsx";
import { TabBar } from "./tabs.tsx";
import { CriticSettings } from "./critic.tsx";
import { WatcherSettings } from "./watch.tsx";

type Props = {
  catalog: Catalog;
  team: TeamView;
  values: Layer;
  machine: Layer;
  layer: "machine" | "project";
  theme: PluginTheme;
  disabled: boolean;
  active: string | null;
  onActive(role: string): void;
  save(change: (values: Layer) => Layer): Promise<boolean>;
  reload(): void;
};

type Listed = Record<string, { at: string; error: string | null; count: number }>;

/** The models are Paseo's: it asks each agent, and this asks Paseo to do it again. */
function ModelsCard({ catalog, disabled, reload }: Pick<Props, "catalog" | "disabled" | "reload">) {
  const refresh = useRpc(modelsRpc) as unknown as (input: object) => Promise<Listed>;
  const [busy, setBusy] = useState(false);
  const [listed, setListed] = useState<Listed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = (id: string) => catalog.harnesses.find((entry) => entry.id === id)?.label ?? id;
  const failed = listed ? Object.entries(listed).filter(([, entry]) => entry.error) : [];
  const hint = listed
    ? Object.entries(listed).map(([id, entry]) => `${label(id)} ${entry.count}`).join(" · ")
    : catalog.harnesses.map((entry) => `${entry.label} ${entry.models.length}`).join(" · ");
  return (
    <SettingsCard>
      <SettingsAction
        label="Models"
        hint={`Listed by Paseo: ${hint}`}
        error={error ?? (failed.length ? failed.map(([id, entry]) => `${label(id)}: ${entry.error}`).join("\n") : null)}
        actionLabel={busy ? "Asking" : "Refresh"}
        disabled={disabled || busy}
        onPress={() => {
          setBusy(true);
          setError(null);
          refresh({})
            .then((next) => {
              setListed(next);
              reload();
            })
            .catch((problem) => setError(message(problem)))
            .finally(() => setBusy(false));
        }}
      />
    </SettingsCard>
  );
}

type Role = Catalog["roles"][number];

/** Rows, not a component: the card borders each child it gets, and the Watcher's card wraps its own rows around these. */
export function roleRows({ catalog, team, values, machine, layer, theme, disabled, save, role }: Omit<Props, "active" | "onActive" | "reload"> & { role: Role }): ReactElement[] {
  const seat = team.roles[role.id];
  const follows = role.follows ? catalog.roles.find((entry) => entry.id === role.follows)?.label : undefined;
  const harness = catalog.harnesses.find((entry) => entry.id === seat?.harness);
  const models = harness?.models ?? [];
  const model = seat?.model ?? models[0]?.id ?? "";
  const row = modelRow(model, models);
  const stray = row.stray;
  const thinking = harness?.thinking === false ? [] : (models.find((entry) => entry.id === model)?.thinkingOptions ?? []);
  const source = (field: keyof RoleChoice) => sourceOf(values, machine, (entry) => entry.roles?.[role.id]?.[field], layer);
  const rows: ReactElement[] = [
    <SettingsSelect
      key="agent"
      label="Agent"
      hint={sourceLabel(source("harness"), layer, follows)}
      value={seat?.harness ?? role.defaults.harness}
      options={role.harnesses.map((id) => ({ label: catalog.harnesses.find((entry) => entry.id === id)?.label ?? id, value: id }))}
      onValueChange={(next) => void save((current) => setRole(current, role.id, { harness: next }, true))}
      disabled={disabled}
    />,
  ];
  if (models.length > 1 || stray) {
    rows.push(
      <ModelPicker
        key="model"
        label="Model"
        hint={stray ? `${model} is not one this agent offers. Pick one it does.` : sourceLabel(source("model"), layer, follows)}
        value={row.value}
        options={row.options}
        theme={theme}
        onValueChange={(next) => void save((current) => setRole(current, role.id, { model: next }))}
        disabled={disabled}
      />,
    );
  } else if (models.length === 1) {
    rows.push(
      <SettingsRow key="model" label="Model" hint={`${harness?.label ?? "This agent"} runs one model.`}>
        <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{models[0]!.label}</Text>
      </SettingsRow>,
    );
  }
  if (thinking.length > 0) {
    rows.push(
      <SettingsSelect
        key="thinking"
        label="Thinking"
        hint={sourceLabel(source("thinking"), layer, follows)}
        value={seat?.thinking ?? thinking[0]!.id}
        options={thinking.map((entry) => ({ label: entry.label, value: entry.id }))}
        onValueChange={(next) => void save((current) => setRole(current, role.id, { thinking: next }))}
        disabled={disabled}
      />,
    );
  }
  return rows;
}

const PLAN_CHECK: Record<CheckpointMode, string> = {
  off: "Plans are not checked.",
  shadow: "Every plan is checked and the result kept in checkpoints.log, pass or not; nothing is held back.",
  on: "A plan the check finds fault with goes back to the Lead, and a lane's first task waits for a plan.",
};

/** What a project's own log says of one check, under its mode: none on the machine's defaults, none while it is off. */
function logRow(digest: Digest | undefined, mode: CheckpointMode, theme: PluginTheme): ReactElement | null {
  if (!digest || mode === "off") return null;
  const badge = digest.state === "ready" ? { text: "Ready to turn on", color: theme.colors.statusSuccess } : digest.state === "stamped" ? { text: "May be approved out of habit", color: theme.colors.statusWarning } : undefined;
  return (
    <SettingsRow label="From its log" hint={digest.lines.join(" ")}>
      {badge ? <Text style={{ color: badge.color, fontSize: 12, fontWeight: "600" }}>{badge.text}</Text> : null}
    </SettingsRow>
  );
}

/** On the Lead's chip, since the plan is the Lead's: how hard the desk checks it before the work starts. */
function PlanCheckCard({ team, values, machine, layer, theme, disabled, save }: Props) {
  const mode = team.checkpoints.plan;
  const from = sourceLabel(sourceOf(values, machine, (entry) => entry.checkpoints?.plan, layer), layer);
  return (
    <SettingsCard>
      <SettingsRow label="Plan check" hint={team.checkpoints.forced ? `On, because ${team.checkpoints.forced}.` : `${PLAN_CHECK[mode]} ${from}.`}>
        <TabBar
          theme={theme}
          active={mode}
          disabled={disabled}
          onPick={(next) => void save((current) => setCheckpoint(current, { plan: next as CheckpointMode }))}
          tabs={[
            { id: "off", label: "Off" },
            { id: "shadow", label: "Shadow" },
            { id: "on", label: "On" },
          ]}
        />
      </SettingsRow>
      <SettingsRow label="Approve plans" hint={`${team.checkpoints.approve === "every" ? "Every plan waits for approval before it runs." : "Only a plan that owns risky paths waits: access, money, data shape, and what ships."} Held only while the check is on. ${sourceLabel(sourceOf(values, machine, (entry) => entry.checkpoints?.approve, layer), layer)}.`}>
        <TabBar
          theme={theme}
          active={team.checkpoints.approve}
          disabled={disabled}
          onPick={(next) => void save((current) => setCheckpoint(current, { approve: next as "risky" | "every" }))}
          tabs={[
            { id: "risky", label: "Risky" },
            { id: "every", label: "Every" },
          ]}
        />
      </SettingsRow>
      <SettingsRow label="Approved by" hint={`${team.checkpoints.approver === "human" ? "You, on its card in Team activity; the Supervisor is told and cannot approve for you." : "The Supervisor, with approve_plan."} ${sourceLabel(sourceOf(values, machine, (entry) => entry.checkpoints?.approver, layer), layer)}.`}>
        <TabBar
          theme={theme}
          active={team.checkpoints.approver}
          disabled={disabled}
          onPick={(next) => void save((current) => setCheckpoint(current, { approver: next as "human" | "supervisor" }))}
          tabs={[
            { id: "human", label: "You" },
            { id: "supervisor", label: "Supervisor" },
          ]}
        />
      </SettingsRow>
      {logRow(team.digest?.plan, team.checkpoints.forced ? "on" : mode, theme)}
    </SettingsCard>
  );
}

const LAND_CHECK: Record<CheckpointMode, string> = {
  off: "Landings are not checked.",
  shadow: "Every landing is checked and the result kept in checkpoints.log, with its evidence in the Supervisor's reply; nothing is held back.",
  on: "A landing the check flags waits for you on its card in Team activity before anything reaches the base branch.",
};

/** On the Supervisor's chip, since landing is its call: when a landing waits for you first. Only you approve one. */
function LandCheckCard({ team, values, machine, layer, theme, disabled, save }: Props) {
  const mode = team.checkpoints.land;
  return (
    <SettingsCard>
      <SettingsRow label="Land check" hint={team.checkpoints.forced ? `On, because ${team.checkpoints.forced}.` : `${LAND_CHECK[mode]} ${sourceLabel(sourceOf(values, machine, (entry) => entry.checkpoints?.land, layer), layer)}.`}>
        <TabBar
          theme={theme}
          active={mode}
          disabled={disabled}
          onPick={(next) => void save((current) => setCheckpoint(current, { land: next as CheckpointMode }))}
          tabs={[
            { id: "off", label: "Off" },
            { id: "shadow", label: "Shadow" },
            { id: "on", label: "On" },
          ]}
        />
      </SettingsRow>
      <SettingsRow
        label="Approve landings"
        hint={`${team.checkpoints.landApprove === "every" ? "Every landing waits for you." : `Only a landing with something to see first waits: a red or missing gate, tests deleted or weakened, risky paths, more than ${team.checkpoints.landLines} lines, open incidents the code or a Watcher raised, files outside the lane.`} Held only while the check is on. ${sourceLabel(sourceOf(values, machine, (entry) => entry.checkpoints?.landApprove, layer), layer)}.`}
      >
        <TabBar
          theme={theme}
          active={team.checkpoints.landApprove}
          disabled={disabled}
          onPick={(next) => void save((current) => setCheckpoint(current, { landApprove: next as "risky" | "every" }))}
          tabs={[
            { id: "risky", label: "Flagged" },
            { id: "every", label: "Every" },
          ]}
        />
      </SettingsRow>
      {logRow(team.digest?.land, team.checkpoints.forced ? "on" : mode, theme)}
    </SettingsCard>
  );
}

export function TeamSection(props: Props) {
  const { catalog, theme, disabled, active, onActive } = props;
  const role = catalog.roles.find((entry) => entry.id === active) ?? catalog.roles[0];
  if (!role) return null;
  return (
    <SettingsSection title="Team" info={role.description}>
      <TabBar theme={theme} active={role.id} disabled={disabled} onPick={onActive} tabs={catalog.roles.map((entry) => ({ id: entry.id, label: entry.label }))} />
      {role.can.includes("watch") ? (
        <WatcherSettings {...props} role={role} rows={roleRows({ ...props, role })} />
      ) : role.can.includes("critique") ? (
        <CriticSettings {...props} rows={roleRows({ ...props, role })} />
      ) : (
        <SettingsCard>{roleRows({ ...props, role })}</SettingsCard>
      )}
      {role.can.includes("lead") ? <PlanCheckCard {...props} /> : null}
      {role.can.includes("supervise") ? <LandCheckCard {...props} /> : null}
      <ModelsCard catalog={props.catalog} disabled={props.disabled} reload={props.reload} />
    </SettingsSection>
  );
}
