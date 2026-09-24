import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { PRESETS, type PresetId, presetOf, withPreset } from "../shared/presets.ts";
import { bindingRpc, createSupervisorRpc, doctorRpc, settingsReadRpc, settingsWriteRpc, supervisionRpc } from "../shared/rpc.ts";
import type { SupervisionView } from "../shared/supervision.ts";
import type { Check } from "../shared/views.ts";
import { Button } from "./bits.tsx";
import type { Catalog, Folders, Layer, PaseoProject, ProjectRow } from "./data.ts";
import { message } from "./data.ts";
import { FolderPalette, type Found } from "./folder-palette.tsx";
import { PresetPicker } from "./preset-picker.tsx";
import { addSupervisedProject, bindingInput, workGrants, writeRoles } from "./project-setup.ts";

const WORKS = ["observe", "message", "open_lane"] as const;
const nameOf = (root: string) => root.split("/").filter(Boolean).pop() ?? root;
const LAST = "seatworks.composer.project";
/** The project the last objective went to, kept by the browser; none on native or with storage blocked. */
type Kept = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const store = (): Kept | undefined => { try { return (globalThis as { localStorage?: Kept }).localStorage; } catch { return undefined; } };
const remembered = () => { try { return store()?.getItem(LAST) ?? undefined; } catch { return undefined; } };
const remember = (root: string) => { try { store()?.setItem(LAST, root); } catch { /* not kept */ } };

