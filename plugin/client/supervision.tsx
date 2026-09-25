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
import { message, shortPath } from "./data.ts";
import { roleChoice } from "./role-choice.tsx";
import { bindingInput, workGrants } from "./project-setup.ts";
import { SupervisionSettings } from "./supervision-settings.tsx";

export function SupervisionPanel({ theme, compact, catalog, machine, projects, available = [], listFolders, attach, onChanged, added, onAdd, onSettings, onFlow, onAgent, onReview }: {
  theme: PluginTheme; compact: boolean; catalog: Catalog; machine: Layer; projects: ProjectRow[]; available?: PaseoProject[];
  listFolders?: (path?: string) => Promise<Folders | { error: string }>; attach?: (root: string, values: Layer) => Promise<string | null>; onChanged?: () => void;
  added?: { slug: string; at: number } | null; onAdd(): void; onSettings(slug: string): void; onFlow(slug: string): void; onAgent?: (id: string) => void;
  /** Opens the Supervisor's chat with the cards to approve beside it. */
  onReview?: (supervisor: string, workspace: string | null) => void;
}) {
  const read = useRpc(supervisionRpc), bind = useRpc(bindingRpc), create = useRpc(createSupervisorRpc), reloadSupervisor = useRpc(reloadSupervisorRpc);
  const { data: brief } = useBrief();
  const [view, setView] = useState<SupervisionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [query, setQuery] = useState("");
  const [aim, setAim] = useState<{ root: string; at: number } | null>(null);
  const [welcome, setWelcome] = useState<string | null>(null);
  // A project just added: the composer points at it, and the screen says what comes next.
  useEffect(() => {
    const project = added && projects.find((p) => p.slug === added.slug);
    if (!project) return;
    setAim({ root: project.root, at: added!.at });
    setWelcome(nameOfRoot(project.root));
  }, [added, projects]);
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
  const runtimeLabel = (agent: { provider: string; model: string | null; thinking: string | null }) => { const harness = catalog.harnesses.find((h) => agent.provider === h.id || agent.provider.endsWith(`-${h.id}`)); return `${harness?.label ?? agent.provider} · ${harness?.models.find((m) => m.id === agent.model)?.label ?? agent.model ?? "default model"}`; };
  const supervisorLine = liveSupervisor ? `Runs on ${runtimeLabel(liveSupervisor)}` : choice?.harness ? `Runs on ${choice.harness.label} · ${choice.harness.models.find((m) => m.id === choice.model)?.label ?? choice.model ?? "default model"}` : "No AI chosen for the Supervisor yet";
  const giveAccess = async (id: string) => {
    if (!view) return;
    setBusy(true); setError(null);
    try { await bind({ ...bindingInput(view.binding, view.binding.active), projects: view.binding.projects.map((p) => ({ id: p.id, grants: p.id === id ? [...new Set([...p.grants, ...workGrants])] : p.grants })) }); await refresh(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const statusOf = (id: string) => brief?.projects.find((p) => p.id === id)?.status;
  // What the card's status line does not already say: approvals are counted there.
  const needs = (name: string) => brief?.items.filter((item) => item.project === name && !["plan", "land", "commit", "review"].includes(item.kind)).length ?? 0;
  const approvals = (name: string) => brief?.items.filter((item) => item.project === name && (item.kind === "plan" || item.kind === "land" || item.kind === "commit")).length ?? 0;
  const review = supervisor && onReview ? () => onReview(supervisor.agent, brief?.workspace ?? null) : undefined;
  const matching = projects.filter((p) => `${p.root} ${view?.binding.projects.find((s) => s.slug === p.slug)?.name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const canCompose = Boolean(listFolders && attach && view);
  return <View style={{ gap: 24, width: "100%", maxWidth: 880, alignSelf: "center", paddingVertical: 12 }}>
    <View style={row}>
      <View style={{ flex: 1, minWidth: 160, gap: 2 }}><Text style={{ ...text, fontSize: 17, fontWeight: "600" }}>Seatworks</Text><Text style={{ ...muted, fontSize: 13 }}>One Supervisor for all your projects.</Text></View>
      <Button label="Models for all projects" theme={theme} onPress={() => onSettings("machine")} />
      <Button label="Add project" theme={theme} onPress={onAdd} />
    </View>
    {welcome ? <View accessibilityRole="alert" style={{ ...row, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.accent, backgroundColor: c.surface1 }}>
      <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
        <Text style={{ ...text, fontWeight: "600" }}>✓ {welcome} is added</Text>
        <Text style={{ ...muted, fontSize: 13 }}>Next, tell the team what you want in the box below and press Start. Your Supervisor plans it, the team does it, and you approve the result before anything is merged.</Text>
      </View>
      <Button label="Got it" theme={theme} onPress={() => setWelcome(null)} />
    </View> : null}
    {error ? <View style={{ gap: 8 }}><Text accessibilityRole="alert" selectable style={{ ...text, color: c.statusDanger }}>{error}</Text><Button label="Try again" theme={theme} onPress={() => void refresh()} /></View> : null}
    {!view ? <Text style={muted}>Loading your workspace…</Text> : <>
      {canCompose ? <Composer theme={theme} compact={compact} catalog={catalog} machine={machine} view={view} projects={projects} available={available} listFolders={listFolders!} attach={attach!}
        onChanged={() => { onChanged?.(); void refresh(); }} onSettings={onSettings} onAgent={onAgent} onAccess={(id) => void giveAccess(id)} supervisorLine={supervisorLine} aim={aim}
          signIn={brief?.signIn ?? null} onReload={async () => { await reloadSupervisor({}); }} /> : null}
      <View style={{ ...card, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
        <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
          <Text style={{ ...text, fontWeight: "600" }}>Your Supervisor <Text style={{ ...muted, fontWeight: "400" }}>· {supervisor ? view.binding.active ? brief ? briefLabel(brief) : "on" : "paused" : "starts when you give the team its first task"}</Text></Text>
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
          const ready = scope ? approvals(scope.name) : 0;
          const streams = scope ? brief?.projects.find((p) => p.id === scope.id)?.streams ?? [] : [];
          // Leads Seatworks did not start have no stream of their own.
          const others = leads.filter((lead) => !streams.some((s) => s.agent === lead.agent));
          return <View key={project.slug} style={card}>
            <View style={row}>
              <View style={{ flex: 1, minWidth: 160, gap: 2, ...(compact ? { flexBasis: "100%" as const } : {}) }}>
                <Text style={{ ...text, fontWeight: "600", fontSize: 16 }}>{scope?.name ?? nameOfRoot(project.root)}</Text>
                <Text selectable numberOfLines={1} ellipsizeMode="head" style={{ ...muted, fontSize: 12 }}>{shortPath(project.root)}</Text>
              </View>
              {ready && review ? <Button label={ready === 1 ? "Review & approve" : `Review & approve (${ready})`} theme={theme} tone="accent" onPress={review} /> : null}
              {writable && canCompose ? <Button label="New work" theme={theme} onPress={() => setAim({ root: project.root, at: Date.now() })} /> : null}
              {scope && !writable ? <Button label="Let the Supervisor work here" theme={theme} disabled={busy} onPress={() => void giveAccess(scope.id)} /> : null}
            </View>
            <Text style={{ ...muted, fontSize: 13, color: ready || waiting ? c.statusWarning : c.foregroundMuted }}>{!scope ? "Your Supervisor doesn't look after this project yet" : !writable ? "Your Supervisor can only watch this project" : status ?? (leads.length ? "Checking…" : "No work yet · use New work to give the team a task")}{waiting ? ` · ${waiting} more ${waiting === 1 ? "thing" : "things"} to check` : ""}</Text>
            {scope && view.problems[scope.id] ? <Text selectable style={{ ...text, color: c.statusDanger }}>{view.problems[scope.id]}</Text> : null}
            {scope ? brief?.items.filter((item) => item.project === scope.name && item.kind === "commit").map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Review: ${item.title}`} disabled={!review} onPress={review}
              style={({ pressed }) => ({ flexDirection: "row", gap: 8, alignItems: "center", padding: 10, borderRadius: 8, backgroundColor: pressed ? c.surface2 : c.surface0 })}>
              <Text style={{ color: c.statusSuccess }}>●</Text>
              <Text numberOfLines={1} style={{ ...text, flexShrink: 1 }}>{item.title.replace(/\?$/, "")}</Text>
              <Text style={{ ...muted, fontSize: 13 }}>· ready for you</Text>
            </Pressable>) : null}
            {streams.map((stream) => <Pressable key={stream.id} accessibilityRole="button" accessibilityLabel={`Open the work chat for ${stream.title}`} disabled={!onAgent || !stream.agent} onPress={() => stream.agent && onAgent?.(stream.agent)}
              style={({ pressed }) => ({ flexDirection: "row", gap: 8, alignItems: "center", padding: 10, borderRadius: 8, backgroundColor: pressed ? c.surface2 : c.surface0 })}>
              <Text style={{ color: stream.state === "ready for you" ? c.statusSuccess : stream.state === "tests failed" ? c.statusDanger : c.accent }}>●</Text>
              <Text numberOfLines={1} style={{ ...text, flexShrink: 1 }}>{stream.title}</Text>
              <Text style={{ ...muted, fontSize: 13 }}>· {stream.state}</Text>
            </Pressable>)}
            {others.map((lead) => {
              const agent = view.agents.find((a) => a.id === lead.agent);
              return <Pressable key={lead.agent} accessibilityRole="button" accessibilityLabel={`Open ${agent?.title ?? "the work chat"}`} disabled={!onAgent} onPress={() => onAgent?.(lead.agent)}
                style={({ pressed }) => ({ padding: 10, borderRadius: 8, backgroundColor: pressed ? c.surface2 : c.surface0, gap: 2 })}>
                <Text numberOfLines={1} style={text}>{lead.objective.split("\n")[0] || agent?.title || "Work"} <Text style={{ color: agent?.waiting ? c.statusWarning : c.foregroundMuted }}>· {agent?.waiting ? "needs your permission" : plainState(agent?.status)}</Text></Text>
              </Pressable>;
            })}
            <View style={row}><Button label="Team & models" theme={theme} onPress={() => onSettings(project.slug)} /><Button label="Activity" theme={theme} onPress={() => onFlow(project.slug)} /></View>
          </View>;
        })}
        {query.trim() && !matching.length ? <Text style={muted}>No project matches. Try another name or folder.</Text> : null}
      </View> : <Text style={{ ...muted, textAlign: "center" }}>No projects yet. Choose one in the box above, or use Add project.</Text>}
      <View style={{ ...row, justifyContent: "space-between" }}><Text style={{ ...muted, flex: 1, minWidth: 200, fontSize: 13 }}>What your Supervisor may do in each project, and its history.</Text><Button label="Advanced controls" theme={theme} onPress={() => setAdvanced(true)} /></View>
    </>}
    <Modal title="Advanced controls" open={advanced} onOpenChange={setAdvanced}><Modal.Content><SupervisionSettings theme={theme} onFlow={(slug) => { setAdvanced(false); onFlow(slug); }} onAgent={onAgent} /></Modal.Content></Modal>
  </View>;
}

const nameOfRoot = (root: string) => root.split("/").filter(Boolean).pop() ?? root;
/** "/Users/me/code/app" → "~/code/app". */
/** An agent's state, as a person says it. */
const plainState = (status?: string) => status === "running" || status === "starting" ? "working" : status === "idle" ? "not working right now" : status === "error" ? "stopped with an error" : status === "closed" ? "finished" : "can't be reached";
