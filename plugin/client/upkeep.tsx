import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { cleanRpc, decideRpc, migrateRpc, updateRpc } from "../shared/rpc.ts";
import type { CleanItem, CleanView, ContentChange, MigrateView, UpdateView } from "../shared/views.ts";
import { Button } from "./bits.tsx";
import { message } from "./data.ts";

type Busy = "update" | "migrate" | "clean" | "decide" | null;

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const short = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

const KIND: Record<CleanItem["kind"], string> = { seat: "Agent folder", copy: "Working copy", records: "Project records", snapshot: "Copy of guides or skills", backup: "Settings backup" };

/** Picked unless it holds something of the owner's, or cannot go at all. */
const picked = (items: CleanItem[]) => new Set(items.filter((item) => !item.careful && !item.held).map((item) => item.path));

/** `prompts/LEAD.md` reads "Lead prompt", `skills/supervisor/grilling` "grilling skill". */
function unitName(change: ContentChange): string {
  const last = change.unit.split("/").pop() ?? change.unit;
  if (change.kind === "prompt") return `${last.replace(/\.md$/, "").toLowerCase().replace(/^./, (first) => first.toUpperCase())} prompt`;
  if (change.kind === "skill") return `${last} skill`;
  if (change.kind === "team") return "AGENTS.md team section";
  return last;
}

/** The version line: what runs, and what the branch it follows has. */
function versionLine(view: UpdateView | null): { title: string; state: string } {
  if (!view) return { title: "Seatworks", state: "Reading this copy's version." };
  const now = view.version || view.head;
  if (view.updated) return { title: `Seatworks ${now}`, state: `Updated from ${view.updated.from}. The plugin is reloading.` };
  if (view.behind > 0) {
    const title = `Seatworks ${now} → ${view.next && view.next !== now ? view.next : plural(view.behind, "commit")}`;
    return { title, state: view.busy.length > 0 ? `Stop every agent first: ${view.busy.join(", ")}.` : (view.blocked ?? plural(view.behind, "new commit")) };
  }
  if (view.blocked) return { title: `Seatworks ${now} · ${view.head}`, state: view.blocked };
  return { title: `Seatworks ${now} · ${view.head}`, state: view.fetched ? "Up to date." : `Check asks ${view.upstream ?? "its remote"} for anything newer.` };
}

