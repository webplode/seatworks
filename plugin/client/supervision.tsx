import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { bindingRpc, createSupervisorRpc, supervisionRpc } from "../shared/rpc.ts";
import { briefLabel, reloadSupervisorRpc } from "../shared/brief.ts";
import type { SupervisionView } from "../shared/supervision.ts";
import { Button } from "./bits.tsx";
import { useBrief } from "./brief.tsx";
import { Composer } from "./composer.tsx";
import type { Catalog, Folders, Layer, PaseoProject, ProjectRow } from "./data.ts";
import { message } from "./data.ts";
import { roleChoice } from "./role-choice.tsx";
import { bindingInput, workGrants } from "./project-setup.ts";
import { SupervisionSettings } from "./supervision-settings.tsx";

export function SupervisionPanel({ theme, compact, catalog, machine, projects, available = [], listFolders, attach, onChanged, onAdd, onSettings, onFlow, onAgent }: {
  theme: PluginTheme; compact: boolean; catalog: Catalog; machine: Layer; projects: ProjectRow[]; available?: PaseoProject[];
  listFolders?: (path?: string) => Promise<Folders | { error: string }>; attach?: (root: string, values: Layer) => Promise<string | null>; onChanged?: () => void;
  onAdd(): void; onSettings(slug: string): void; onFlow(slug: string): void; onAgent?: (id: string) => void;
}) {
  const read = useRpc(supervisionRpc), bind = useRpc(bindingRpc), create = useRpc(createSupervisorRpc), reloadSupervisor = useRpc(reloadSupervisorRpc);
  const { data: brief } = useBrief();
  const [view, setView] = useState<SupervisionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [query, setQuery] = useState("");
  const [aim, setAim] = useState<{ root: string; at: number } | null>(null);
  const latest = useRef(read); latest.current = read;
  const refresh = async () => { try { setView(await latest.current({}) as unknown as SupervisionView); setError(null); } catch (e) { setError(message(e)); } };
  useEffect(() => {
    let alive = true;
    const load = async () => { try { const next = await latest.current({}) as unknown as SupervisionView; if (alive) setView(next); } catch (e) { if (alive) setError(message(e)); } };
    void load(); const timer = setInterval(() => { if (!busy && !advanced) void load(); }, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [busy, advanced, projects]);
  /** Opens the shared conversation, starting the Supervisor first when there is none. */
  const openSupervisor = async () => {
    setBusy(true); setError(null);
    try {
      let next = await read({}) as unknown as SupervisionView;
      if (!next.binding.supervisor) { await create({ revision: next.binding.revision }); next = await read({}) as unknown as SupervisionView; }
      const supervisor = next.binding.supervisor?.agent;
      if (!supervisor) throw new Error("Your Supervisor did not start. Refresh and try again.");
      if (!next.binding.active && next.binding.projects.length) await bind(bindingInput(next.binding, true));
      await refresh(); onAgent?.(supervisor);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const c = theme.colors;
  const text = { color: c.foreground, fontSize: 14, lineHeight: 21 };
  const muted = { ...text, color: c.foregroundMuted };
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 10 };
  const card = { padding: compact ? 14 : 18, gap: 12, borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.surface1 };
  const role = catalog.roles.find((r) => r.can.includes("supervise"));
  const choice = role ? roleChoice(catalog, role, machine, {}) : null;
  const supervisor = view?.binding.supervisor;
  const liveSupervisor = view?.supervisors.find((s) => s.id === supervisor?.agent);
  const runtimeLabel = (agent: { provider: string; model: string | null; thinking: string | null }) => { const harness = catalog.harnesses.find((h) => agent.provider === h.id || agent.provider.endsWith(`-${h.id}`)); return `${harness?.label ?? agent.provider} · ${harness?.models.find((m) => m.id === agent.model)?.label ?? agent.model ?? "default model"}${agent.thinking ? ` · ${agent.thinking}` : ""}`; };
  const supervisorLine = liveSupervisor ? `Supervisor ${runtimeLabel(liveSupervisor)}` : `Supervisor ${choice?.harness?.label ?? "not set up"} · ${choice?.harness?.models.find((m) => m.id === choice.model)?.label ?? choice?.model ?? "default model"}${choice?.thinking ? ` · ${choice.thinking}` : ""}`;
  const giveAccess = async (id: string) => {
    if (!view) return;
    setBusy(true); setError(null);
    try { await bind({ ...bindingInput(view.binding, view.binding.active), projects: view.binding.projects.map((p) => ({ id: p.id, grants: p.id === id ? [...new Set([...p.grants, ...workGrants])] : p.grants })) }); await refresh(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const statusOf = (id: string) => brief?.projects.find((p) => p.id === id)?.status;
  const needs = (name: string) => brief?.items.filter((item) => item.project === name).length ?? 0;
  const matching = projects.filter((p) => `${p.root} ${view?.binding.projects.find((s) => s.slug === p.slug)?.name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const canCompose = Boolean(listFolders && attach && view);
  return <View style={{ gap: 24, width: "100%", maxWidth: 880, alignSelf: "center", paddingVertical: 12 }}>
    <View style={row}>
      <View style={{ flex: 1, minWidth: 160, gap: 2 }}><Text style={{ ...text, fontSize: 17, fontWeight: "600" }}>Seatworks</Text><Text style={{ ...muted, fontSize: 13 }}>One Supervisor for all your projects.</Text></View>
      <Button label="Team defaults" theme={theme} onPress={() => onSettings("machine")} />
      <Button label="Add project" theme={theme} onPress={onAdd} />
    </View>
    {error ? <View style={{ gap: 8 }}><Text accessibilityRole="alert" selectable style={{ ...text, color: c.statusDanger }}>{error}</Text><Button label="Try again" theme={theme} onPress={() => void refresh()} /></View> : null}
    {!view ? <Text style={muted}>Loading your workspace…</Text> : <>
      {canCompose ? <Composer theme={theme} compact={compact} catalog={catalog} machine={machine} view={view} projects={projects} available={available} listFolders={listFolders!} attach={attach!}
        onChanged={() => { onChanged?.(); void refresh(); }} onSettings={onSettings} onAgent={onAgent} onAccess={(id) => void giveAccess(id)} supervisorLine={supervisorLine} aim={aim}
          signIn={brief?.signIn ?? null} onReload={async () => { await reloadSupervisor({}); }} /> : null}
      <View style={{ ...card, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
        <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
          <Text style={{ ...text, fontWeight: "600" }}>Overall Supervisor <Text style={{ ...muted, fontWeight: "400" }}>· {supervisor ? view.binding.active ? brief ? briefLabel(brief) : "active" : "paused" : "starts with your first objective"}</Text></Text>
          <Text style={{ ...muted, fontSize: 13 }}>{supervisorLine}</Text>
        </View>
        {supervisor ? <Button label="Open chat" theme={theme} tone={brief?.needsYou ? "accent" : "plain"} disabled={!onAgent} onPress={() => onAgent?.(supervisor.agent)} />
          : <Button label={busy ? "Starting…" : "Start Supervisor"} theme={theme} disabled={busy || !onAgent} onPress={() => void openSupervisor()} />}
      </View>
      {projects.length ? <View style={{ gap: 10 }}>
        <View style={row}>
          <Text style={{ ...text, fontSize: 15, fontWeight: "600", flex: 1 }}>Projects · {projects.length}</Text>
          {projects.length > 4 ? <TextInput accessibilityLabel="Find a project" placeholder="Find a project…" placeholderTextColor={c.foregroundMuted} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} style={{ ...text, paddingHorizontal: 10, minHeight: 34, minWidth: 200, borderRadius: 8, borderWidth: 1, borderColor: c.border }} /> : null}
        </View>
        {matching.map((project) => {
          const scope = view.binding.projects.find((p) => p.slug === project.slug);
          const leads = scope?.leads ?? [];
          const writable = scope && ["observe", "message", "open_lane"].every((op) => scope.grants.includes(op as never));
          const status = scope ? statusOf(scope.id) : undefined;
          const waiting = scope ? needs(scope.name) : 0;
          return <View key={project.slug} style={card}>
            <View style={row}>
              <View style={{ flex: 1, minWidth: 160, gap: 2, ...(compact ? { flexBasis: "100%" as const } : {}) }}>
                <Text style={{ ...text, fontWeight: "600", fontSize: 16 }}>{scope?.name ?? nameOfRoot(project.root)}</Text>
                <Text selectable numberOfLines={1} ellipsizeMode="head" style={{ ...muted, fontSize: 12 }}>{project.root}</Text>
              </View>
              {writable && canCompose ? <Button label="New work" theme={theme} onPress={() => setAim({ root: project.root, at: Date.now() })} /> : null}
              {scope && !writable ? <Button label="Allow coordination" theme={theme} disabled={busy} onPress={() => void giveAccess(scope.id)} /> : null}
            </View>
            <Text style={{ ...muted, fontSize: 13, color: waiting ? c.statusWarning : c.foregroundMuted }}>{!scope ? "Not connected to your Supervisor" : !writable ? "Observe only" : status ?? (leads.length ? "Reading status…" : "No work yet")}{waiting ? ` · ${waiting} ${waiting === 1 ? "update needs" : "updates need"} a look` : ""}</Text>
            {scope && view.problems[scope.id] ? <Text selectable style={{ ...text, color: c.statusDanger }}>{view.problems[scope.id]}</Text> : null}
            {leads.map((lead) => {
              const agent = view.agents.find((a) => a.id === lead.agent);
              return <Pressable key={lead.agent} accessibilityRole="button" accessibilityLabel={`Open ${agent?.title ?? "Lead"}`} disabled={!onAgent} onPress={() => onAgent?.(lead.agent)}
                style={({ pressed }) => ({ padding: 10, borderRadius: 8, backgroundColor: pressed ? c.surface2 : c.surface0, gap: 2 })}>
                <Text numberOfLines={1} style={text}>{agent?.title ?? "Lead"} <Text style={{ color: agent?.waiting ? c.statusWarning : c.foregroundMuted }}>· {agent?.waiting ? "needs your permission" : agent?.status ?? "unavailable"}</Text></Text>
                <Text numberOfLines={2} style={{ ...muted, fontSize: 13 }}>{lead.objective}</Text>
              </Pressable>;
            })}
            <View style={row}><Button label="Team & models" theme={theme} onPress={() => onSettings(project.slug)} /><Button label="Activity" theme={theme} onPress={() => onFlow(project.slug)} /></View>
          </View>;
        })}
        {query.trim() && !matching.length ? <Text style={muted}>No project matches. Try another name or folder.</Text> : null}
      </View> : <Text style={{ ...muted, textAlign: "center" }}>No projects yet. Choose one in the box above, or use Add project.</Text>}
      <View style={{ ...row, justifyContent: "space-between" }}><Text style={{ ...muted, flex: 1, minWidth: 200, fontSize: 13 }}>Permissions, existing Leads, messages and history.</Text><Button label="Advanced controls" theme={theme} onPress={() => setAdvanced(true)} /></View>
    </>}
    <Modal title="Advanced controls" open={advanced} onOpenChange={setAdvanced}><Modal.Content><SupervisionSettings theme={theme} onFlow={(slug) => { setAdvanced(false); onFlow(slug); }} onAgent={onAgent} /></Modal.Content></Modal>
  </View>;
}

const nameOfRoot = (root: string) => root.split("/").filter(Boolean).pop() ?? root;
