import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { Check } from "./data.ts";
import { setAttention, setFlow, useFlow, useSeatworks } from "./data.ts";
import { type DetailTab, Detail } from "./detail.tsx";
import { FlowSection } from "./flow.tsx";
import { HealthSection } from "./health.tsx";
import { ServersSection } from "./servers.tsx";
import { SetupDialog } from "./setup-dialog.tsx";
import { ProfilesSection } from "./profiles.tsx";
import { TeamSection } from "./team.tsx";
import { UpkeepSection } from "./upkeep.tsx";
import { SupervisionPanel } from "./supervision.tsx";

const MACHINE = "machine";

export function SeatworksSurface({ theme, layout, navigation, openActivity }: PluginSurfaceProps & { openActivity?: (workspace: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("team");
  const [chip, setChip] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  // The project just added, so the home screen can point the next step at it.
  const [added, setAdded] = useState<{ slug: string; at: number } | null>(null);
  // Tagged with the screen they ran on, or another project's results showed as this one's.
  const [checks, setChecks] = useState<{ of: string; at: string; rows: Check[] } | null>(null);
  // Tagged by project: lane ids repeat across projects, every first lane is L1.
  const [openLanes, setOpenLanes] = useState<{ of: string; lanes: string[] }>({ of: "", lanes: [] });
  const project = open && open !== MACHINE ? open : undefined;
  const lanesOpen = openLanes.of === (project ?? "") ? openLanes.lanes : [];
  const { data, save, reload, saving, saved, saveError, addServer, attach, detach, listFolders, runDoctor, readStatus, readSettings } = useSeatworks(project);
  const settings = data.status === "ready" ? data : null;
  const flowLive = settings ? (settings.values.flow?.live ?? settings.machine.flow?.live ?? true) : true;
  const flowEvery = settings ? (settings.values.flow?.everySeconds ?? settings.machine.flow?.everySeconds ?? 5) : 5;
  const { flow, error: flowError } = useFlow(tab === "flow" && flowLive ? project : undefined, flowEvery * 1000, lanesOpen.slice().sort().join(","));
  const toast = useToast();
  const wasSaving = useRef(false);
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      body: { padding: layout.compact ? 12 : 20, gap: 16 },
      centered: { flex: 1, padding: 24, gap: 12, backgroundColor: theme.colors.surface0 },
      muted: { color: theme.colors.foregroundMuted },
      danger: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );

  useEffect(() => {
    if (wasSaving.current && !saving && saved === true) toast.show("Saved", { variant: "success" });
    wasSaving.current = saving;
  }, [saving, saved, toast]);

  if (data.status === "loading") {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Reading the catalog and the settings.</Text>
      </View>
    );
  }
  if (data.status === "error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.danger}>{data.error}</Text>
        <SettingsAction label="Seatworks" hint="The plugin did not answer." actionLabel="Try again" onPress={reload} />
      </View>
    );
  }

  const nameOf = (slug: string, root: string) => data.known.find((entry) => entry.root === root)?.name ?? slug;
  // Both layers, since the project's revision alone missed a machine save.
  const settledAs = `${data.revision}:${JSON.stringify(data.machine)}`;
  const here = data.projects.find((entry) => entry.slug === project);
  const layer = project ? "project" : "machine";
  const problems = [...(data.settingsError ? [data.settingsError] : []), ...(saveError ? [saveError] : []), ...data.team.errors];
  // Settings that could not be read are shown as empty, so editing them would save that emptiness over what the file holds.
  const locked = saving || data.settingsError !== null;

  const trouble =
    problems.length > 0 ? (
      <SettingsSection title="Needs your attention">
        <SettingsCard>
          {problems.map((problem) => (
            <SettingsRow key={problem} label="Problem" error={problem} />
          ))}
        </SettingsCard>
      </SettingsSection>
    ) : null;

  const dialogNode = (
    <SetupDialog
      open={dialog}
      catalog={data.catalog}
      available={data.candidates}
      projects={data.projects}
      readSettings={readSettings}
      machine={project ? data.machine : data.values}
      theme={theme}
      disabled={saving}
      onOpenChange={setDialog}
      attach={attach}
      listFolders={listFolders}
      onAttached={(slug) => { setOpen(null); setAdded({ slug, at: Date.now() }); reload(); }}
    />
  );

  if (!open) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
        {trouble}
        <SupervisionPanel theme={theme} compact={layout.compact} catalog={data.catalog} machine={data.values} projects={data.projects}
          available={data.candidates} listFolders={listFolders} attach={attach} onChanged={reload} added={added}
          onAdd={() => setDialog(true)} onSettings={(slug) => { setOpen(slug); setTab("team"); setChip(data.catalog.roles.find((r) => r.can.includes(slug === MACHINE ? "supervise" : "lead"))?.id ?? null); }}
          onFlow={(slug) => { setOpen(slug); setTab("flow"); }} onAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined}
          onReview={navigation ? (agentId, workspace) => { navigation.openAgent({ agentId }); if (workspace && openActivity) setTimeout(() => openActivity(workspace), 400); } : undefined} />
        {dialogNode}
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <Detail
        title={here ? nameOf(here.slug, here.root) : "Machine defaults"}
        subtitle={here ? here.root : "Every project that sets nothing of its own follows these."}
        tab={tab}
        theme={theme}
        disabled={saving}
        onBack={() => setOpen(null)}
        onTab={setTab}
        onDetach={here ? () => void detach(here.slug).then((gone) => gone && setOpen(null)) : undefined}
      >
        {trouble}
        {tab === "team" ? (
          <>
            {!project ? <ProfilesSection catalog={data.catalog} values={data.values} theme={theme} disabled={locked} save={save} /> : null}
            <TeamSection catalog={data.catalog} team={data.team} values={data.values} machine={data.machine} layer={layer} theme={theme} disabled={locked} active={chip} onActive={setChip} save={save} reload={reload} />
          </>
        ) : null}
        {tab === "flow" ? (
          <FlowSection
            onAgent={navigation ? id => navigation.openAgent({ agentId: id }) : undefined}
            following={Boolean(project)}
            flow={flow}
            error={flowError}
            live={flowLive}
            theme={theme}
            disabled={locked}
            onLive={(next) => void save((values) => setFlow(values, { live: next }))}
            onAddKey={() => {
              setOpen(MACHINE);
              setTab("team");
              setChip(data.catalog.roles.find((role) => role.can.includes("watch"))?.id ?? null);
            }}
            onWatchBySeat={() => void save((values) => setAttention(values, { by: "seat" }))}
            onOpen={(lane) =>
              setOpenLanes((current) => {
                const lanes = current.of === (project ?? "") ? current.lanes : [];
                return { of: project ?? "", lanes: lanes.includes(lane) ? lanes.filter((id) => id !== lane) : [...lanes, lane] };
              })
            }
          />
        ) : null}
        {tab === "mcp" ? (
          <ServersSection
            catalog={data.catalog}
            team={data.team}
            values={data.values}
            machine={data.machine}
            layer={layer}
            theme={theme}
            disabled={locked}
            save={(change) => save(change)}
            addServer={addServer}
          />
        ) : null}
        {tab === "plugin" ? <UpkeepSection theme={theme} /> : null}
        {tab === "health" ? (
          <HealthSection
            project={project}
            theme={theme}
            checks={checks?.of === (project ?? MACHINE) ? checks.rows : null}
            // Which settings it was run against, so a report from before a save is not read as now.
            stale={checks?.of === (project ?? MACHINE) && checks.at !== settledAs}
            onChecks={(rows) => setChecks({ of: project ?? MACHINE, at: settledAs, rows })}
            runDoctor={runDoctor}
            readStatus={readStatus}
          />
        ) : null}
      </Detail>
      {dialogNode}
    </ScrollView>
  );
}
