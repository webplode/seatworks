import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button } from "./bits.tsx";
import { TabBar } from "./tabs.tsx";

export type DetailTab = "team" | "flow" | "mcp" | "health" | "plugin";

type Props = {
  title: string;
  subtitle: string;
  tab: DetailTab;
  theme: PluginTheme;
  disabled: boolean;
  onBack(): void;
  onTab(tab: DetailTab): void;
  onDetach?: () => void;
  children: ReactNode;
};

export function Detail({ title, subtitle, tab, theme, disabled, onBack, onTab, onDetach, children }: Props) {
  const [detaching, setDetaching] = useState(false);
  const styles = useMemo(
    () => ({
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
      back: { minWidth: 32, minHeight: 32, alignItems: "center" as const, justifyContent: "center" as const },
      backText: { color: theme.colors.foregroundMuted, fontSize: 20 },
      titles: { flex: 1, gap: 4 },
      title: { color: theme.colors.foreground, fontSize: 20, fontWeight: "600" as const },
      sub: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [theme],
  );
  return (
    <View style={{ gap: 16 }}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to the project list" style={styles.back} onPress={onBack}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.titles}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.sub} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {onDetach && !detaching ? <Button label="Detach…" theme={theme} disabled={disabled} onPress={() => setDetaching(true)} /> : null}
      </View>
      {onDetach && detaching ? (
        <View accessibilityRole="alert" style={{ gap: 8, padding: 12, borderWidth: 1, borderRadius: 8, borderColor: theme.colors.statusDanger, backgroundColor: theme.colors.surface1 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Stop the team working on {title}?</Text>
          <Text style={{ color: theme.colors.foregroundMuted, lineHeight: 20 }}>Seatworks forgets this project's team settings and your Supervisor stops looking after it. Your files and their history stay as they are, and you can add the project again later.</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button label="Detach project" tone="danger" theme={theme} disabled={disabled} onPress={() => { setDetaching(false); onDetach(); }} />
            <Button label="Keep it" theme={theme} disabled={disabled} onPress={() => setDetaching(false)} />
          </View>
        </View>
      ) : null}
      <TabBar
        theme={theme}
        active={tab}
        disabled={disabled}
        onPick={(id) => onTab(id as DetailTab)}
        tabs={[
          { id: "team", label: "Team" },
          { id: "flow", label: "Flow" },
          { id: "mcp", label: "MCP" },
          { id: "health", label: "Health" },
          { id: "plugin", label: "Plugin" },
        ]}
      />
      {children}
    </View>
  );
}
