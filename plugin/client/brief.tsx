import type { PluginTimelineItemProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { approvable, briefRpc, briefLabel, commitTeamFilesRpc, count, reloadSupervisorRpc, type TeamBrief } from "../shared/brief.ts";
import { bindingRpc, supervisionRpc } from "../shared/rpc.ts";
import type { SupervisionView } from "../shared/supervision.ts";
import { Button } from "./bits.tsx";
import { message } from "./data.ts";
import { bindingInput } from "./project-setup.ts";

type Item = TeamBrief["items"][number];

/** The Human's own calls from a card: landing a line of work, and committing the team instructions. */
function useCardActions(supervisor: string | null) {
  const paseo = usePaseo();
  const read = useRpc(supervisionRpc), bind = useRpc(bindingRpc), commit = useRpc(commitTeamFilesRpc), reload = useRpc(reloadSupervisorRpc);
  return {
    reload: async () => { await reload({}); },
    /** The click is the approval: each project gains landing, and the Supervisor is told to land these lines now. */
    land: async (items: Item[]) => {
      if (!supervisor || items.some((item) => !item.scope || !item.lane)) throw new Error("Open your Supervisor to land this work.");
      const view = await read({}) as unknown as SupervisionView;
      const scopes = new Set(items.map((item) => item.scope!));
      for (const id of scopes) if (!view.binding.projects.some((p) => p.id === id)) throw new Error("A project here is no longer supervised.");
      if (view.binding.projects.some((p) => scopes.has(p.id) && !p.grants.includes("land"))) await bind({ ...bindingInput(view.binding, view.binding.active), projects: view.binding.projects.map((p) => ({ id: p.id, grants: scopes.has(p.id) ? [...new Set([...p.grants, "land" as const, "close_lane" as const])] : p.grants })) });
      const lines = items.map((item) => `- ${item.lane} in project ${item.scope} (${item.diff ?? "its branch"})${item.stays ? ": it carried on its own branch, so this runs its gate and merges nothing" : ""}`);
      await paseo.agents.ref(supervisor).send(`The Human approved landing ${items.length === 1 ? "this lane" : "these lanes"}. Close each with land: true now, one at a time:\n${lines.join("\n")}\nIf the tests fail or a branch cannot merge cleanly, stop that one and tell the Human why instead of retrying.`);
    },
    commit: async (item: Item) => { if (!item.scope) throw new Error("Unknown project."); return await commit({ scope: item.scope }); },
  };
}

function ItemCard({ item, theme, supervisor, onAgent, onModels }: { item: Item; theme: PluginTheme; supervisor: string | null; onAgent?: (id: string) => void; onModels?: () => void }) {
  const c = theme.colors;
  const actions = useCardActions(supervisor);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const run = async (work: () => Promise<string>) => { setBusy(true); setTrouble(null); try { setDone(await work()); setConfirming(false); } catch (e) { setTrouble(message(e)); } finally { setBusy(false); } };
  const tone = item.kind === "permission" ? c.statusWarning : item.kind === "land" ? c.statusSuccess : item.kind === "tests" || item.kind === "error" ? c.statusDanger : c.foreground;
  const mark = item.kind === "land" ? "✓ " : item.kind === "tests" ? "✗ " : item.kind === "question" ? "? " : "";
  const [more, setMore] = useState(false);
  const open = onAgent && item.agent && !item.action ? <Button theme={theme} label={item.kind === "permission" ? "Open agent to answer" : item.kind === "question" ? "Answer" : item.kind === "land" || item.kind === "tests" ? "Open Lead" : "Open conversation"} onPress={() => onAgent(item.agent!)} /> : null;
  return <View style={{ gap: 8, padding: 12, borderWidth: 1, borderRadius: 8, borderColor: item.kind === "land" ? c.statusSuccess : item.kind === "tests" ? c.statusDanger : c.border, backgroundColor: c.surface1 }}>
    <Text style={{ color: tone, fontWeight: "600" }}>{mark}{item.title} <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>· {item.project}</Text></Text>
    {item.plain ? <>
      <Text style={{ color: c.foreground, lineHeight: 20 }}>{item.plain}</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore(!more)}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{more ? "▾ Hide details" : "▸ Details"}</Text>
      </Pressable>
    </> : null}
    {!item.plain || more ? <>
      {item.diff ? <Text selectable style={{ color: c.foreground, fontFamily: "monospace", fontSize: 12 }}>{item.diff}</Text> : null}
      <Text selectable numberOfLines={item.plain ? undefined : 4} style={{ color: c.foregroundMuted, lineHeight: 20 }}>{item.detail}</Text>
    </> : null}
    {trouble ? <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{trouble}</Text> : null}
    {done ? <Text style={{ color: c.foregroundMuted }}>{done}</Text> : confirming ? <View style={{ gap: 8 }}>
      <Text style={{ color: c.foreground }}>{item.stays
        ? `Finish this work? It stays on ${item.diff?.split(" · ")[0]?.replace("Stays on ", "") ?? "your branch"}: your Supervisor runs its tests and wraps it up, and nothing is merged.`
        : `Merge this work into ${item.diff?.split(" · ")[0]?.split(" → ")[1] ?? "your branch"}? Your Supervisor merges it and wraps it up.`} From now on your Supervisor may also merge work you approve in {item.project}.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button theme={theme} tone="accent" label={busy ? "Asking…" : item.stays ? "Finish it" : "Merge it"} disabled={busy} onPress={() => void run(async () => { await actions.land([item]); return item.stays ? "Your Supervisor is finishing it. Follow along in chat." : "Your Supervisor is merging it. Follow along in chat."; })} />
        <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setConfirming(false)} />
      </View>
    </View> : <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {item.action === "reload" ? <Button theme={theme} tone="accent" label={busy ? "Reloading…" : "Reload Supervisor"} disabled={busy} onPress={() => void run(async () => { await actions.reload(); return "Reloaded. Send your last message again."; })} /> : null}
      {item.action === "models" && onModels ? <Button theme={theme} tone="accent" label="Change models" onPress={onModels} /> : null}
      {item.kind === "land" && supervisor ? <Button theme={theme} tone="accent" label={item.stays ? "Finish…" : "Merge…"} onPress={() => setConfirming(true)} /> : null}
      {item.kind === "commit" ? <Button theme={theme} tone="accent" label={busy ? "Saving…" : "Save them"} disabled={busy} onPress={() => void run(async () => { const r = await actions.commit(item); return r.committed.length ? `Saved ${r.committed.join(" and ")}.` : "Nothing left to save."; })} /> : null}
      {open}
    </View>}
  </View>;
}

