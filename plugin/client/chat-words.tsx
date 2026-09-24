import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PlainLetter, PlainStep } from "../shared/chat-words.ts";
import { supervisionRpc } from "../shared/rpc.ts";
import type { SupervisionView } from "../shared/supervision.ts";

/** Project names by ID, read once for every card in view rather than once per card. */
let names: { at: number; value: Promise<Map<string, string>> } | null = null;
function useProjectName(id: string | null): string | null {
  const read = useRpc(supervisionRpc);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    if (!names || Date.now() - names.at > 30_000) names = { at: Date.now(), value: read({}).then((v) => { const view = v as unknown as SupervisionView; return new Map([...view.candidates, ...view.binding.projects].map((p) => [p.id, p.name])); }).catch(() => new Map()) };
    let alive = true;
    void names.value.then((map) => { if (alive) setName(map.get(id) ?? null); });
    return () => { alive = false; };
  }, [id]);
  return name;
}

function Original({ raw, muted }: { raw: string; muted: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}>
      <Text style={{ color: muted, fontSize: 12 }}>{open ? "▾ Hide the original message" : "▸ Show the original message"}</Text>
    </Pressable>
    {open ? <Text selectable style={{ color: muted, fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}>{raw}</Text> : null}
  </>;
}

/** A message the desk or the Seatworks UI wrote for an agent, as the Human would say it. */
export function TeamLetter({ item, theme }: PluginTimelineItemProps<PlainLetter>) {
  const c = theme.colors, letter = item.data;
  const project = useProjectName(letter.project);
  const heading = letter.mine ? `You asked the team${project ? ` · ${project}` : ""}` : `Team update${project ? ` · ${project}` : ""}`;
  return <View style={{ gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderLeftWidth: 3, borderLeftColor: letter.mine ? c.accent : c.border, backgroundColor: c.surface1, borderRadius: 6 }}>
    <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{heading}</Text>
    {letter.lines.map((line, i) => <Text key={i} style={{ color: c.foreground, lineHeight: 20 }}>{letter.lines.length > 1 ? "• " : ""}{project ? line.split(`"${project}: `).join('"') : line}</Text>)}
    <Original raw={letter.raw} muted={c.foregroundMuted} />
  </View>;
}

/** A call to one of the team's own tools, as one quiet line. */
export function TeamStep({ item, theme }: PluginTimelineItemProps<PlainStep>) {
  const c = theme.colors, step = item.data;
  const [open, setOpen] = useState(false);
  const mark = step.status === "running" ? "…" : step.status === "completed" ? "✓" : "!";
  return <Pressable accessibilityRole="button" accessibilityLabel={step.label} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ gap: 4, paddingVertical: 2 }}>
    <Text style={{ color: step.status === "failed" ? c.statusDanger : c.foregroundMuted, fontSize: 13 }}>{mark} {step.label}</Text>
    {open ? <Text selectable style={{ color: c.foregroundMuted, fontFamily: "monospace", fontSize: 12 }}>{step.raw}</Text> : null}
  </Pressable>;
}
