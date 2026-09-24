import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { gitIdentityRpc } from "../shared/rpc.ts";
import type { Check } from "../shared/views.ts";
import { Button } from "./bits.tsx";
import { message } from "./data.ts";

/** Git signs every saved change with a name and email; asked for here, not as a command to run. */
export function GitIdentity({ theme, project, onSaved }: { theme: PluginTheme; project: string; onSaved(check: Check): void }) {
  const save = useRpc(gitIdentityRpc);
  const [name, setName] = useState(""), [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const c = theme.colors;
  const field = { color: c.foreground, fontSize: 13, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 10, minHeight: 34, flex: 1, minWidth: 160, outlineStyle: "none" } as never;
  const ready = Boolean(name.trim()) && /^\S+@\S+\.\S+$/.test(email.trim()) && !busy;
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const check = await save({ project, name: name.trim(), email: email.trim() }) as Check;
      if (check.ok) onSaved(check); else setError(check.detail);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <View style={{ gap: 6, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: c.statusWarning }}>
    <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>One thing first: who should the team's changes be saved as?</Text>
    <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>Git records a name and email with every change. They are saved for this project only.</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <TextInput accessibilityLabel="Your name" placeholder="Your name" placeholderTextColor={c.foregroundMuted} value={name} onChangeText={setName} style={field} />
      <TextInput accessibilityLabel="Your email" placeholder="you@example.com" placeholderTextColor={c.foregroundMuted} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" style={field} />
      <Button label={busy ? "Saving…" : "Save"} tone="accent" theme={theme} disabled={!ready} onPress={() => void submit()} />
    </View>
    {error ? <Text accessibilityRole="alert" selectable style={{ color: c.statusDanger, fontSize: 12 }}>{error}</Text> : null}
  </View>;
}
