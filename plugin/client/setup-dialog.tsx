import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { bindingRpc, supervisionRpc } from "../shared/rpc.ts";
import type { SupervisionView } from "../shared/supervision.ts";
import { Button } from "./bits.tsx";
import type { Catalog, Folders, Layer, PaseoProject, ProjectRow } from "./data.ts";
import { message } from "./data.ts";
import { RoleChoice, roleChoice } from "./role-choice.tsx";
import { addSupervisedProject, workGrants } from "./project-setup.ts";

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
  const [step, setStep] = useState(0);
  const [path, setPath] = useState("");
  const [folder, setFolder] = useState<Folders | null>(null);
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
  const close = () => { if (locked) return; setStep(0); setPath(""); setFolder(null); setDraft({}); setExpandedRole(null); setCustomize(false); setMode("work"); setTrouble(null); onOpenChange(false); };
  const browse = async (value: string) => {
    setBusy(true); setTrouble(null);
    try { const found = await listFolders(value); if ("error" in found) throw new Error(found.error); setFolder(found); setPath(found.path); }
    catch (e) { setTrouble(message(e)); } finally { setBusy(false); }
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
  const next = async () => {
    if (!root) return;
    setBusy(true); setTrouble(null);
    try {
      const existing = projects.find((p) => p.root === root);
      if (existing) {
        const held = await readSettings(existing.slug);
        if ("error" in held || held.status !== "ready") throw new Error("Existing project settings could not be read. Retry before making changes.");
        setDraft(held.values ?? {});
      }
      setStep(1);
    } catch (e) { setTrouble(message(e)); } finally { setBusy(false); }
  };
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
      setStep(0); setPath(""); setFolder(null); setDraft({}); setExpandedRole(null); setCustomize(false); setMode("work"); onOpenChange(false); onAttached(slug);
    } catch (e) { setTrouble(message(e)); } finally { setBusy(false); }
  };
  return <Modal title={step === 0 ? "Add a project" : `Set up ${name}`} open={open} onOpenChange={(value) => { if (!value) close(); }}>
    <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>
      <View style={{ padding: 24, gap: 18 }}>
        <View style={row}>{["1  Choose folder", "2  Team & access"].map((label, i) => <Text key={label} style={{ ...muted, color: i === step ? c.foreground : c.foregroundMuted, fontWeight: i === step ? "600" : "400" }}>{label}</Text>)}</View>
        <Text style={muted}>{step === 0 ? "Bring an existing local project into Seatworks. Your files stay where they are." : "Choose the models this project will use. Your overall Supervisor is shared across projects."}</Text>
        {trouble || error ? <Text accessibilityRole="alert" style={{ ...text, color: c.statusDanger }}>{trouble ?? error}</Text> : null}
        {step === 0 ? <>
          <Text style={{ ...text, fontWeight: "600" }}>Project folder</Text>
          <View style={row}>
            <TextInput accessibilityLabel="Project folder path" placeholder="~/Projects/my-app" placeholderTextColor={c.foregroundMuted} value={path}
              onChangeText={(value) => { setPath(value); setFolder(null); }} editable={!locked} autoCapitalize="none" autoCorrect={false}
              onSubmitEditing={() => void browse(path || "~/Projects")}
              style={{ ...text, flex: 1, minWidth: 160, minHeight: 44, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 }} />
            <Button label={busy ? "Looking…" : "Browse folder"} theme={theme} disabled={locked} onPress={() => void browse(path || "~/Projects")} />
          </View>
          {folder ? <View style={{ gap: 10, padding: 16, backgroundColor: c.surface1, borderRadius: 8 }}>
            <Text selectable style={{ ...text, fontWeight: "600" }}>{root}</Text>
            <Text style={muted}>{folder.repository || folder.root ? "Git repository · ready for isolated work" : "Local folder · Git and an initial commit are needed before a Lead can open a work lane."}</Text>
            {folder.parent ? <Button label="Up one folder" theme={theme} disabled={locked} onPress={() => void browse(folder.parent!)} /> : null}
            {folder.folders.slice(0, 100).map((f) => <Pressable key={f.path} accessibilityRole="button" accessibilityLabel={`Browse ${f.name}`} disabled={locked} onPress={() => void browse(f.path)} style={{ paddingVertical: 10, borderTopWidth: 1, borderColor: c.border }}>
              <Text style={text}>{f.name}  {f.repository ? "· Git" : ""}  →</Text>
            </Pressable>)}
          </View> : available.length ? <View style={{ gap: 8 }}><Text style={muted}>Already in Paseo</Text>{available.map((p) => <Button key={p.root} label={p.name} theme={theme} disabled={locked} onPress={() => void browse(p.root)} />)}</View> : null}
        </> : <>
          <Text selectable style={muted}>{root}</Text>
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
          <Button label="Cancel" theme={theme} disabled={locked} onPress={close} />
          {step === 1 ? <Button label="Back" theme={theme} disabled={locked} onPress={() => setStep(0)} /> : null}
          <Button label={busy ? "Saving…" : step === 0 ? "Use this folder" : "Add project"} tone="accent" theme={theme} disabled={locked || !root}
            onPress={() => void (step === 0 ? next() : finish())} />
        </View>
    </Modal.Content>
  </Modal>;
}