/** One click for every card a plain yes settles: team files are committed first, then the Supervisor lands the ready work. */
function ApproveAll({ items, others, theme, supervisor }: { items: Item[]; others: number; theme: PluginTheme; supervisor: string | null }) {
  const c = theme.colors;
  const actions = useCardActions(supervisor);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const lands = items.filter((item) => item.kind === "land"), commits = items.filter((item) => item.kind === "commit");
  const approve = async () => {
    setBusy(true); setTrouble(null);
    const failed: string[] = [];
    for (const item of commits) { try { await actions.commit(item); } catch (e) { failed.push(`${item.project}: ${message(e)}`); } }
    try { if (lands.length) await actions.land(lands); } catch (e) { failed.push(message(e)); }
    setBusy(false); setConfirming(false);
    if (failed.length) setTrouble(`Not everything went through. ${failed.join(" ")}`);
    else setDone(lands.length ? "Approved. Your Supervisor is merging the work; follow along in chat." : "Approved and saved.");
  };
  if (done) return <Text style={{ color: c.foregroundMuted }}>{done}</Text>;
  return <View style={{ gap: 8, padding: 12, borderWidth: 1, borderRadius: 8, borderColor: c.accent, backgroundColor: c.surface1 }}>
    {trouble ? <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{trouble}</Text> : null}
    {confirming ? <>
      <Text style={{ color: c.foreground, fontWeight: "600" }}>You approve all of this:</Text>
      {items.map((item) => <Text key={item.id} style={{ color: c.foreground, lineHeight: 20 }}>• {item.project}: {item.plain ?? item.title}</Text>)}
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{lands.length ? "From now on your Supervisor may also merge work you approve in these projects. " : ""}{others ? `${count(others, "other card")} still ${others === 1 ? "needs" : "need"} your own answer.` : ""}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button theme={theme} tone="accent" label={busy ? "Approving…" : "Approve all"} disabled={busy} onPress={() => void approve()} />
        <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setConfirming(false)} />
      </View>
    </> : <>
      <Text style={{ color: c.foreground }}>{[lands.length ? `${count(lands.length, "piece", "pieces")} of work ready for you` : "", commits.length ? `team instructions to save in ${count(commits.length, "project")}` : ""].filter(Boolean).join(" and ")}. Check them in one go.</Text>
      <View style={{ flexDirection: "row" }}><Button theme={theme} tone="accent" label={`Approve all (${items.length})…`} onPress={() => setConfirming(true)} /></View>
    </>}
  </View>;
}

