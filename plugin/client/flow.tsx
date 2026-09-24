import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { memo, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Button, Empty } from "./bits.tsx";
import { type FlowLane, type FlowSeat, type FlowView, countsInstead, watcherState } from "./data.ts";
import { IncidentsCard, WatchCard } from "./watching.tsx";

type Props = {
  following: boolean;
  flow: FlowView | null;
  error: string | null;
  live: boolean;
  theme: PluginTheme;
  disabled: boolean;
  onLive(live: boolean): void;
  onOpen(lane: string): void;
  onAgent?: (id: string) => void;
  onAddKey(): void;
  onWatchBySeat(): void;
};

const NODE_W = 232;
const NODE_H = 80;
const COL_GAP = 44;
const ROW_GAP = 12;
const PAD = 16;

const ago = (minutes: number): string => (minutes < 1 ? "just now" : `${minutes} min`);
/** The whole phrase, because "just now" is not a duration and read as "handed back just now ago". */
const since = (minutes: number): string => (minutes < 1 ? "just now" : `${minutes} min ago`);

const seatText = (seat: FlowSeat | null): string => {
  if (!seat) return "no active agent";
  if (seat.waiting.length > 0) return `waiting on you · ${seat.waiting[0]}`;
  if (seat.status === "gone") return seat.minutes > 0 ? `stopped · last heard ${seat.minutes} min ago` : "stopped";
  return `${seat.status} · ${ago(seat.minutes)}`;
};

