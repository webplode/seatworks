import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { bindingRpc, createSupervisorRpc, supervisionRpc, teamRpc } from "../shared/rpc.ts";
import type { SupervisionView } from "../shared/supervision.ts";
import { Button } from "./bits.tsx";
import type { Catalog, Layer, ProjectRow, TeamView } from "./data.ts";
import { message } from "./data.ts";
import { roleChoice } from "./role-choice.tsx";
import { bindingInput } from "./project-setup.ts";
import { SupervisionSettings } from "./supervision-settings.tsx";

export function SupervisionPanel({ theme, compact, catalog, machine, projects, onAdd, onSettings, onFlow, onAgent }: {
  theme: PluginTheme; compact: boolean; catalog: Catalog; machine: Layer; projects: ProjectRow[];
  onAdd(): void; onSettings(slug: string): void; onFlow(slug: string): void; onAgent?: (id: string) => void;
}) {
  const read = useRpc(supervisionRpc), bind = useRpc(bindingRpc), create = useRpc(createSupervisorRpc);
  const readTeam = useRpc(teamRpc);
  const [team, setTeam] = useState<TeamView | null>(null);
  const paseo = usePaseo();
  const [view, setView] = useState<SupervisionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [objective, setObjective] = useState("");
  const [uncertain, setUncertain] = useState<string | null>(null);
  const latest = useRef(read); latest.current = read;
  const refresh = async () => { try { setView(await latest.current({}) as unknown as SupervisionView); setError(null); } catch (e) { setError(message(e)); } };
  useEffect(() => {
    let alive = true;
    const load = async () => { try { const next = await latest.current({}) as unknown as SupervisionView; if (alive) setView(next); } catch (e) { if (alive) setError(message(e)); } };
    void load(); const timer = setInterval(() => { if (!busy && !advanced) void load(); }, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [busy, advanced, projects]);
  const teamReader = useRef(readTeam); teamReader.current = readTeam;
  const targetSlug = view?.binding.projects.find((p) => p.id === target)?.slug;
  useEffect(() => {
    setTeam(null); if (!targetSlug) return;
    let alive = true;
    void teamReader.current({ project: targetSlug }).then((result) => { if (alive) setTeam(result as unknown as TeamView); }).catch((e) => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, [targetSlug]);
  const start = async () => {
    setBusy(true); setError(null);
    try {
      let next = await read({}) as unknown as SupervisionView;
      if (target !== "supervisor") {
        const project = next.binding.projects.find((p) => p.id === target);
        if (!project || !["observe", "message", "open_lane"].every((op) => project.grants.includes(op as never))) throw new Error("Enable Coordinate work for this project in Advanced controls before starting work.");
      }
      if (!next.binding.supervisor) { await create({ revision: next.binding.revision }); next = await read({}) as unknown as SupervisionView; }
      const supervisor = next.binding.supervisor?.agent;
      if (!supervisor) throw new Error("Supervisor was not available. Refresh and try again.");
      if (!next.binding.active && next.binding.projects.length) { await bind(bindingInput(next.binding, true)); }
      if (target !== "supervisor") {
        const project = next.binding.projects.find((p) => p.id === target)!;
        try { await paseo.agents.ref(supervisor).send(`Human objective for project ${project.id} (${project.root}):\n${objective.trim()}\n\nInspect current activity. Reuse a suitable existing Lead, or open a new isolated work lane with the project's configured team. Coordinate the work and report progress here.`); }
        catch (e) { setUncertain(supervisor); throw new Error(`Delivery could not be confirmed. Open the Supervisor conversation before sending again. ${message(e)}`); }
      }
      setTarget(null); setObjective(""); await refresh(); onAgent?.(supervisor);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const c = theme.colors;
  const text = { color: c.foreground, fontSize: 14, lineHeight: 21 };
  const muted = { ...text, color: c.foregroundMuted };
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 10 };
  const card = { padding: compact ? 16 : 22, gap: 16, borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.surface1 };
  const role = catalog.roles.find((r) => r.can.includes("supervise"));
  const choice = role ? roleChoice(catalog, role, machine, {}) : null;
  const supervisor = view?.binding.supervisor;
  const liveSupervisor = view?.supervisors.find((s) => s.id === supervisor?.agent);
  const runtimeLabel = (agent: { provider: string; model: string | null; thinking: string | null }) => `${catalog.harnesses.find((h) => agent.provider === h.id || agent.provider.endsWith(`-${h.id}`))?.label ?? agent.provider} · ${agent.model ?? "Provider default"}${agent.thinking ? ` · ${agent.thinking}` : ""}`;
  const launch = (id: string) => { setTarget(id); setObjective(""); setError(null); setUncertain(null); };
  return <View style={{ gap: 28, width: "100%", maxWidth: 1120, alignSelf: "center", paddingVertical: 12 }}>
    <View style={row}>
      <View style={{ flex: 1, minWidth: 200, gap: 6 }}><Text style={{ ...text, fontSize: 28, lineHeight: 34, fontWeight: "600" }}>Seatworks</Text><Text style={muted}>One supervisor. All your projects.</Text></View>
      <Button label="Team defaults" theme={theme} onPress={() => onSettings("machine")} />
      {projects.length ? <Button label="Add project" theme={theme} tone="accent" onPress={onAdd} /> : null}
    </View>
    {error && !target ? <View style={{ gap: 8 }}><Text accessibilityRole="alert" style={{ ...text, color: c.statusDanger }}>{error}</Text><Button label="Try again" theme={theme} onPress={() => void refresh()} /></View> : null}
    {!view ? <Text style={muted}>Loading your workspace…</Text> : <>
      <View style={card}>
        <View style={row}><View style={{ flex: 1, minWidth: 200, gap: 6 }}>
          <Text style={{ ...text, fontWeight: "600", fontSize: 17 }}>Overall Supervisor</Text>
          <Text style={muted}>{supervisor ? view.binding.active ? "Active · coordinating your selected projects" : "Paused · open the conversation or start work to continue" : "Ready when you are · starts with your first objective"}</Text>
          {liveSupervisor ? <Text style={muted}>{runtimeLabel(liveSupervisor)}</Text> : null}
          {!supervisor ? <Text style={muted}>Launch model: {choice?.harness?.label ?? "Not configured"} · {choice?.model || "Provider default"}{choice?.thinking ? ` · ${choice.thinking}` : ""}</Text> : null}
        </View>
        {supervisor ? <Button label="Open Supervisor" theme={theme} disabled={!onAgent} onPress={() => onAgent?.(supervisor.agent)} /> : projects.length ? <Button label="Start Supervisor" theme={theme} onPress={() => launch("supervisor")} /> : null}</View>
      </View>
      {!projects.length ? <View style={{ ...card, paddingVertical: 38, gap: 22 }}>
        <View style={{ gap: 8 }}><Text style={{ ...text, fontSize: 23, lineHeight: 30, fontWeight: "600" }}>Bring your first project</Text><Text style={{ ...muted, maxWidth: 580 }}>Choose a local folder and its team. Give your Supervisor an objective; it coordinates Leads across your projects.</Text></View>
        <View style={{ ...row, gap: 24 }}>{["01  Choose folder", "02  Choose models", "03  Start work"].map((label) => <Text key={label} style={muted}>{label}</Text>)}</View>
        <View style={row}><Button label="Add first project" theme={theme} tone="accent" onPress={onAdd} /></View>
      </View> : <View style={{ gap: 12 }}>
        <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Projects · {projects.length}</Text>
        <TextInput accessibilityLabel="Find a project" placeholder="Find a project by name or folder…" placeholderTextColor={c.foregroundMuted} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} style={{ ...text, padding: 12, minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: c.border }} />
        {projects.filter((p) => `${p.root} ${view.binding.projects.find((s) => s.slug === p.slug)?.name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())).map((project) => {
          const scope = view.binding.projects.find((p) => p.slug === project.slug);
          const leads = scope?.leads ?? [];
          const writable = scope && ["observe", "message", "open_lane"].every((op) => scope.grants.includes(op as never));
          return <View key={project.slug} style={card}>
            <View style={row}><View style={{ flex: 1, minWidth: 160, gap: 4, ...(compact ? { flexBasis: "100%" as const } : {}) }}><Text style={{ ...text, fontWeight: "600", fontSize: 18 }}>{scope?.name ?? project.root.split("/").pop()}</Text><Text selectable style={{ ...muted, fontSize: 12 }}>{project.root}</Text></View>
              <Button label={writable ? "Start work" : "Configure access"} tone={writable ? "accent" : "plain"} theme={theme} onPress={() => writable ? launch(scope.id) : setAdvanced(true)} />
            </View>
            {scope && view.problems[scope.id] ? <Text style={{ ...text, color: c.statusDanger }}>{view.problems[scope.id]}</Text> : null}
            {!leads.length ? <Text style={muted}>{writable ? "No work started yet. Your Supervisor will open a Lead when needed." : scope ? "Observation only" : "Not connected to supervision"}</Text> : leads.map((lead) => {
              const agent = view.agents.find((a) => a.id === lead.agent);
              return <View key={lead.agent} style={{ ...row, ...(compact ? { flexDirection: "column" as const, alignItems: "stretch" as const } : {}) }}><View style={{ flex: 1, minWidth: 180 }}><Text style={text}>{agent?.title ?? "Lead"} · {agent?.waiting ? "Needs permission" : agent?.status ?? "Unavailable"}</Text><Text numberOfLines={2} style={muted}>{lead.objective}</Text>{agent ? <Text style={{ ...muted, fontSize: 12 }}>{runtimeLabel(agent)}</Text> : null}</View><Button label="Open Lead" theme={theme} disabled={!onAgent} onPress={() => onAgent?.(lead.agent)} /></View>;
            })}
            <View style={row}><Button label="Team & models" theme={theme} onPress={() => onSettings(project.slug)} /><Button label="Activity" theme={theme} onPress={() => onFlow(project.slug)} /></View>
          </View>;
        })}
        {query.trim() && !projects.some((p) => `${p.root} ${view.binding.projects.find((s) => s.slug === p.slug)?.name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())) ? <Text style={muted}>No matching projects. Try another name or folder.</Text> : null}
      </View>}
      <View style={{ ...row, justifyContent: "space-between" }}><Text style={{ ...muted, flex: 1, minWidth: 200 }}>Manage permissions, existing Leads, communication and delivery history.</Text><Button label="Advanced controls" theme={theme} onPress={() => setAdvanced(true)} /></View>
    </>}
    <Modal title="Advanced controls" open={advanced} onOpenChange={setAdvanced}><Modal.Content><SupervisionSettings theme={theme} onFlow={(slug) => { setAdvanced(false); onFlow(slug); }} onAgent={onAgent} /></Modal.Content></Modal>
    <Modal title={target === "supervisor" ? "Start your Supervisor" : "What should we work on?"} open={target !== null} onOpenChange={(open) => { if (!open && !busy) setTarget(null); }}><Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>
      <View style={{ padding: 24, gap: 18 }}>
        <Text style={muted}>{target === "supervisor" ? "Open the shared conversation for planning across your projects." : `Project: ${view?.binding.projects.find((p) => p.id === target)?.name ?? ""}. Your Supervisor will use this project's configured team and models.`}</Text>
        <Text style={text}>{supervisor ? "Uses your existing Supervisor session." : `Supervisor launch: ${choice?.harness?.label ?? "Not configured"} · ${choice?.model || "Provider default"}${choice?.thinking ? ` · ${choice.thinking}` : ""}`}</Text>
        {!supervisor ? <Button label="Change Supervisor model" theme={theme} onPress={() => { setTarget(null); onSettings("machine"); }} /> : null}
        {targetSlug ? <View style={{ gap: 6 }}>{team ? catalog.roles.filter((r) => r.can.includes("lead") || r.can.includes("write") || r.can.includes("review")).map((r) => { const selected = team.roles[r.id]; return selected ? <Text key={r.id} style={muted}>{r.label}: {runtimeLabel(selected)}</Text> : null; }) : <Text style={muted}>Reading project models…</Text>}<Button label="Change project models" theme={theme} disabled={busy} onPress={() => { setTarget(null); onSettings(targetSlug); }} /></View> : null}
        {target !== "supervisor" ? <TextInput accessibilityLabel="Work objective" placeholder="Describe the outcome you want…" placeholderTextColor={c.foregroundMuted} multiline value={objective} onChangeText={setObjective} editable={!busy && !uncertain} style={{ ...text, minHeight: 140, padding: 14, borderRadius: 8, borderWidth: 1, borderColor: c.border, textAlignVertical: "top" }} /> : null}
        <Text style={muted}>Starting resumes supervision for the selected projects. You will continue in the Supervisor conversation.</Text>
        {team?.errors.map((problem) => <Text key={problem} style={{ ...text, color: c.statusDanger }}>{problem}</Text>)}
        {error ? <Text accessibilityRole="alert" style={{ ...text, color: c.statusDanger }}>{error}</Text> : null}
      </View>
        <View style={{ ...row, justifyContent: "flex-end", padding: 16, borderTopWidth: 1, borderColor: c.border }}><Button label="Cancel" theme={theme} disabled={busy} onPress={() => setTarget(null)} />{uncertain ? <Button label="Open Supervisor" theme={theme} disabled={!onAgent} onPress={() => onAgent?.(uncertain)} /> : <Button label={busy ? "Starting…" : target === "supervisor" ? "Start Supervisor" : "Send to Supervisor"} theme={theme} tone="accent" disabled={busy || (target !== "supervisor" && (!objective.trim() || !team || team.errors.length > 0))} onPress={() => void start()} />}</View>
    </Modal.Content></Modal>
  </View>;
}