/** Seatworks' front door, as coding agents have it: say what you want, pick the project and the team, and go to the chat. */
export function Composer({ theme, compact, catalog, machine, view, projects, available, listFolders, attach, onChanged, onSettings, onAgent, onAccess, supervisorLine, aim, signIn, onReload }: {
  theme: PluginTheme; compact: boolean; catalog: Catalog; machine: Layer; view: SupervisionView; projects: ProjectRow[]; available: PaseoProject[];
  listFolders(path?: string): Promise<Folders | { error: string }>; attach(root: string, values: Layer): Promise<string | null>;
  onChanged(): void; onSettings(slug: string): void; onAgent?: (id: string) => void; onAccess(id: string): void; supervisorLine: string; aim?: { root: string; at: number } | null;
  /** What the Supervisor said when it could not sign in; sending it work now would only repeat that. */
  signIn?: string | null; onReload?: () => Promise<void>;
}) {
  const paseo = usePaseo();
  const read = useRpc(supervisionRpc), bind = useRpc(bindingRpc), create = useRpc(createSupervisorRpc);
  const readLayer = useRpc(settingsReadRpc), writeLayer = useRpc(settingsWriteRpc), doctor = useRpc(doctorRpc);
  const [target, setTarget] = useState<Found | null>(null);
  const [held, setHeld] = useState<PresetId | "custom">("balanced");
  const [preset, setPreset] = useState<PresetId | "custom">("balanced");
  const [objective, setObjective] = useState("");
  const [picking, setPicking] = useState(false);
  const [choosingTeam, setChoosingTeam] = useState(false);
  const [checks, setChecks] = useState<{ of: string; rows: Check[] | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<string | null>(null);
  const c = theme.colors;
  const text = { color: c.foreground, fontSize: 14, lineHeight: 21 };
  const muted = { color: c.foregroundMuted, fontSize: 13, lineHeight: 19 };
  const connected: Found[] = projects.map((p) => ({ path: p.root, label: view.binding.projects.find((s) => s.slug === p.slug)?.name || nameOf(p.root), repository: true, connected: true }));
  const others: Found[] = available.filter((p) => !projects.some((q) => q.root === p.root)).map((p) => ({ path: p.root, label: p.name, repository: false }));
  const slug = target?.connected ? projects.find((p) => p.root === target.path)?.slug : undefined;
  const scope = view.binding.projects.find((p) => p.slug === slug);
  const observeOnly = Boolean(scope) && !WORKS.every((op) => scope!.grants.includes(op));

  // The last project worked on is where the next objective most likely goes.
  const first = useRef(false);
  useEffect(() => {
    if (first.current || !projects.length) return;
    first.current = true;
    const writable = view.binding.projects.filter((p) => WORKS.every((op) => p.grants.includes(op)));
    const last = remembered();
    const busiest = writable.find((p) => p.root === last) ?? writable.find((p) => p.leads.length) ?? writable[0];
    const root = busiest?.root ?? projects[0]!.root;
    setTarget({ path: root, label: busiest?.name || nameOf(root), repository: true, connected: true });
  }, [projects, view]);

  const input = useRef<{ focus(): void } | null>(null);
  // A project card's "New work" points the composer at that project.
  useEffect(() => {
    if (!aim) return;
    const scoped = view.binding.projects.find((p) => p.root === aim.root);
    setTarget({ path: aim.root, label: scoped?.name || nameOf(aim.root), repository: true, connected: projects.some((p) => p.root === aim.root) });
    input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aim]);

  const calls = useRef({ readLayer, doctor }); calls.current = { readLayer, doctor };
  // What the chosen project's team is now, and whether it is set up to run: read on choosing, as the owner types.
  useEffect(() => {
    if (!target) return;
    let alive = true;
    setChecks({ of: target.path, rows: null });
    void (async () => {
      try {
        if (slug) {
          const layer = await calls.current.readLayer({ project: slug }) as { status: string; values?: Layer };
          const now = layer.status === "ready" ? presetOf(layer.values?.roles) : "custom";
          if (alive) { setHeld(now); setPreset(now); }
        } else if (alive) { setHeld("balanced"); setPreset("balanced"); }
        const rows = await calls.current.doctor(slug ? { project: slug } : {}) as Check[];
        if (alive) setChecks({ of: target.path, rows });
      } catch (e) { if (alive) setChecks({ of: target.path, rows: [{ id: "doctor", ok: false, detail: message(e) }] }); }
    })();
    return () => { alive = false; };
  }, [target, slug]);

  const failing = checks && checks.of === target?.path ? checks.rows?.filter((row) => !row.ok) ?? null : null;
  const start = async () => {
    if (!target || !objective.trim()) return;
    setBusy(true); setError(null);
    try {
      let at = slug;
      const chosen = PRESETS.find((p) => p.id === preset);
      if (!at) {
        const folder = await listFolders(target.path);
        if ("error" in folder) throw new Error(folder.error);
        const root = folder.root ?? folder.path;
        at = await addSupervisedProject({ root, name: nameOf(root), values: {}, grants: workGrants }, {
          projects: async () => (await paseo.projects.list()).projects.map((p) => ({ id: p.projectId, root: p.projectRootPath })),
          register: async (path, title) => { await paseo.workspaces.create({ title, source: { kind: "directory", path } }); },
          attach, read: async () => await read({}) as unknown as SupervisionView, bind: async (value) => bind(value),
        });
      }
      if (chosen && (preset !== held || !slug)) {
        const layer = await readLayer({ project: at }) as { values?: Layer };
        await writeRoles(at, withPreset(layer.values?.roles, chosen), { read: async (input) => await readLayer(input) as never, write: async (input) => await writeLayer(input as never) as never });
      }
      let next = await read({}) as unknown as SupervisionView;
      const project = next.binding.projects.find((p) => p.slug === at);
      if (!project) throw new Error("The project is not connected to your Supervisor yet. Refresh and try again.");
      if (!WORKS.every((op) => project.grants.includes(op))) throw new Error(`${project.name} can only be watched right now. Choose “Let the Supervisor work here” to start work there.`);
      if (!next.binding.supervisor) { await create({ revision: next.binding.revision }); next = await read({}) as unknown as SupervisionView; }
      const supervisor = next.binding.supervisor?.agent;
      if (!supervisor) throw new Error("Your Supervisor did not start. Refresh and try again.");
      if (!next.binding.active) await bind(bindingInput(next.binding, true));
      try { await paseo.agents.ref(supervisor).send(`Human objective for project ${project.id} (${project.root}):\n${objective.trim()}\n\nInspect current activity. Reuse a suitable existing Lead, or open a new isolated work lane with the project's configured team. Coordinate the work and report progress here. End your turn with a question when you need the Human.`); }
      catch (e) { setUncertain(supervisor); throw new Error(`Seatworks could not confirm the message arrived. Open your Supervisor before sending it again. ${message(e)}`); }
      remember(project.root); setObjective(""); setHeld(preset); onChanged(); onAgent?.(supervisor);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };

  const chip = (icon: string, label: string, onPress: () => void, hint: string) =>
    <Pressable accessibilityRole="button" accessibilityLabel={hint} disabled={busy} onPress={onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, minHeight: 32, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface2 : c.surface1, maxWidth: compact ? 180 : 260 })}>
      <Icon name={icon} size={14} color={c.foregroundMuted} />
      <Text numberOfLines={1} style={{ ...text, fontSize: 13, flexShrink: 1 }}>{label}</Text>
      <Icon name="ChevronDown" size={14} color={c.foregroundMuted} />
    </Pressable>;
  const presetLabel = PRESETS.find((p) => p.id === preset)?.label ?? "Custom team";
  const ready = Boolean(target && objective.trim()) && !busy && !uncertain && !signIn;
  const reloadNow = async () => { if (!onReload) return; setBusy(true); setError(null); try { await onReload(); } catch (e) { setError(message(e)); } finally { setBusy(false); } };

  return <View style={{ gap: 10 }}>
    <Text style={{ ...text, fontSize: compact ? 22 : 28, lineHeight: compact ? 28 : 36, fontWeight: "600", textAlign: "center" }}>What should the team work on?</Text>
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 14, backgroundColor: c.surface1, padding: 12, gap: 10 }}>
      <TextInput ref={input as never} accessibilityLabel="What should the team work on" placeholder="Describe the outcome you want. Your Supervisor plans it and starts the team." placeholderTextColor={c.foregroundMuted}
        multiline value={objective} onChangeText={(value) => { setObjective(value); setError(null); }} editable={!busy && !uncertain}
        onKeyPress={(e) => { const key = e.nativeEvent as { key?: string; metaKey?: boolean; ctrlKey?: boolean }; if (key.key === "Enter" && (key.metaKey || key.ctrlKey)) { e.preventDefault?.(); if (ready) void start(); } }}
        style={{ ...text, minHeight: compact ? 72 : 88, padding: 4, textAlignVertical: "top", outlineStyle: "none" } as never} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {chip("Folder", target ? target.label : "Choose a project", () => setPicking(true), "Choose the project")}
        {chip("Users", presetLabel, () => setChoosingTeam(true), "Choose the team")}
        <View style={{ flex: 1 }} />
        {!compact ? <Text style={{ ...muted, fontSize: 12 }}>⌘↵</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Start" accessibilityState={{ disabled: !ready }} disabled={!ready} onPress={() => void start()}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, minHeight: 34, borderRadius: 17, backgroundColor: c.accent, opacity: !ready ? 0.45 : pressed ? 0.85 : 1 })}>
          <Text style={{ color: c.accentForeground, fontSize: 14, fontWeight: "600" }}>{busy ? "Starting…" : "Start"}</Text>
          <Icon name="ArrowUp" size={14} color={c.accentForeground} />
        </Pressable>
      </View>
    </View>
    <View style={{ gap: 4, paddingHorizontal: 4 }}>
      {target && !target.connected ? <Text style={muted}>{target.label} joins Seatworks when you start. Your files stay where they are.</Text> : null}
      {observeOnly ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}><Text style={{ ...muted, color: c.statusWarning }}>{scope!.name} can only be watched right now.</Text><Button label="Let the Supervisor work here" theme={theme} onPress={() => onAccess(scope!.id)} /></View> : null}
      {target && failing === null ? <Text style={muted}>Checking setup…</Text> : null}
      {failing?.length ? failing.map((row) => <Text key={row.id} selectable style={{ ...muted, color: c.statusWarning }}>⚠ {row.detail}</Text>) : null}
      {signIn ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text selectable style={{ ...muted, color: c.statusWarning, flexShrink: 1 }}>⚠ Your Supervisor can't sign in (“{signIn}”). Reload it before you start.</Text>
        {onReload ? <Button label={busy ? "Reloading…" : "Reload Supervisor"} tone="accent" theme={theme} disabled={busy} onPress={() => void reloadNow()} /> : null}
      </View> : failing && !failing.length ? <Text style={muted}>✓ Ready to start · Supervisor {supervisorLine.replace(/^Runs on/, "runs on")}</Text> : null}
      {error ? <Text accessibilityRole="alert" selectable style={{ ...muted, color: c.statusDanger }}>{error}</Text> : null}
      {uncertain ? <Button label="Open Supervisor" theme={theme} disabled={!onAgent} onPress={() => onAgent?.(uncertain)} /> : null}
    </View>

    <Modal title="Choose a project" open={picking} onOpenChange={setPicking}><Modal.Content>
      <FolderPalette theme={theme} connected={[...connected, ...others]} onPick={(found) => { setTarget(found.connected ? found : { ...found, label: nameOf(found.path) }); setPicking(false); }} />
    </Modal.Content></Modal>
    <Modal title={`Team for ${target?.label ?? "this project"}`} open={choosingTeam} onOpenChange={setChoosingTeam}><Modal.Content>
      <View style={{ gap: 12 }}>
        <PresetPicker catalog={catalog} machine={machine} selected={preset} theme={theme} onSelect={(id) => { setPreset(id); setChoosingTeam(false); }} />
        <Text style={{ ...muted, fontSize: 12 }}>The Supervisor is shared by every project: {supervisorLine}. A preset sets this project's Lead, Peers and Reviewer when you start.</Text>
        {slug ? <Button label="Choose each model yourself" theme={theme} onPress={() => { setChoosingTeam(false); onSettings(slug); }} /> : null}
      </View>
    </Modal.Content></Modal>
  </View>;
}

