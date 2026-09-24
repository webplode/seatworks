import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { bindingRpc, createSupervisorRpc, supervisionRpc } from "../shared/rpc.ts";
import type { SupervisionView } from "../shared/supervision.ts";
import { bindingInput } from "./project-setup.ts";
import { Button } from "./bits.tsx";
import { message, useSeatworks, setAttention } from "./data.ts";
import { RoleChoice, roleChoice } from "./role-choice.tsx";
import { SetupDialog } from "./setup-dialog.tsx";
import { SupervisionPanel } from "./supervision.tsx";
import { TeamSection } from "./team.tsx";
import { FlowSection } from "./flow.tsx";
import { useFlow } from "./data.ts";

type Tab = "models" | "work" | "supervisor" | "advanced" | "activity" | "machine";
export function WorkspaceTeam(props: PluginWorkspacePanelProps) { return <WorkspaceSeatworks {...props} initialTab="models" />; }
export function WorkspaceWork(props: PluginWorkspacePanelProps) { return <WorkspaceSeatworks {...props} initialTab="work" />; }
export function WorkspaceSupervisor(props: PluginWorkspacePanelProps) { return <WorkspaceSeatworks {...props} initialTab="supervisor" />; }

/** Whether this workspace is the Overall Supervisor's own home, which is not a project: its team settings are the ones every project starts from. */
function useSupervisorHome(workspaceId: string): boolean | null {
  const read = useRpc(supervisionRpc);
  const [home, setHome] = useState<boolean | null>(null);
  useEffect(() => { let alive = true; read({}).then((v) => { if (alive) setHome((v as unknown as SupervisionView).binding.supervisor?.workspace === workspaceId); }).catch(() => { if (alive) setHome(false); }); return () => { alive = false; }; }, [workspaceId]);
  return home;
}

function WorkspaceSeatworks(props: PluginWorkspacePanelProps & { initialTab: Tab }) {
  const workspace = useWorkspace(props.workspaceId, (w) => ({ name: w.projectDisplayName, root: w.projectRootPath }));
  const machine = useSeatworks();
  const home = useSupervisorHome(props.workspaceId);
  if (!workspace) return <Text style={{ padding: 20, color: props.theme.colors.foregroundMuted }}>This workspace is unavailable.</Text>;
  if (home === null) return <Text style={{ padding: 20, color: props.theme.colors.foregroundMuted }}>Loading team…</Text>;
  if (machine.data.status !== "ready") return <Text style={{ padding: 20, color: props.theme.colors.foregroundMuted }}>{machine.data.status === "error" ? machine.data.error : "Loading team…"}</Text>;
  const project = machine.data.projects.find((p) => p.root === workspace.root);
  const initialTab = home && (props.initialTab === "models" || props.initialTab === "work") ? "machine" : props.initialTab;
  return <WorkspaceBody key={workspace.root} {...props} initialTab={initialTab} home={home} workspace={workspace} project={home ? undefined : project?.slug} machine={machine} />;
}

