import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { pathsFindRpc } from "../shared/rpc.ts";
import { message } from "./data.ts";

export type Found = { path: string; label: string; repository: boolean; connected?: boolean };

/** Paseo's Add project, in a plugin: type to search this machine's folders, arrows to move, Enter to pick. */
export function FolderPalette({ theme, connected, busy, onPick, placeholder = "Search folders, or paste a path" }: {
  theme: PluginTheme; connected: Found[]; busy?: boolean; onPick(found: Found): void; placeholder?: string;
}) {
  const find = useRpc(pathsFindRpc);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [cursor, setCursor] = useState(0);
  const [trouble, setTrouble] = useState<string | null>(null);
  const asked = useRef(0);
  const c = theme.colors;
  const text = { color: c.foreground, fontSize: 14 };
  const muted = { color: c.foregroundMuted, fontSize: 13, lineHeight: 20 };
  const typed = query.trim().toLowerCase();
  const mine = connected.filter((f) => !typed || `${f.label} ${f.path}`.toLowerCase().includes(typed));
  const shown = [...mine, ...found.filter((f) => !mine.some((m) => m.path === f.path)).map((f) => ({ ...f, connected: connected.some((m) => m.path === f.path) }))];
  useEffect(() => {
    if (!typed) { setFound([]); setTrouble(null); return; }
    const ticket = ++asked.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await find({ query }) as { folders?: Found[]; error?: string };
          if (ticket !== asked.current) return;
          setTrouble(result.error ?? null); setFound(result.folders ?? []); setCursor(0);
        } catch (e) { if (ticket === asked.current) setTrouble(message(e)); }
      })();
    }, 120);
    return () => clearTimeout(timer);
  }, [query, typed, find]);
  const section = (i: number) => i === 0 && mine.length ? "Your projects" : i === mine.length && shown.length > mine.length ? "Folders on this machine" : null;
  return <View style={{ gap: 10 }}>
    <TextInput accessibilityLabel="Search for a project folder" placeholder={placeholder} placeholderTextColor={c.foregroundMuted} value={query} autoFocus
      onChangeText={(value) => { setQuery(value); setCursor(0); }} editable={!busy} autoCapitalize="none" autoCorrect={false}
      onKeyPress={(e) => {
        const key = (e.nativeEvent as { key?: string }).key;
        if (key === "ArrowDown") { e.preventDefault?.(); setCursor((i) => Math.min(i + 1, Math.max(shown.length - 1, 0))); }
        if (key === "ArrowUp") { e.preventDefault?.(); setCursor((i) => Math.max(i - 1, 0)); }
      }}
      onSubmitEditing={() => { const pick = shown[cursor]; if (pick && !busy) onPick(pick); }}
      style={{ ...text, minHeight: 44, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 }} />
    {trouble ? <Text accessibilityRole="alert" style={{ ...muted, color: c.statusDanger }}>{trouble}</Text> : null}
    <ScrollView accessibilityRole="list" style={{ maxHeight: 340 }} contentContainerStyle={{ gap: 2 }} keyboardShouldPersistTaps="handled">
      {shown.map((f, i) => <View key={f.path}>
        {section(i) ? <Text style={{ ...muted, fontSize: 12, paddingHorizontal: 12, paddingTop: i ? 8 : 0, paddingBottom: 4 }}>{section(i)}</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={`Use ${f.label}`} disabled={busy} onPress={() => onPick(f)} onHoverIn={() => setCursor(i)}
          style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, backgroundColor: i === cursor ? c.surface2 : "transparent" }}>
          <Text numberOfLines={1} ellipsizeMode="head" style={{ ...text, fontWeight: "500" }}>{f.label}{f.connected ? <Text style={muted}>  · in Seatworks</Text> : f.repository ? <Text style={muted}>  · Git</Text> : null}</Text>
          <Text numberOfLines={1} ellipsizeMode="head" style={{ ...muted, fontSize: 12 }}>{f.path}</Text>
        </Pressable>
      </View>)}
      {typed && !shown.length && !trouble ? <Text style={{ ...muted, paddingHorizontal: 12 }}>No folder matches “{query.trim()}”.</Text> : null}
    </ScrollView>
    <Text style={{ ...muted, fontSize: 12 }}>{busy ? "Opening…" : "↑↓ Navigate · ↵ Select · Esc Close"}</Text>
  </View>;
}
