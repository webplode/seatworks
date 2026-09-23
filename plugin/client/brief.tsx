import type { PluginTimelineItemProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { briefRpc, briefLabel, commitTeamFilesRpc, reloadSupervisorRpc, type TeamBrief } from "../shared/brief.ts";
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
    /** The click is the approval: the project gains landing, and the Supervisor is told to land this one line now. */
    land: async (item: Item) => {
      if (!supervisor || !item.scope || !item.lane) throw new Error("Open your Supervisor to land this work.");
      const view = await read({}) as unknown as SupervisionView;
      const scope = view.binding.projects.find((p) => p.id === item.scope);
      if (!scope) throw new Error("This project is no longer supervised.");
      if (!scope.grants.includes("land")) await bind({ ...bindingInput(view.binding, view.binding.active), projects: view.binding.projects.map((p) => ({ id: p.id, grants: p.id === scope.id ? [...new Set([...p.grants, "land" as const, "close_lane" as const])] : p.grants })) });
      await paseo.agents.ref(supervisor).send(`The Human approved landing ${item.lane} in project ${scope.id} (${item.diff ?? "its branch"}). Close that lane with land: true now. If the tests fail or the branch cannot merge cleanly, stop and tell the Human why instead of retrying.`);
    },
    commit: async (item: Item) => { if (!item.scope) throw new Error("Unknown project."); return await commit({ scope: item.scope }); },
  };
}