export function UpkeepSection({ theme }: { theme: PluginTheme }) {
  const update = useRpc(updateRpc) as unknown as (input: { apply: boolean; fetch?: boolean }) => Promise<UpdateView>;
  const migrate = useRpc(migrateRpc) as unknown as (input: { apply: boolean }) => Promise<MigrateView>;
  const decide = useRpc(decideRpc) as unknown as (input: { unit: string; choice: "new" | "mine" | "seen" }) => Promise<MigrateView>;
  const clean = useRpc(cleanRpc) as unknown as (input: { remove?: string[] }) => Promise<CleanView>;
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<UpdateView | null>(null);
  const [migrated, setMigrated] = useState<MigrateView | null>(null);
  const [cleaned, setCleaned] = useState<CleanView | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const styles = useMemo(
    () => ({
      scroll: { maxHeight: 280 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderColor: theme.colors.border },
      dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.statusWarning },
      quiet: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.border },
      words: { flex: 1, gap: 2 },
      label: { color: theme.colors.foreground, fontSize: 13 },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      actions: { flexDirection: "row" as const, gap: 6 },
    }),
    [theme],
  );

  const run = async (which: Exclude<Busy, null>, work: () => Promise<void>) => {
    setBusy(which);
    setError(null);
    try {
      await work();
    } catch (problem) {
      setError(message(problem));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void update({ apply: false, fetch: false }).then(setUpdated, () => {});
    void run("migrate", async () => setMigrated(await migrate({ apply: false })));
    // Once per mount: an update reloads the plugin, and this is what the owner needs next.
  }, []);

  const canUpdate = Boolean(updated && !updated.blocked && !updated.updated && updated.behind > 0 && updated.busy.length === 0);
  const line = versionLine(updated);
  const answer = (unit: string, choice: "new" | "mine" | "seen") => void run("decide", async () => setMigrated(await decide({ unit, choice })));

  // Only what needs the owner, one row each.
  const rows: ReactNode[] = [];
  const row = (key: string, warn: boolean, label: string, detail: string | null, actions: ReactNode) =>
    rows.push(
      <View key={key} style={styles.row}>
        <View style={warn ? styles.dot : styles.quiet} />
        <View style={styles.words}>
          <Text style={styles.label}>{label}</Text>
          {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        </View>
        <View style={styles.actions}>{actions}</View>
      </View>,
    );
  for (const failed of migrated?.state.failed ?? []) row(`state:${failed.where}`, true, `${failed.where}: its records could not be upgraded`, failed.error, null);
  const content = migrated?.content ?? [];
  for (const change of content.filter((entry) => entry.kind !== "guide" && entry.kind !== "record")) {
    const name = unitName(change);
    if (change.change === "removed") {
      row(change.unit, false, `${name} was removed`, change.kept ? "Your own copy is kept and still used." : null, <Button label="OK" theme={theme} disabled={busy !== null} onPress={() => answer(change.unit, "seen")} />);
      continue;
    }
    row(
      change.unit,
      !change.kept,
      change.change === "added" ? `New ${name}` : change.kept ? `${name}: the original changed` : `${name} changed`,
      change.kept ? "You keep your own copy." : null,
      <>
        {change.kept || change.keepable ? <Button label="Keep mine" theme={theme} disabled={busy !== null} onPress={() => answer(change.unit, "mine")} /> : null}
        <Button label="Use new" tone="accent" theme={theme} disabled={busy !== null} onPress={() => answer(change.unit, "new")} />
      </>,
    );
  }
  const told = content.filter((entry) => entry.kind === "guide" || entry.kind === "record");
  if (told.length > 0) {
    row(
      "told",
      false,
      "Guides and records changed",
      told.map((entry) => entry.unit).join(", "),
      <Button label="Got it" theme={theme} disabled={busy !== null} onPress={() => void run("decide", async () => {
        let last: MigrateView | null = null;
        for (const entry of told) last = await decide({ unit: entry.unit, choice: "seen" });
        if (last) setMigrated(last);
      })} />,
    );
  }
  const fixes = migrated?.steps.filter((step) => step.auto) ?? [];
  if (fixes.length > 0) {
    row("fixes", true, fixes.map((step) => step.what).join(" · "), fixes.map((step) => step.where).join(", "), <Button label="Fix" tone="accent" theme={theme} disabled={busy !== null} onPress={() => void run("migrate", async () => setMigrated(await migrate({ apply: true })))} />);
  }
  for (const step of migrated?.steps.filter((entry) => !entry.auto) ?? []) row(`${step.where}:${step.what}`, true, `${step.where}: ${step.what}`, step.detail.join(" "), null);
  for (const done of migrated?.done ?? []) row(`done:${done}`, false, done, null, null);

  const items = cleaned?.items ?? [];
  const picks = items.filter((item) => chosen.has(item.path));
  const found = items.reduce((sum, item) => sum + item.bytes, 0);

  return (
    <SettingsSection title="Plugin">
      <SettingsCard>
        <SettingsAction
          label={line.title}
          hint={line.state}
          error={error}
          actionLabel={busy === "update" ? (canUpdate ? "Updating" : "Checking") : canUpdate ? "Update" : "Check"}
          disabled={busy !== null || Boolean(updated?.updated)}
          onPress={() => void run("update", async () => setUpdated(await update({ apply: canUpdate })))}
        />
        {rows.length > 0 ? (
          <ScrollView style={styles.scroll} nestedScrollEnabled>
            <View>{rows}</View>
          </ScrollView>
        ) : null}
      </SettingsCard>

      <SettingsCard>
        <SettingsAction
          label="Clean up"
          hint={!cleaned ? "Folders nothing uses any more." : items.length ? `${plural(items.length, "item")} · ${size(found)}` : "Nothing left behind."}
          actionLabel={busy === "clean" ? (picks.length ? "Removing" : "Scanning") : picks.length ? `Remove ${picks.length}` : cleaned ? "Scan again" : "Scan"}
          disabled={busy !== null}
          onPress={() =>
            void run("clean", async () => {
              const next = await clean(picks.length ? { remove: picks.map((item) => item.path) } : {});
              setCleaned(next);
              setChosen(picks.length ? new Set() : picked(next.items));
              if (next.failed.length) setError(next.failed.map((fail) => `${short(fail.path)}: ${fail.error}`).join("\n"));
            })
          }
        />
        {items.length > 0 ? (
          <ScrollView style={styles.scroll} nestedScrollEnabled>
            <View>
              {items.map((item) => (
                <SettingsSwitch
                  key={item.path}
                  label={`${KIND[item.kind]} · ${short(item.path)}`}
                  hint={`${item.held ? `Kept: ${item.held}` : item.why} · ${size(item.bytes)}`}
                  value={chosen.has(item.path)}
                  disabled={busy !== null || item.held !== null}
                  onValueChange={(on) =>
                    setChosen((current) => {
                      const next = new Set(current);
                      if (on) next.add(item.path);
                      else next.delete(item.path);
                      return next;
                    })
                  }
                />
              ))}
            </View>
          </ScrollView>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