function useStyles(theme: PluginTheme) {
  return useMemo(
    () => ({
      canvas: { borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0, overflow: "hidden" as const },
      reads: { borderStyle: "dashed" as const },
      node: { width: NODE_W, height: NODE_H, gap: 4, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      title: { flex: 1, color: theme.colors.foreground, fontSize: 14, fontWeight: "500" as const },
      caret: { color: theme.colors.foregroundMuted, fontSize: 12 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
      alive: { color: theme.colors.statusSuccess, fontSize: 12, fontWeight: "500" as const },
      quiet: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500" as const },
      lane: { flexDirection: "row" as const, paddingHorizontal: PAD, paddingTop: PAD, gap: 0 },
      children: { gap: ROW_GAP },
      stub: { flexDirection: "row" as const, alignItems: "center" as const },
      rail: { width: 1, backgroundColor: theme.colors.border },
      link: { width: COL_GAP / 2, height: 1, backgroundColor: theme.colors.border },
      spine: { width: COL_GAP / 2, height: 1, backgroundColor: theme.colors.border, alignSelf: "center" as const },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
      labels: { flex: 1, gap: 4 },
    }),
    [theme],
  );
}

const Node = memo(function Node({ title, hint, state, alive, caret, reads, theme, onPress }: {
  title: string;
  hint: string;
  state: string;
  alive: boolean;
  caret?: string;
  reads?: boolean;
  theme: PluginTheme;
  onPress?: () => void;
}) {
  const styles = useStyles(theme);
  return (
    <Pressable accessibilityRole={onPress ? "button" : "text"} accessibilityLabel={title} disabled={!onPress} onPress={onPress} style={[styles.node, reads ? styles.reads : null]}>
      <View style={styles.head}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {caret ? <Text style={styles.caret}>{caret}</Text> : null}
      </View>
      <Text style={styles.hint} numberOfLines={1}>
        {hint}
      </Text>
      <Text style={alive ? styles.alive : styles.quiet} numberOfLines={1}>
        {state}
      </Text>
    </Pressable>
  );
});

const Lane = memo(function Lane({ lane, theme, onOpen, onAgent }: { lane: FlowLane; theme: PluginTheme; onOpen(id: string): void; onAgent?: (id: string) => void }) {
  const styles = useStyles(theme);
  if (lane.status === "waiting") {
    return (
      <View style={styles.lane}>
        <Node theme={theme} title={`Waiting · ${lane.id} ${lane.title}`} hint={`after ${(lane.after ?? []).join(", ")}`} state={lane.held ? `not open: ${lane.held}` : "starts once that work is merged"} alive={false} />
      </View>
    );
  }
  return (
    <View style={styles.lane}>
      <View style={{ gap: 8 }}>
      <Node
        theme={theme}
        title={`Lead · ${lane.id} ${lane.title}`}
        hint={lane.base ? `${lane.branch} off ${lane.base}` : `${lane.branch}, carried on in place`}
        state={countsInstead(lane) ? `${lane.taskCount} task${lane.taskCount === 1 ? "" : "s"}, ${lane.running} running` : seatText(lane.lead)}
        alive={Boolean(lane.lead && lane.lead.status !== "gone")}
        caret={lane.taskCount === 0 ? undefined : lane.open ? "▾" : "▸"}
        onPress={lane.taskCount === 0 ? undefined : () => onOpen(lane.id)}
      />
      {onAgent && lane.lead && lane.lead.status !== "gone" ? <Button label="Open Lead" theme={theme} onPress={() => onAgent(lane.lead!.id)} /> : null}
      </View>
      {lane.open && lane.tasks.length > 0 ? (
        <>
          <View style={styles.spine} />
          <View style={styles.rail} />
          <View style={styles.children}>
            {lane.tasks.map((task) => (
              <View key={task.id} style={styles.stub}>
                <View style={styles.link} />
                <Node
                  theme={theme}
                  title={`${task.kind === "review" ? "Reviewer" : "Peer"} · ${task.id}`}
                  hint={task.title}
                  state={task.handback !== null ? `${task.status} · handed back ${since(task.handback)}` : `${task.status} · ${seatText(task.peer)}`}
                  alive={task.status === "running" || task.status === "rework"}
                  onPress={onAgent && task.peer && task.peer.status !== "gone" ? () => onAgent(task.peer!.id) : undefined}
                />
              </View>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
});

export function FlowSection({ following, flow, error, live, theme, disabled, onLive, onOpen, onAgent, onAddKey, onWatchBySeat }: Props) {
  const styles = useStyles(theme);
  const empty = flow !== null && flow.lanes.length === 0 && flow.supervisors.length === 0;
  // By a seat the Watcher is a seat like the others, beside the Supervisor, once a lane has put it there.
  const watcher = flow && flow.watch.by === "seat" && (flow.watch.watcher || flow.lanes.some((lane) => lane.status === "open")) ? watcherState(flow.watch.watcher) : null;

  return (
    <SettingsSection title="Team activity" info="Expand a work stream to see its tasks. Open an agent to continue its conversation.">
      <SettingsCard>
        <SettingsSwitch
          label="Follow the team live"
          hint={!following ? "The default every project starts with. Each project's own Flow tab shows its work." : live ? "Checks for updates every few seconds while this tab is open." : "Switched off, so this tab costs nothing."}
          value={live}
          onValueChange={onLive}
          disabled={disabled}
        />
      </SettingsCard>

      {!live ? null : error ? (
        <SettingsCard>
          <Empty theme={theme} title="Team activity could not be loaded" body={error} />
        </SettingsCard>
      ) : flow === null ? (
        <SettingsCard>
          <Empty theme={theme} title={following ? "Loading team activity" : "Team activity is shown per project"} body={following ? "This refreshes on its own." : "Open a project to see its work streams; the switch above only sets the default."} />
        </SettingsCard>
      ) : empty ? (
        <SettingsCard>
          <Empty theme={theme} title="Nothing is running" body="Start work and its Lead, tasks and questions appear here." />
        </SettingsCard>
      ) : (
        <View style={styles.canvas}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ paddingBottom: PAD }}>
              {flow.supervisors.map((seat, index) => (
                <View key={seat.id} style={styles.lane}>
                  <Node theme={theme} title={seat.role === "supervisor" ? "Supervisor" : `Supervisor · ${seat.role}`} hint={seat.id} state={seatText(seat)} alive={seat.status !== "gone"} />
                  {index === 0 && watcher ? (
                    <>
                      <View style={{ width: COL_GAP }} />
                      <Node theme={theme} title="Watcher" hint="watches every Lead and Peer" state={watcher.state} alive={watcher.alive} reads />
                    </>
                  ) : null}
                </View>
              ))}
              {flow.lanes.map((lane) => (
                <Lane key={lane.id} lane={lane} theme={theme} onOpen={onOpen} onAgent={onAgent} />
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {live && flow && flow.moreLanes > 0 ? (
        <SettingsCard>
          <SettingsRow
            label={`${flow.moreLanes} more work stream${flow.moreLanes === 1 ? "" : "s"}`}
            hint={`This screen shows only the first ${flow.lanes.length} open work streams. The rest are still open or waiting; the Status report lists all of them.`}
          />
        </SettingsCard>
      ) : null}

      {live && flow ? (flow.watch.by === "jev" ? <WatchCard watch={flow.watch} theme={theme} onAddKey={onAddKey} onWatchBySeat={onWatchBySeat} /> : <IncidentsCard watch={flow.watch} theme={theme} />) : null}

      {live && flow && flow.asks.length > 0 ? (
        <SettingsCard>
          {flow.asks.map((ask) => (
            <View key={ask.id} style={styles.row}>
              <View style={styles.labels}>
                <Text style={styles.title}>{`${ask.id} · ${ask.text}`}</Text>
                <Text style={styles.hint}>{`${ask.kind} from the ${ask.fromRole}`}</Text>
              </View>
              <Text style={styles.quiet}>{ago(ask.minutes)}</Text>
            </View>
          ))}
        </SettingsCard>
      ) : null}
    </SettingsSection>
  );
}