function ItemCard({ item, theme, supervisor, onAgent }: { item: Item; theme: PluginTheme; supervisor: string | null; onAgent?: (id: string) => void }) {
  const c = theme.colors;
  const actions = useCardActions(supervisor);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const run = async (work: () => Promise<string>) => { setBusy(true); setTrouble(null); try { setDone(await work()); setConfirming(false); } catch (e) { setTrouble(message(e)); } finally { setBusy(false); } };
  const tone = item.kind === "permission" ? c.statusWarning : item.kind === "land" ? c.statusSuccess : item.kind === "tests" || item.kind === "error" ? c.statusDanger : c.foreground;
  const mark = item.kind === "land" ? "✓ " : item.kind === "tests" ? "✗ " : item.kind === "question" ? "? " : "";
  const open = onAgent && item.agent && !item.action ? <Button theme={theme} label={item.kind === "permission" ? "Open agent to answer" : item.kind === "question" ? "Answer" : item.kind === "land" || item.kind === "tests" ? "Open Lead" : "Open conversation"} onPress={() => onAgent(item.agent!)} /> : null;
  return <View style={{ gap: 8, padding: 12, borderWidth: 1, borderRadius: 8, borderColor: item.kind === "land" ? c.statusSuccess : item.kind === "tests" ? c.statusDanger : c.border, backgroundColor: c.surface1 }}>
    <Text style={{ color: tone, fontWeight: "600" }}>{mark}{item.title} <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>· {item.project}</Text></Text>
    {item.diff ? <Text selectable style={{ color: c.foreground, fontFamily: "monospace", fontSize: 12 }}>{item.diff}</Text> : null}
    <Text selectable numberOfLines={4} style={{ color: c.foregroundMuted, lineHeight: 20 }}>{item.detail}</Text>
    {trouble ? <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{trouble}</Text> : null}
    {done ? <Text style={{ color: c.foregroundMuted }}>{done}</Text> : confirming ? <View style={{ gap: 8 }}>
      <Text style={{ color: c.foreground }}>Land this work on {item.diff?.split(" · ")[0]?.split(" → ")[1] ?? "your branch"}? Your Supervisor merges it and closes this line of work. This also lets the Supervisor land in {item.project} from now on.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button theme={theme} tone="accent" label={busy ? "Asking…" : "Land it"} disabled={busy} onPress={() => void run(async () => { await actions.land(item); return "Your Supervisor is landing it. Follow along in chat."; })} />
        <Button theme={theme} label="Cancel" disabled={busy} onPress={() => setConfirming(false)} />
      </View>
    </View> : <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {item.action === "reload" ? <Button theme={theme} tone="accent" label={busy ? "Reloading…" : "Reload Supervisor"} disabled={busy} onPress={() => void run(async () => { await actions.reload(); return "Reloaded. Send your last message again."; })} /> : null}
      {item.kind === "land" && supervisor ? <Button theme={theme} tone="accent" label="Land…" onPress={() => setConfirming(true)} /> : null}
      {item.kind === "commit" ? <Button theme={theme} tone="accent" label={busy ? "Committing…" : `Commit ${item.files?.join(" & ") ?? "files"}`} disabled={busy} onPress={() => void run(async () => { const r = await actions.commit(item); return r.committed.length ? `Committed ${r.committed.join(" and ")}.` : "Nothing left to commit."; })} /> : null}
      {open}
    </View>}
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

function BriefContent({ data, error, theme, onAgent }: { data: TeamBrief | null; error: string | null; theme: PluginTheme; onAgent?: (id: string) => void }) {
  const c = theme.colors;
  if (error || !data) return <Text accessibilityRole={error ? "alert" : "text"} style={{ color: error ? c.statusDanger : c.foregroundMuted }}>{error ?? "Reading team status…"}</Text>;
  return <View style={{ gap: 14 }}>
    <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}>{briefLabel(data)}</Text>
    {!data.active ? <Text style={{ color: c.foregroundMuted }}>Supervision is paused. Open Overall Supervisor to resume your selected projects.</Text> : <>
      {data.projects.map(p => <View key={p.id} style={{ gap: 3 }}>
        <Text style={{ color: c.foreground, fontWeight: "600" }}>{p.name} <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>· {p.status}</Text></Text>
        {(p.streams ?? []).map(s => <Pressable key={s.id} accessibilityRole="button" accessibilityLabel={`Open the Lead of ${s.title}`} disabled={!onAgent || !s.agent} onPress={() => s.agent && onAgent?.(s.agent)}
          style={{ flexDirection: "row", gap: 8, alignItems: "center", paddingVertical: 2 }}>
          <Text style={{ color: s.state === "ready to land" ? c.statusSuccess : s.state === "tests failed" ? c.statusDanger : c.accent }}>●</Text>
          <Text numberOfLines={1} style={{ color: c.foreground, flexShrink: 1 }}>{s.title}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{s.state}</Text>
        </Pressable>)}
      </View>)}
      {data.items.map(item => <ItemCard key={item.id} item={item} theme={theme} supervisor={data.supervisor} onAgent={onAgent} />)}
      {data.omitted ? <Text style={{ color: c.foregroundMuted }}>{data.omitted} more updates. Open the project's Activity view for details.</Text> : null}
      {!data.items.length ? <Text style={{ color: c.foregroundMuted }}>{data.lines ? "Nothing needs you right now. The team keeps going and asks here when it does." : "Nothing is running. Tell your Supervisor what to work on next."}</Text> : null}
      {data.held ? <Text style={{ color: c.foregroundMuted }}>{data.held} messages are waiting for their recipients. Delivery is not an answer or completion.</Text> : null}
    </>}
  </View>;
}

export function TeamActivity({ theme, layout, navigation }: PluginWorkspacePanelProps) {
  const { data, error } = useBrief();
  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 24, fontWeight: "600" }}>Team activity</Text>
    {data?.supervisor && navigation ? <Button theme={theme} label="Back to Supervisor chat" tone="accent" onPress={() => navigation.openAgent({ agentId: data.supervisor! })} /> : null}
    <BriefContent data={data} error={error} theme={theme} onAgent={navigation ? id => navigation.openAgent({ agentId: id }) : undefined} />
  </ScrollView>;
}

export function TeamStatusCard({ agentId, theme, openActivity }: PluginTimelineItemProps<TeamBrief> & { openActivity(workspace: string): void }) {
  const { data, error } = useBrief();
  const selected = data?.supervisor === agentId;
  return <View style={{ padding: 16, gap: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface1 }}>
    {data && !selected ? <Text style={{ color: theme.colors.foregroundMuted }}>This conversation is no longer the selected Overall Supervisor.</Text> : <BriefContent data={data} error={error} theme={theme} />}
    {selected && data?.workspace ? <Button label="View team & open agents" theme={theme} onPress={() => openActivity(data.workspace!)} /> : null}
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Live team status. Reply to your Supervisor in this chat.</Text>
  </View>;
}
