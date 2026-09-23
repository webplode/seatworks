import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsCard } from "@getpaseo/plugin/client/ui";
import { type ReactNode, memo, useMemo } from "react";
import { Text, View } from "react-native";
import { Button, Dot, Rule, Tag } from "./bits.tsx";
import { type WatchIncident, type WatchLean, type WatchView, incidentLines, jevHeader, leaning, trackRecord } from "./data.ts";

const ago = (minutes: number): string => (minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`);

function useStyles(theme: PluginTheme) {
  return useMemo(
    () => ({
      heading: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500" as const, letterSpacing: 0.6, textTransform: "uppercase" as const, paddingTop: 6 },
      row: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 12, paddingHorizontal: 18, paddingVertical: 12 },
      labels: { flex: 1, gap: 4, minWidth: 0 },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "500" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
      dot: { paddingTop: 5 },
      evidence: { alignSelf: "flex-start" as const, borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: 10, paddingVertical: 2 },
      mono: { color: theme.colors.foregroundMuted, fontSize: 11.5, fontFamily: "monospace" },
      tags: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      word: { fontSize: 12, fontWeight: "500" as const },
    }),
    [theme],
  );
}

type Colors = PluginTheme["colors"];
const levelColor = (colors: Colors, item: WatchIncident) => (item.level === "page" ? colors.statusDanger : item.told ? colors.statusWarning : colors.foregroundMuted);

const IncidentRow = memo(function IncidentRow({ item, watch, theme }: { item: WatchIncident; watch: WatchView; theme: PluginTheme }) {
  const styles = useStyles(theme);
  const c = theme.colors;
  const lines = incidentLines(item, watch);
  return (
    <View style={styles.row}>
      <View style={styles.dot}>
        <Dot color={levelColor(c, item)} />
      </View>
      <View style={[styles.labels, { gap: 6 }]}>
        <Text style={styles.title}>{item.title}</Text>
        <Text style={styles.hint}>{lines.sub}</Text>
        {item.quote ? (
          <View style={styles.evidence}>
            <Text style={styles.mono}>{item.quote}</Text>
          </View>
        ) : null}
        <View style={styles.tags}>
          <Tag text={lines.source} color={c.foregroundMuted} theme={theme} />
          <Tag text={lines.state} color={lines.danger ? c.statusDanger : c.foregroundMuted} theme={theme} />
        </View>
      </View>
    </View>
  );
});

/** How close a leaning answer is to its bar: the answer filled in, the bar as a tick. */
function Meter({ lean, theme }: { lean: WatchLean; theme: PluginTheme }) {
  const c = theme.colors;
  return (
    <View style={{ width: 200, height: 8, justifyContent: "center" }}>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: c.surface2 }} />
      <View style={{ position: "absolute", left: 0, height: 4, borderRadius: 2, width: `${Math.round(lean.p * 100)}%`, backgroundColor: c.statusWarning }} />
      <View style={{ position: "absolute", left: `${Math.round(lean.bar * 100)}%`, width: 2, height: 10, marginLeft: -1, backgroundColor: c.foregroundMuted }} />
    </View>
  );
}

function Section({ title, children, theme }: { title: string; children: ReactNode; theme: PluginTheme }) {
  const styles = useStyles(theme);
  return (
    <>
      <Text style={styles.heading}>{title}</Text>
      <SettingsCard>
        <View>{children}</View>
      </SettingsCard>
    </>
  );
}

/** Trouble nobody is mailed about, shown whatever the watch is doing: a refused call is the harness's, not the watch's. */
function Trouble({ watch, theme }: { watch: WatchView; theme: PluginTheme }) {
  const styles = useStyles(theme);
  const shown = watch.trouble.filter((entry) => entry.kind !== "sensor.degraded");
  if (shown.length === 0) return null;
  return (
    <Section title="Not from the watch" theme={theme}>
      {shown.map((entry, index) => (
        <View key={`${entry.kind}-${index}`}>
          {index > 0 ? <Rule theme={theme} /> : null}
          <View style={styles.row}>
            <View style={styles.dot}>
              <Dot color={theme.colors.statusWarning} />
            </View>
            <View style={styles.labels}>
              <Text style={styles.title}>{entry.kind === "call.malformed" ? "An agent request could not be processed" : entry.kind}</Text>
              <Text style={styles.hint}>{entry.detail}</Text>
            </View>
            <Text style={styles.hint}>{ago(entry.minutes)}</Text>
          </View>
        </View>
      ))}
    </Section>
  );
}

/** The watch by Jev; by a seat the Watcher sits on the canvas and what it raises is in `IncidentsCard`. */
export function WatchCard({ watch, theme, onAddKey, onWatchBySeat }: { watch: WatchView; theme: PluginTheme; onAddKey(): void; onWatchBySeat(): void }) {
  const styles = useStyles(theme);
  const c = theme.colors;
  const head = jevHeader(watch);
  const tone = head.tone === "success" ? c.statusSuccess : head.tone === "warning" ? c.statusWarning : c.foregroundMuted;
  const lean = leaning(watch.seats);
  const record = trackRecord(watch.marks);
  const total = Math.max(1, record.parts[0] + record.parts[1] + record.parts[2]);

  return (
    <View style={{ gap: 10 }}>
      <SettingsCard>
        <View style={{ paddingVertical: 4 }}>
          <View style={styles.row}>
            <View style={styles.dot}>
              <Dot color={tone} />
            </View>
            <View style={styles.labels}>
              <Text style={styles.title}>{head.title}</Text>
              <Text style={styles.hint}>{head.sub}</Text>
            </View>
            {watch.keyed ? (
              head.word ? <Text style={[styles.word, { color: tone }]}>{head.word}</Text> : null
            ) : (
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button label="Watch by a seat" theme={theme} onPress={onWatchBySeat} />
                <Button label="Add a key" tone="accent" theme={theme} onPress={onAddKey} />
              </View>
            )}
          </View>
          <Text style={[styles.hint, { paddingLeft: 38, paddingRight: 18, paddingBottom: 10 }]}>
            Jev is a model outside the team. After each step a Lead or Peer takes, it answers questions about what just happened, each a yes or no with how sure it is. An answer past its bar becomes an incident; one below it is only noted here.
          </Text>
        </View>
      </SettingsCard>

      {watch.keyed ? (
        <>
          <Section title={watch.incidents.length > 0 ? `Needs a look · ${watch.incidents.length}` : "Needs a look"} theme={theme}>
            {watch.incidents.length === 0 ? (
              <Text style={[styles.hint, { padding: 18 }]}>Nothing needs a look.</Text>
            ) : (
              watch.incidents.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <Rule theme={theme} /> : null}
                  <IncidentRow item={item} watch={watch} theme={theme} />
                </View>
              ))
            )}
          </Section>

          {watch.seats.some((seat) => seat.running) || watch.failing ? (
            <Section title="Observations below the alert threshold" theme={theme}>
              {watch.failing ? (
                <Text style={[styles.hint, { padding: 18 }]}>Nothing to show until Jev answers again: what it leans towards is its own reading.</Text>
              ) : (
                <>
                  {lean.leaning.map((seat, index) => (
                    <View key={seat.id}>
                      {index > 0 ? <Rule theme={theme} /> : null}
                      <View style={[styles.row, { alignItems: "center", flexWrap: "wrap" }]}>
                        <View style={styles.labels}>
                          <Text style={styles.title}>{seat.lean.title}</Text>
                          <Text style={styles.hint}>{seat.name}</Text>
                        </View>
                        <View style={{ alignItems: "flex-end", gap: 5 }}>
                          <Meter lean={seat.lean} theme={theme} />
                          <Text style={styles.hint}>{`${Math.round(seat.lean.p * 100)}% · raised at ${Math.round(seat.lean.bar * 100)}%`}</Text>
                        </View>
                      </View>
                    </View>
                  ))}
                  {lean.quiet.length > 0 ? (
                    <>
                      {lean.leaning.length > 0 ? <Rule theme={theme} /> : null}
                      <Text style={[styles.hint, { paddingHorizontal: 18, paddingVertical: 12 }]}>
                        {`${lean.leaning.length > 0 ? `${lean.quiet.length} more` : lean.quiet.length} seat${lean.quiet.length === 1 ? "" : "s"} read with nothing leaning: ${lean.quiet.join(", ")}`}
                      </Text>
                    </>
                  ) : null}
                </>
              )}
            </Section>
          ) : null}

          <Section title="How right it has been here" theme={theme}>
            <View style={{ paddingHorizontal: 18, paddingVertical: 14, gap: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Text style={[styles.title, { flex: 1 }]}>{record.title}</Text>
                {record.percent ? <Text style={[styles.title, { color: c.statusSuccess }]}>{record.percent}</Text> : null}
              </View>
              <View style={{ flexDirection: "row", gap: 2 }}>
                {record.parts.map((part, index) =>
                  part > 0 ? <View key={index} style={{ flex: part / total, height: 4, borderRadius: 2, backgroundColor: [c.statusSuccess, c.foregroundMuted, c.surface2][index] }} /> : null,
                )}
              </View>
              <Text style={styles.hint}>{record.hint}</Text>
            </View>
          </Section>
        </>
      ) : null}

      <Trouble watch={watch} theme={theme} />
      <Text style={[styles.hint, { fontSize: 11 }]}>
        Nothing Jev concludes reaches the seat it is about. An incident about a Peer goes to its Lead; one about a Lead, or one that pages, goes to the Supervisor.
      </Text>
    </View>
  );
}

/** By a seat, what is not yet marked, in one short card like the open asks. */
export function IncidentsCard({ watch, theme }: { watch: WatchView; theme: PluginTheme }) {
  const styles = useStyles(theme);
  if (watch.incidents.length === 0 && watch.trouble.length === 0) return null;
  return (
    <View style={{ gap: 10 }}>
      {watch.incidents.length > 0 ? (
        <Section title={`Incidents · ${watch.incidents.length} not yet marked`} theme={theme}>
          {watch.incidents.map((item, index) => {
            const lines = incidentLines(item, watch);
            return (
              <View key={item.id}>
                {index > 0 ? <Rule theme={theme} /> : null}
                <View style={[styles.row, { alignItems: "center" }]}>
                  <View style={styles.labels}>
                    <Text style={styles.title}>{`${item.id} · ${item.title}`}</Text>
                    <Text style={styles.hint}>{`${lines.source} · ${item.name} · ${lines.state}`}</Text>
                  </View>
                  <Text style={styles.hint}>{ago(item.minutes)}</Text>
                </View>
              </View>
            );
          })}
        </Section>
      ) : null}
      <Trouble watch={watch} theme={theme} />
    </View>
  );
}
