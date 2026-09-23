import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { Source } from "./data.ts";

export const CONTROL = { radius: 6, height: 40, padding: 12, gap: 8, font: 14, pressed: 0.85, faded: 0.5 };

/** `follows` is the label of the role a role follows while nothing is set for it. */
export function sourceLabel(source: Source, layer: "machine" | "project", follows?: string): string {
  if (source === "here") return layer === "machine" ? "Set here" : "Set for this project";
  if (source === "machine") return "From this machine";
  return follows ? `Not set · follows the ${follows}` : "Built-in default";
}

export function Button({ label, theme, tone = "plain", disabled, onPress }: {
  label: string;
  theme: PluginTheme;
  tone?: "plain" | "accent";
  disabled?: boolean;
  onPress(): void;
}) {
  const styles = useMemo(
    () => ({
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: CONTROL.gap,
        minHeight: CONTROL.height,
        paddingHorizontal: CONTROL.padding,
        borderRadius: CONTROL.radius,
        borderWidth: 1,
        borderColor: tone === "accent" ? theme.colors.accent : theme.colors.border,
        backgroundColor: tone === "accent" ? theme.colors.accent : "transparent",
      },
      label: {
        fontSize: CONTROL.font,
        fontWeight: "normal" as const,
        color: tone === "accent" ? theme.colors.accentForeground : theme.colors.foreground,
      },
    }),
    [theme, tone],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, disabled ? { opacity: CONTROL.faded } : pressed ? { opacity: CONTROL.pressed } : null]}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

export function Avatar({ letter, theme }: { letter: string; theme: PluginTheme }) {
  return (
    <View
      style={{
        width: CONTROL.height,
        height: CONTROL.height,
        borderRadius: CONTROL.radius,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{letter.toUpperCase()}</Text>
    </View>
  );
}

export function Chips({ options, chosen, theme, disabled, onToggle }: {
  options: { id: string; label: string }[];
  chosen: string[];
  theme: PluginTheme;
  disabled?: boolean;
  onToggle(id: string, on: boolean): void;
}) {
  const styles = useMemo(
    () => ({
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: CONTROL.gap },
      chip: {
        minHeight: CONTROL.height,
        paddingHorizontal: CONTROL.padding,
        borderRadius: CONTROL.radius,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      on: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      text: { color: theme.colors.foreground, fontSize: CONTROL.font, fontWeight: "normal" as const },
      textOn: { color: theme.colors.accentForeground },
    }),
    [theme],
  );
  return (
    <View style={styles.row}>
      {options.map((option) => {
        const on = chosen.includes(option.id);
        return (
          <Pressable
            key={option.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on, disabled: Boolean(disabled) }}
            accessibilityLabel={option.label}
            disabled={disabled}
            style={({ pressed }) => [styles.chip, on ? styles.on : null, disabled ? { opacity: CONTROL.faded } : pressed ? { opacity: CONTROL.pressed } : null]}
            onPress={() => onToggle(option.id, !on)}
          >
            <Text style={[styles.text, on ? styles.textOn : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Empty({ title, body, theme }: { title: string; body: string; theme: PluginTheme }) {
  const styles = useMemo(
    () => ({
      box: { padding: 24, gap: 6, alignItems: "center" as const },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "500" as const },
      body: { color: theme.colors.foregroundMuted, fontSize: 14, textAlign: "center" as const },
    }),
    [theme],
  );
  return (
    <View style={styles.box}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
    </View>
  );
}

/** A capitalised group heading, shared by the Health tab and the watch card. */
export function Heading({ text, theme, tone = "muted" }: { text: string; theme: PluginTheme; tone?: "muted" | "danger" }) {
  return (
    <View style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 }}>
      <Text style={{ color: tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500", letterSpacing: 0.6, textTransform: "uppercase" }}>{text}</Text>
    </View>
  );
}

export function Rule({ theme }: { theme: PluginTheme }) {
  return <View style={{ height: 1, backgroundColor: theme.colors.border }} />;
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Tag({ text, color, theme }: { text: string; color: string; theme: PluginTheme }) {
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: theme.colors.surface2 }}>
      <Text style={{ color, fontSize: 12, fontWeight: "500" }}>{text}</Text>
    </View>
  );
}
