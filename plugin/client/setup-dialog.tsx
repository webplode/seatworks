import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { bindingRpc, pathsFindRpc, supervisionRpc } from "../shared/rpc.ts";
import type { SupervisionView } from "../shared/supervision.ts";
import { Button } from "./bits.tsx";
import type { Catalog, Folders, Layer, PaseoProject, ProjectRow } from "./data.ts";
import { message } from "./data.ts";
import { RoleChoice, roleChoice } from "./role-choice.tsx";
import { addSupervisedProject, workGrants } from "./project-setup.ts";

type Found = { path: string; label: string; repository: boolean };

type Props = {
  open: boolean; initialRoot?: string; catalog: Catalog; available: PaseoProject[]; projects: ProjectRow[];
  readSettings(slug: string): Promise<{ status: string; values?: Layer; machine?: Layer } | { error: string }>;
  machine: Layer; theme: PluginTheme; disabled: boolean; error?: string | null;
  onOpenChange(open: boolean): void; attach(root: string, values: Layer): Promise<string | null>;
  listFolders(path?: string): Promise<Folders | { error: string }>; onAttached(slug: string): void;
};

export function SetupDialog({ open, initialRoot, catalog, available, projects, readSettings, machine, theme, disabled, error, onOpenChange, attach, listFolders, onAttached }: Props) {
  const paseo = usePaseo();
  const read = useRpc(supervisionRpc);
  const bind = useRpc(bindingRpc);
  const find = useRpc(pathsFindRpc);
  const [step, setStep] = useState(0);
  const [path, setPath] = useState("");
  const [folder, setFolder] = useState<Folders | null>(null);
  const [found, setFound] = useState<Found[]>([]);
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState<Layer>({});
  const [expandedRole, setExpandedRole] = useState<string | null>(null);
  const [customize, setCustomize] = useState(false);
  const [mode, setMode] = useState<"work" | "observe">("work");
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const roles = catalog.roles.filter((r) => r.can.includes("lead") || r.can.includes("write") || r.can.includes("review"));
  const locked = busy || disabled;
  const c = theme.colors;
  const text = { color: c.foreground, fontSize: 14 };
  const muted = { color: c.foregroundMuted, fontSize: 13, lineHeight: 20 };
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const };
  const root = folder?.root ?? folder?.path ?? "";
  const name = root.split("/").filter(Boolean).pop() ?? "Project";
  const close = () => { if (locked) return; setStep(0); setPath(""); setFolder(null); setFound([]); setCursor(0); setDraft({}); setExpandedRole(null); setCustomize(false); setMode("work"); setTrouble(null); onOpenChange(false); };
  const home: Found[] = available.map((p) => ({ path: p.root, label: p.name, repository: false }));
  const shown = path.trim() ? found : home;
  const asked = useRef(0);
  useEffect(() => {
    if (!open || step !== 0 || !path.trim()) { setFound([]); return; }
    const ticket = ++asked.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await find({ query: path }) as { folders?: Found[]; error?: string };
          if (ticket !== asked.current) return;
          setTrouble(result.error ?? null); setFound(result.folders ?? []); setCursor(0);
        } catch (e) { if (ticket === asked.current) setTrouble(message(e)); }
      })();
    }, 120);
    return () => clearTimeout(timer);
  }, [open, step, path, find]);
  /** Picking a folder is the whole first step, as in Paseo's own Add project. */
  const choose = async (value: string) => {
    setBusy(true); setTrouble(null);
    try {
      const picked = await listFolders(value);
      if ("error" in picked) throw new Error(picked.error);
      const existing = projects.find((p) => p.root === (picked.root ?? picked.path));
      if (existing) {
        const held = await readSettings(existing.slug);
        if ("error" in held || held.status !== "ready") throw new Error("Existing project settings could not be read. Retry before making changes.");
        setDraft(held.values ?? {});
      }
      setFolder(picked); setStep(1);
    } catch (e) { setTrouble(message(e)); } finally { setBusy(false); }
  };
  const bootstrap = useRef({ listFolders, readSettings, projects }); bootstrap.current = { listFolders, readSettings, projects };
  useEffect(() => {
    if (!open || !initialRoot) return;
    let alive = true; setBusy(true); setTrouble(null);
    void (async () => {
      try {
        const found = await bootstrap.current.listFolders(initialRoot);
        if ("error" in found) throw new Error(found.error);
        const existing = bootstrap.current.projects.find((p) => p.root === (found.root ?? found.path));
        const held = existing ? await bootstrap.current.readSettings(existing.slug) : null;
        if (held && ("error" in held || held.status !== "ready")) throw new Error("Project settings could not be read.");
        if (alive) { setFolder(found); setPath(found.path); setDraft(held && "values" in held ? held.values ?? {} : {}); setStep(1); }
      } catch (e) { if (alive) setTrouble(message(e)); } finally { if (alive) setBusy(false); }
    })();
    return () => { alive = false; };
  }, [open, initialRoot]);
  const finish = async () => {
    setBusy(true); setTrouble(null);
    try {
      const values = { ...draft, roles: { ...draft.roles } };
      for (const role of roles) {
        const choice = roleChoice(catalog, role, draft, machine);
        if (!choice.harness || !choice.harness.models.some((m) => m.id === choice.model)) throw new Error(`Choose a provider and model for ${role.label}.`);
        values.roles[role.id] = { ...values.roles[role.id], harness: choice.harness.id, model: choice.model, ...(choice.thinking ? { thinking: choice.thinking } : {}) };
      }
      const slug = await addSupervisedProject({ root, name, values, grants: mode === "work" ? workGrants : ["observe"] }, {
        projects: async () => (await paseo.projects.list()).projects.map((p) => ({ id: p.projectId, root: p.projectRootPath })),
        register: async (path, title) => { await paseo.workspaces.create({ title, source: { kind: "directory", path } }); },
        attach, read: async () => await read({}) as unknown as SupervisionView, bind: async (value) => bind(value),
      });
      setStep(0); setPath(""); setFolder(null); setFound([]); setDraft({}); setExpandedRole(null); setCustomize(false); setMode("work"); onOpenChange(false); onAttached(slug);
    } catch (e) { setTrouble(message(e)); } finally { setBusy(false); }
  };
  return <Modal title={step === 0 ? "Add a project" : `Set up ${name}`} open={open} onOpenChange={(value) => { if (!value) close(); }}>
    <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>
      <View style={{ padding: 24, gap: 18 }}>
        <View style={row}>{["1  Choose folder", "2  Team & access"].map((label, i) => <Text key={label} style={{ ...muted, color: i === step ? c.foreground : c.foregroundMuted, fontWeight: i === step ? "600" : "400" }}>{label}</Text>)}</View>
        <Text style={muted}>{step === 0 ? "Bring an existing local project into Seatworks. Your files stay where they are." : "Choose the models this project will use. Your overall Supervisor is shared across projects."}</Text>
        {trouble || error ? <Text accessibilityRole="alert" style={{ ...text, color: c.statusDanger }}>{trouble ?? error}</Text> : null}
        {step === 0 ? <>
          <TextInput accessibilityLabel="Search for a project folder" placeholder="Search folders, or paste a path" placeholderTextColor={c.foregroundMuted} value={path} autoFocus
            onChangeText={(value) => { setPath(value); setTrouble(null); }} editable={!locked} autoCapitalize="none" autoCorrect={false}
            onKeyPress={(e) => {
              const key = (e.nativeEvent as { key?: string }).key;
              if (key === "ArrowDown") { e.preventDefault?.(); setCursor((i) => Math.min(i + 1, Math.max(shown.length - 1, 0))); }
              if (key === "ArrowUp") { e.preventDefault?.(); setCursor((i) => Math.max(i - 1, 0)); }
            }}
            onSubmitEditing={() => { const pick = shown[cursor]; if (pick) void choose(pick.path); }}
            style={{ ...text, minHeight: 44, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 }} />
          {!path.trim() && shown.length ? <Text style={muted}>Already in Paseo</Text> : null}
          <ScrollView accessibilityRole="list" style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 2 }} keyboardShouldPersistTaps="handled">
            {shown.map((f, i) => <Pressable key={f.path} accessibilityRole="button" accessibilityLabel={`Use ${f.label}`} disabled={locked} onPress={() => void choose(f.path)} onHoverIn={() => setCursor(i)}
              style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, backgroundColor: i === cursor ? c.surface2 : "transparent" }}>
              <Text numberOfLines={1} ellipsizeMode="head" style={{ ...text, fontWeight: "500" }}>{f.label}{f.repository ? <Text style={muted}>  · Git</Text> : null}</Text>
              <Text numberOfLines={1} ellipsizeMode="head" style={{ ...muted, fontSize: 12 }}>{f.path}</Text>
            </Pressable>)}
            {path.trim() && !shown.length && !trouble ? <Text style={muted}>No folder matches “{path.trim()}”.</Text> : null}
          </ScrollView>
        </> : <>
          <Text selectable style={muted}>{root}</Text>
          {folder && !(folder.repository || folder.root) ? <Text style={{ ...muted, color: c.statusWarning }}>Not a Git repository yet. A Lead needs Git and a first commit before it can open a work lane.</Text> : null}
          <Text style={{ ...text, fontWeight: "600" }}>Team models</Text>
          {!customize ? <><Text style={muted}>Use your configured team. You can change any role later.</Text>{roles.map(role => { const choice = roleChoice(catalog, role, draft, machine); return <Text key={role.id} style={muted}>{role.label} · {choice.harness?.label} · {choice.model}</Text>; })}</> : null}
          <Button label={customize ? "Keep these models" : "Customize models"} theme={theme} onPress={() => setCustomize(!customize)} />
          {customize ? roles.map((role) => {
            const selected = roleChoice(catalog, role, draft, machine);
            const expanded = role.can.includes("lead") || expandedRole === role.id;
            return <View key={role.id} style={{ gap: 8 }}>{expanded ? <RoleChoice catalog={catalog} role={role} values={draft} machine={machine} theme={theme} disabled={locked} onChange={setDraft} /> : <View style={{ ...row, paddingVertical: 8 }}><View style={{ flex: 1, minWidth: 160 }}><Text style={{ ...text, fontWeight: "600" }}>{role.label}</Text><Text style={muted}>{selected.harness?.label} · {selected.harness?.models.find((m) => m.id === selected.model)?.label ?? selected.model}</Text></View><Button label={`Edit ${role.label}`} theme={theme} disabled={locked} onPress={() => setExpandedRole(role.id)} /></View>}{expanded && !role.can.includes("lead") ? <Button label={`Done editing ${role.label}`} theme={theme} onPress={() => setExpandedRole(null)} /> : null}</View>;
          }) : null}
          <Text style={{ ...text, fontWeight: "600" }}>What can your Supervisor do here?</Text>
          {([['work', 'Coordinate work', 'Read activity, message Leads, answer questions, open work lanes, configure project tests and coordinate dependencies.'], ['observe', 'Observe only', 'Read activity. No messages or new work.']] as const).map(([value, label, detail]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: mode === value, disabled: locked }} accessibilityLabel={label} disabled={locked} onPress={() => setMode(value)}
            style={{ padding: 14, gap: 4, borderRadius: 8, borderWidth: 1, borderColor: mode === value ? c.accent : c.border, backgroundColor: c.surface1 }}>
            <Text style={{ ...text, fontWeight: "600" }}>{mode === value ? "●" : "○"} {label}</Text><Text style={muted}>{detail}</Text>
          </Pressable>)}
          <Text style={muted}>Adding a project creates its Paseo workspace and connects it to Seatworks. Agents start when you choose Start work. Merging remains a separate permission.</Text>
        </>}
      </View>
        <View style={{ ...row, justifyContent: "flex-end", padding: 16, borderTopWidth: 1, borderColor: c.border }}>
          {step === 0 ? <Text style={{ ...muted, fontSize: 12, flex: 1 }}>{busy ? "Opening…" : "↑↓ Navigate · ↵ Select · Esc Close"}</Text> : null}
          <Button label="Cancel" theme={theme} disabled={locked} onPress={close} />
          {step === 1 ? <Button label="Back" theme={theme} disabled={locked} onPress={() => setStep(0)} /> : null}
          {step === 1 ? <Button label={busy ? "Saving…" : "Add project"} tone="accent" theme={theme} disabled={locked || !root} onPress={() => void finish()} /> : null}
        </View>
    </Modal.Content>
  </Modal>;
}