function WorkspaceBody({ theme, layout, navigation, workspace, project, machine, initialTab, home }: PluginWorkspacePanelProps & {
  workspace: { name: string; root: string }; project?: string; machine: ReturnType<typeof useSeatworks>; initialTab: Tab; home: boolean;
}) {
  const local = useSeatworks(project);
  const read = useRpc(supervisionRpc), create = useRpc(createSupervisorRpc), bind = useRpc(bindingRpc);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lanes, setLanes] = useState<string[]>([]);
  const [live, setLive] = useState(true);
  const { flow, error: flowError } = useFlow(tab === "activity" && live ? project : undefined, 5000, lanes.slice().sort().join(","));
  if (local.data.status !== "ready" || machine.data.status !== "ready") return <Text style={{ padding: 20, color: theme.colors.foregroundMuted }}>{local.data.status === "error" ? local.data.error : "Loading project models…"}</Text>;
  const global = machine.data, data = local.data, catalog = global.catalog;
  const roles = catalog.roles.filter((r) => r.can.includes("lead") || r.can.includes("write") || r.can.includes("review") || r.can.includes("watch"));
  const role = roles.find((r) => r.id === roleId) ?? roles.find((r) => r.can.includes("lead")) ?? roles[0];
  const supervisor = catalog.roles.find((r) => r.can.includes("supervise"));
  const choice = supervisor ? roleChoice(catalog, supervisor, global.values, {}) : null;
  const locked = local.saving || Boolean(data.settingsError);
  const c = theme.colors;
  const openSupervisor = async (allowCreate = false) => {
    setBusy(true); setError(null);
    try {
      let view = await read({}) as unknown as SupervisionView;
      if (!view.binding.supervisor && !allowCreate) { setConfirm(true); return; }
      if (!view.binding.supervisor) { await create({ revision: view.binding.revision }); view = await read({}) as unknown as SupervisionView; }
      if (!view.binding.supervisor) throw new Error("Supervisor is not available. Retry after checking the provider.");
      if (!view.binding.active && view.binding.projects.length) await bind(bindingInput(view.binding, true));
      setConfirm(false); navigation?.openAgent({ agentId: view.binding.supervisor.agent });
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 20, gap: 18 }}>
    {home ? <View style={{ gap: 4 }}><Text style={{ color: c.foreground, fontSize: 22, fontWeight: "600" }}>Your team</Text><Text style={{ color: c.foregroundMuted, lineHeight: 21 }}>The AI model each team member uses in every project. A project can still pick its own in its Team & models.</Text></View>
      : <View style={{ gap: 4 }}><Text style={{ color: c.foreground, fontSize: 22, fontWeight: "600" }}>{workspace.name}</Text><Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{workspace.root}</Text></View>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{(home ? [['machine','Team & models'],['supervisor','Overall Supervisor']] as const : [['models','Team & models'],['work','New work'],['supervisor','Overall Supervisor']] as const).map(([id,label]) => <Button key={id} label={label} theme={theme} tone={tab === id ? "accent" : "plain"} onPress={() => setTab(id)} />)}</View>
    {error || local.saveError || machine.saveError || data.settingsError || global.settingsError ? <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{error ?? local.saveError ?? machine.saveError ?? data.settingsError ?? global.settingsError}</Text> : null}
    {tab === "supervisor" ? <View style={{ gap: 16 }}>
      <Text style={{ color: c.foregroundMuted, lineHeight: 21 }}>One Supervisor looks after all your projects. Open its chat, or create it with the model below. Choosing which projects it looks after is done in Seatworks.</Text>
      <Button label={busy ? "Opening…" : "Open Overall Supervisor"} theme={theme} tone="accent" disabled={busy || !navigation} onPress={() => void openSupervisor()} />
      <Text style={{ color: c.foreground, fontWeight: "600" }}>Model for a new Supervisor</Text>
      {supervisor ? <RoleChoice catalog={catalog} role={supervisor} values={global.values} machine={{}} theme={theme} disabled={machine.saving || Boolean(global.settingsError)} onChange={(values) => void machine.save(() => values)} /> : null}
      <Text style={{ color: c.foregroundMuted }}>This applies when a new Supervisor starts. To change the running one, use the model menu in its chat.</Text>
    </View> : tab === "machine" ? <TeamSection catalog={catalog} team={global.team} values={global.values} machine={{}} layer="machine" theme={theme} disabled={machine.saving || Boolean(global.settingsError)} active={roleId} onActive={setRoleId} save={machine.save} reload={machine.reload} /> : !project ? <View style={{ paddingVertical: 16, gap: 16 }}>
      <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}>Set up this project's team</Text><Text style={{ color: c.foregroundMuted, lineHeight: 21 }}>Choose its models and Supervisor access here. The current folder is already selected.</Text>
      <Button label="Set up Seatworks here" theme={theme} tone="accent" onPress={() => setSetup(true)} />
    </View> : tab === "models" ? <View style={{ gap: 16 }}>
      <Text style={{ color: c.foregroundMuted, lineHeight: 21 }}>Pick the AI model each team member uses in this project. Changes save by themselves and apply to team members started from now on.</Text>
      <SettingsCard><SettingsSelect label="Team member" value={role?.id ?? ""} options={roles.map((r) => ({ value: r.id, label: r.label }))} onValueChange={setRoleId} /></SettingsCard>
      {role ? <RoleChoice catalog={catalog} role={role} values={data.values} machine={data.machine} theme={theme} disabled={locked} onChange={(values) => void local.save(() => values)} /> : null}
      <Text style={{ color: c.foregroundMuted }}>{local.saving ? "Saving…" : local.saved ? "Saved" : "These choices apply to this project only."}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button label="Models for all projects" theme={theme} onPress={() => setTab("machine")} />
        <Button label="Rules, tools & advanced settings" theme={theme} onPress={() => setTab("advanced")} />
      </View>
    </View> : tab === "advanced" ? <TeamSection catalog={catalog} team={data.team} values={data.values} machine={data.machine} layer="project" theme={theme} disabled={locked} active={roleId} onActive={setRoleId} save={local.save} reload={local.reload} />
      : tab === "activity" ? <FlowSection onAgent={navigation ? id => navigation.openAgent({ agentId: id }) : undefined} following flow={flow} error={flowError} live={live} theme={theme} disabled={locked} onLive={setLive} onAddKey={() => { setRoleId(catalog.roles.find((r) => r.can.includes("watch"))?.id ?? null); setTab("machine"); }} onWatchBySeat={() => void local.save((values) => setAttention(values, { by: "seat" }))} onOpen={(id) => setLanes(lanes.includes(id) ? lanes.filter((l) => l !== id) : [...lanes,id])} />
      : <SupervisionPanel theme={theme} compact catalog={catalog} machine={global.values} projects={data.projects.filter((p) => p.slug === project)} available={data.candidates} listFolders={local.listFolders} attach={local.attach} onChanged={() => local.reload()} onAdd={() => setSetup(true)} onSettings={(slug) => setTab(slug === "machine" ? "supervisor" : "models")} onFlow={() => setTab("activity")} onAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined} />}
    <SetupDialog open={setup} initialRoot={workspace.root} catalog={catalog} available={data.candidates} projects={data.projects} readSettings={local.readSettings} machine={global.values} theme={theme} disabled={local.saving} onOpenChange={setSetup} attach={local.attach} listFolders={local.listFolders} onAttached={() => { local.reload(); machine.reload(); setTab("models"); }} />
    <Modal title="Create Overall Supervisor" open={confirm} onOpenChange={(value) => { if (!busy) setConfirm(value); }}><Modal.Content>
      <Text style={{ color: c.foreground }}>Start {choice?.harness?.label ?? "configured provider"} · {choice?.model || "provider default"}{choice?.thinking ? ` · ${choice.thinking}` : ""} in the shared Supervisor workspace?</Text>
      <Text style={{ color: c.foregroundMuted }}>It waits for your first request and looks after the projects you already chose, with what you already allowed. No project is added.</Text>
      {error ? <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{error}</Text> : null}
      <Button label={busy ? "Creating…" : "Create & open Supervisor"} theme={theme} tone="accent" disabled={busy} onPress={() => void openSupervisor(true)} />
    </Modal.Content></Modal>
  </ScrollView>;
}
