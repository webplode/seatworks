import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { adoptRpc, bindingRpc, createSupervisorRpc, supervisionRpc, settingsReadRpc, settingsWriteRpc } from "../shared/rpc.ts";
import type { Layer } from "./data.ts";
import { Operation, type Binding, type SupervisionView } from "../shared/supervision.ts";
import { Button } from "./bits.tsx";

export function SupervisionSettings({ theme, onFlow, onAgent }: {
  theme: PluginTheme; onFlow(slug: string): void; onAgent?: (id: string) => void;
}) {
  const read = useRpc(supervisionRpc);
  const bind = useRpc(bindingRpc);
  const adopt = useRpc(adoptRpc);
  const create = useRpc(createSupervisorRpc);
  const readSettings = useRpc(settingsReadRpc);
  const writeSettings = useRpc(settingsWriteRpc);
  const [view, setView] = useState<SupervisionView | null>(null);
  const [draft, setDraft] = useState<Binding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<{ project: string; agent: string } | null>(null);
  const [objective, setObjective] = useState("");
  const [ownership, setOwnership] = useState("");
  const latest = useRef(read);
  latest.current = read;
  const refresh = async () => {
    try { setView(await latest.current({}) as unknown as SupervisionView); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const next = await latest.current({}) as unknown as SupervisionView; if (alive) { setView(next); setError(null); } }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)); }
    };
    void load();
    const timer = setInterval(() => { if (!draft && !busy && !picking) void load(); }, 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, [Boolean(draft), busy, Boolean(picking)]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); setDraft(null); setPicking(null); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const text = { color: theme.colors.foreground, fontSize: 14 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 8 };
  const input = { color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 6, padding: 10, minHeight: 44 };
  const choice = (label: string, selected: boolean, change: () => void) => (
    <Pressable key={label} accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled: busy }} accessibilityLabel={label}
      disabled={busy} onPress={change} style={{ ...row, paddingVertical: 9, paddingHorizontal: 4 }}>
      <Text style={text}>{selected ? "☑" : "☐"} {label}</Text>
    </Pressable>
  );
  return <View style={{ gap: 14, padding: 16, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8 }}>
    <View style={row}>
      <Text style={{ ...text, fontSize: 20, fontWeight: "600", flex: 1 }}>Overall supervision</Text>
      <Button label="Refresh" theme={theme} disabled={busy} onPress={() => void refresh()} />
      {view && !draft ? <Button label="Manage scope" theme={theme} disabled={busy} onPress={() => setDraft({ ...view.binding })} /> : null}
    </View>
    {error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    {!view ? <Text style={muted}>{error ? "Coverage unavailable. Retry after the host connection recovers." : "Reading projects and agents…"}</Text> : <>
      <Text style={muted}>{view.binding.active ? "Active" : "Paused"} · {view.binding.projects.length} selected projects · revision {view.binding.revision}</Text>
      <Text style={text}>{view.supervisors.find((s) => s.id === view.binding.supervisor?.agent)?.title ?? (view.binding.supervisor ? "Selected Supervisor is unavailable" : "No Supervisor selected")}</Text>
      {draft ? <View style={{ gap: 12 }}>
        <Text style={text}>Select one Supervisor</Text>
        {choice("No Supervisor selected", !draft.supervisor, () => setDraft({ ...draft, supervisor: null, active: false }))}
        {view.supervisors.map((s) => choice(`${s.title} · ${s.id}`, draft.supervisor?.agent === s.id,
          () => setDraft({ ...draft, supervisor: { agent: s.id, workspace: s.workspace } })))}
        {!view.binding.supervisor ? <Button label="Create Supervisor in its own workspace" theme={theme} disabled={busy}
          onPress={() => void run(async () => {
            const saved = await bind({ revision: draft.revision, active: false, supervisor: null, projects: draft.projects.map(({ id, grants }) => ({ id, grants })) }) as unknown as Binding;
            await create({ revision: saved.revision });
          })} /> : null}
        <Text style={text}>Projects and granted operations</Text>
        {[...view.candidates, ...draft.projects.filter((p) => !view.candidates.some((c) => c.id === p.id))].map((p) => {
          const scope = draft.projects.find((s) => s.id === p.id);
          const available = view.candidates.some((c) => c.id === p.id);
          return <View key={p.id} style={{ borderTopColor: theme.colors.border, borderTopWidth: 1, paddingTop: 8, gap: 4 }}>
            {choice(`${p.name} · ${p.id}${available ? "" : " · unavailable; remove to reconcile"}`, Boolean(scope), () => setDraft({ ...draft, projects: scope ? draft.projects.filter((s) => s.id !== p.id)
              : [...draft.projects, { ...p, slug: "", grants: ["observe"], leads: [] }] }))}
            <Text style={muted}>{p.root}</Text>
            {scope ? <View style={row}>{Operation.options.map((op) => choice(op.replaceAll("_", " "), scope.grants.includes(op),
              () => setDraft({ ...draft, projects: draft.projects.map((s) => s.id !== p.id ? s : { ...s, grants: s.grants.includes(op) ? s.grants.filter((g) => g !== op) : [...s.grants, op] }) })))}</View> : null}
          </View>;
        })}
        {!view.candidates.length ? <Text style={muted}>No registered projects. Open a project workspace in Paseo, then refresh; discovering it does not grant supervision.</Text> : null}
        {choice("Supervision active", draft.active, () => setDraft({ ...draft, active: !draft.active }))}
        <View style={row}>
          <Button label="Save scope" theme={theme} tone="accent" disabled={busy} onPress={() => void run(() => bind({ revision: draft.revision, active: draft.active, supervisor: draft.supervisor?.agent ?? null, projects: draft.projects.map(({ id, grants }) => ({ id, grants })) }))} />
          <Button label="Cancel" theme={theme} disabled={busy} onPress={() => setDraft(null)} />
        </View>
      </View> : null}
      {!view.binding.projects.length && !draft ? <Text style={muted}>Choose a Supervisor and enroll the projects it should coordinate. Other projects stay outside its scope.</Text> : null}
      {view.binding.projects.map((p) => {
        const candidates = view.agents.filter((a) => a.project === p.id);
        return <View key={p.id} style={{ gap: 10, paddingTop: 12, borderTopWidth: 1, borderColor: theme.colors.border }}>
          <View style={row}><Text style={{ ...text, fontWeight: "600", flex: 1 }}>{p.name}</Text><Button label="Project Flow" theme={theme} onPress={() => onFlow(p.slug)} /></View>
          <Text style={muted}>{p.root}</Text>
          {view.problems[p.id] ? <Text style={{ color: theme.colors.statusDanger }}>{view.problems[p.id]}</Text> : null}
          <Text style={muted}>Communication watch: {view.communication[p.id]?.status ?? "off"} · {view.communication[p.id]?.detail ?? "Shadow assessment is off; Supervisor control works independently."}</Text>
          <Button label={view.communication[p.id]?.status === "off" || !view.communication[p.id] ? "Enable Jev communication shadow" : "Turn off communication shadow"}
            theme={theme} disabled={busy || Boolean(draft) || Boolean(picking)} onPress={() => void run(async () => {
              const settings = await readSettings({ project: p.slug }) as unknown as { status: string; revision: string; values: Layer; error?: string };
              if (settings.status !== "ready") throw new Error(settings.error ?? "Settings unavailable.");
              const communication = settings.values.attention?.communication === "shadow" ? "off" : "shadow";
              const saved = await writeSettings({ project: p.slug, revision: settings.revision, values: { ...settings.values, attention: { ...settings.values.attention, communication } } as never }) as { status: string; error?: string };
              if (saved.status !== "saved") throw new Error(saved.error ?? "Settings changed. Refresh before retrying.");
            })} />
          <Text style={muted}>Shadow uses the configured Jev service and key to assess communication evidence, up to 100 calls per machine per day. Results are recorded; no notifications are sent.</Text>
          {!p.leads.length ? <Text style={muted}>No existing Lead associated. Select an agent below or open work through the Supervisor.</Text> : null}
          {p.leads.map((lead) => {
            const live = candidates.find((a) => a.id === lead.agent);
            const waiting = view.deliveries.filter((d) => d.to === lead.agent && ["queued", "unknown"].includes(d.state));
            const blockers = view.dependencies.filter((d) => d.consumer.agent === lead.agent && !["confirmed", "canceled"].includes(d.state));
            return <View key={lead.agent} style={{ gap: 4 }}>
              <Text style={text}>{live?.title ?? lead.agent} · {live?.status ?? "unavailable"}{live?.waiting ? " · awaiting permission" : ""}</Text>
              <Text style={text}>{lead.objective}</Text>
              <Text style={muted}>{lead.origin === "external" ? "Limited: native observation and messages; desk participation unverified" : "Seatworks managed"} · {lead.ownership.join(", ")}</Text>
              <Text style={muted}>Evidence: {live?.updatedAt ?? "unknown"} · {waiting.length} pending/uncertain commands · {blockers.length} dependencies</Text>
              {onAgent ? <Button label="Open conversation" theme={theme} onPress={() => onAgent(lead.agent)} /> : null}
              {lead.origin === "external" ? <Button label="Remove association" theme={theme} disabled={busy || Boolean(draft)} onPress={() => void run(() => adopt({ revision: view.binding.revision, project: p.id, agent: lead.agent, objective: lead.objective, ownership: lead.ownership, remove: true }))} /> : null}
            </View>;
          })}
          <View style={row}>{candidates.filter((a) => !p.leads.some((l) => l.agent === a.id)).map((a) => <Button key={a.id}
            label={`Associate ${a.capable ? "Lead" : "existing agent"}: ${a.title}`} theme={theme} disabled={busy || Boolean(draft)}
            onPress={() => { setPicking({ project: p.id, agent: a.id }); setObjective(""); setOwnership(""); }} />)}</View>
          {picking?.project === p.id ? <View style={{ gap: 8 }}>
            <Text style={text}>Associate {picking.agent}; its session and configuration stay in place.</Text>
            <TextInput accessibilityLabel="Lead objective" placeholder="Current objective" placeholderTextColor={theme.colors.foregroundMuted} style={input} value={objective} onChangeText={setObjective} editable={!busy} />
            <TextInput accessibilityLabel="Lead ownership" placeholder="Owned paths or globs, separated by commas" placeholderTextColor={theme.colors.foregroundMuted} style={input} value={ownership} onChangeText={setOwnership} editable={!busy} />
            <View style={row}><Button label="Associate Lead" theme={theme} disabled={busy || !objective.trim() || !ownership.trim()} onPress={() => void run(() => adopt({ revision: view.binding.revision, ...picking, objective, ownership: ownership.split(",").map((s) => s.trim()).filter(Boolean) }))} />
              <Button label="Cancel association" theme={theme} disabled={busy} onPress={() => setPicking(null)} /></View>
          </View> : null}
        </View>;
      })}
      {view.dependencies.length ? <View style={{ gap: 8 }}><Text style={{ ...text, fontWeight: "600" }}>Cross-project dependencies</Text>
        {view.dependencies.map((d) => <View key={d.id} style={{ gap: 3 }}><Text style={text}>{d.producer.project} → {d.consumer.project} · {d.state}</Text>
          <Text style={text}>{d.request}</Text><Text style={muted}>Artifact: {d.artifact ?? "awaiting producer"} · Next: {d.checkpoint}</Text></View>)}
      </View> : null}
      {view.deliveries.length ? <View style={{ gap: 8 }}><Text style={{ ...text, fontWeight: "600" }}>Recent deliveries</Text>
        {view.deliveries.slice(0, 12).map((d) => <View key={d.id}><Text selectable style={text}>{d.state} · {d.to} · {d.id}</Text>
          <Text style={muted} numberOfLines={3}>{d.detail ?? d.text}</Text></View>)}
      </View> : null}
    </>}
  </View>;
}