export function useBrief() {
  const rpc = useRpc(briefRpc), latest = useRef(rpc); latest.current = rpc;
  const [data, setData] = useState<TeamBrief | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, busy = false;
    const load = async () => { if (busy) return; busy = true; try { const value = await latest.current({}); if (alive) { setData(value); setError(null); } } catch { if (alive) setError("Team status is unavailable. Reconnect to refresh."); } finally { busy = false; } };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return { data, error };
}

function BriefContent({ data, error, theme, onAgent, onModels }: { data: TeamBrief | null; error: string | null; theme: PluginTheme; onAgent?: (id: string) => void; onModels?: () => void }) {
  const c = theme.colors;
  if (error || !data) return <Text accessibilityRole={error ? "alert" : "text"} style={{ color: error ? c.statusDanger : c.foregroundMuted }}>{error ?? "Reading team status…"}</Text>;
  return <View style={{ gap: 14 }}>
    <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}>{briefLabel(data)}</Text>
    {!data.active ? <Text style={{ color: c.foregroundMuted }}>Your Supervisor is paused. Open Overall Supervisor to carry on.</Text> : <>
      {data.projects.map(p => <View key={p.id} style={{ gap: 3 }}>
        <Text style={{ color: c.foreground, fontWeight: "600" }}>{p.name} <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>· {p.status}</Text></Text>
        {(p.streams ?? []).map(s => <Pressable key={s.id} accessibilityRole="button" accessibilityLabel={`Open the Lead of ${s.title}`} disabled={!onAgent || !s.agent} onPress={() => s.agent && onAgent?.(s.agent)}
          style={{ flexDirection: "row", gap: 8, alignItems: "center", paddingVertical: 2 }}>
          <Text style={{ color: s.state === "ready for you" ? c.statusSuccess : s.state === "tests failed" ? c.statusDanger : c.accent }}>●</Text>
          <Text numberOfLines={1} style={{ color: c.foreground, flexShrink: 1 }}>{s.title}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{s.state}</Text>
        </Pressable>)}
      </View>)}
      {data.supervisor && data.items.some(approvable) ? <ApproveAll key={data.items.filter(approvable).map((item) => item.id).join()} items={data.items.filter(approvable)} others={data.items.filter((item) => !approvable(item)).length} theme={theme} supervisor={data.supervisor} /> : null}
      {data.items.map(item => <ItemCard key={item.id} item={item} theme={theme} supervisor={data.supervisor} onAgent={onAgent} onModels={onModels} />)}
      {data.omitted ? <Text style={{ color: c.foregroundMuted }}>{count(data.omitted, "more update")}. Open the project to see them.</Text> : null}
      {!data.items.length ? <Text style={{ color: c.foregroundMuted }}>{data.lines ? "Nothing needs you right now. The team keeps going and asks here when it does." : "Nothing is running. Tell your Supervisor what to work on next."}</Text> : null}
      {data.held ? <Text style={{ color: c.foregroundMuted }}>{count(data.held, "message")} {data.held === 1 ? "is" : "are"} waiting for busy teammates to read {data.held === 1 ? "it" : "them"}.</Text> : null}
    </>}
  </View>;
}

export function TeamActivity({ theme, layout, navigation, workspaceId, openTeam }: PluginWorkspacePanelProps & { openTeam(workspace: string): void }) {
  const { data, error } = useBrief();
  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 24, fontWeight: "600" }}>Team activity</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {data?.supervisor && navigation ? <Button theme={theme} label="Back to Supervisor chat" tone="accent" onPress={() => navigation.openAgent({ agentId: data.supervisor! })} /> : null}
      <Button theme={theme} label="Team & models" onPress={() => openTeam(workspaceId)} />
    </View>
    <BriefContent data={data} error={error} theme={theme} onAgent={navigation ? id => navigation.openAgent({ agentId: id }) : undefined} onModels={() => openTeam(workspaceId)} />
  </ScrollView>;
}

export function TeamStatusCard({ agentId, theme, openActivity, openTeam }: PluginTimelineItemProps<TeamBrief> & { openActivity(workspace: string): void; openTeam(workspace: string): void }) {
  const { data, error } = useBrief();
  const selected = data?.supervisor === agentId;
  return <View style={{ padding: 16, gap: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface1 }}>
    {data && !selected ? <Text style={{ color: theme.colors.foregroundMuted }}>This conversation is no longer the selected Overall Supervisor.</Text> : <BriefContent data={data} error={error} theme={theme} onModels={data?.workspace ? () => openTeam(data.workspace!) : undefined} />}
    {selected && data?.workspace ? <Button label="View team & open agents" theme={theme} onPress={() => openActivity(data.workspace!)} /> : null}
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Live team status. Reply to your Supervisor in this chat.</Text>
  </View>;
}
