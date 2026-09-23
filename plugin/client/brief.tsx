import type { PluginTimelineItemProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { briefRpc, briefLabel, type TeamBrief } from "../shared/brief.ts";
import { Button } from "./bits.tsx";

function useBrief() {
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
      {data.projects.map(p => <View key={p.id} style={{ gap: 3 }}><Text style={{ color: c.foreground, fontWeight: "600" }}>{p.name}</Text><Text style={{ color: c.foregroundMuted }}>{p.status}</Text></View>)}
      {data.items.map(item => <View key={item.id} style={{ gap: 8, paddingTop: 12, borderTopWidth: 1, borderColor: c.border }}>
        <Text style={{ color: item.kind === "permission" ? c.statusWarning : item.kind === "tests" || item.kind === "error" ? c.statusDanger : c.foreground, fontWeight: "600" }}>{item.title} · {item.project}</Text>
        <Text selectable style={{ color: c.foregroundMuted, lineHeight: 20 }}>{item.detail}</Text>
        {onAgent && item.agent ? <Button theme={theme} label={item.kind === "permission" ? "Open agent to answer" : "Open conversation"} onPress={() => onAgent(item.agent!)} /> : null}
      </View>)}
      {data.omitted ? <Text style={{ color: c.foregroundMuted }}>{data.omitted} more updates. Open the project's Activity view for details.</Text> : null}
      {!data.items.length ? <Text style={{ color: c.foregroundMuted }}>No requests need attention. Give your Supervisor an objective in chat.</Text> : null}
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
