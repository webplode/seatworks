import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { bindingRpc, settingsReadRpc, settingsWriteRpc, supervisionRpc } from "../shared/rpc.ts";
import { PRESETS, presetOf, withPreset } from "../shared/presets.ts";
import type { SupervisionView } from "../shared/supervision.ts";
import { Button } from "./bits.tsx";
import type { Catalog, Folders, Layer, PaseoProject, ProjectRow } from "./data.ts";
import { message } from "./data.ts";
import { FolderPalette, type Found } from "./folder-palette.tsx";
import { PresetPicker, projectRoles } from "./preset-picker.tsx";
import { RoleChoice, roleChoice } from "./role-choice.tsx";
import { addSupervisedProject, workGrants, writeRoles } from "./project-setup.ts";

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
  const readLayer = useRpc(settingsReadRpc), writeLayer = useRpc(settingsWriteRpc);
  const [step, setStep] = useState(0);
  const [folder, setFolder] = useState<Folders | null>(null);
  const [draft, setDraft] = useState<Layer>({});
  const [more, setMore] = useState(false);
  const [mode, setMode] = useState<"work" | "observe">("work");
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const roles = projectRoles(catalog);
  const locked = busy || disabled;
  const c = theme.colors;
  const text = { color: c.foreground, fontSize: 14 };
  const muted = { color: c.foregroundMuted, fontSize: 13, lineHeight: 20 };
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const };
  const root = folder?.root ?? folder?.path ?? "";
  const name = root.split("/").filter(Boolean).pop() ?? "Project";
  const existing = projects.find((p) => p.root === root);
  const reset = () => { setStep(0); setFolder(null); setDraft({}); setMore(false); setMode("work"); setTrouble(null); };
  const close = () => { if (locked) return; reset(); onOpenChange(false); };
  const connected: Found[] = [
    ...projects.map((p) => ({ path: p.root, label: p.root.split("/").filter(Boolean).pop() ?? p.root, repository: true, connected: true })),
    ...available.filter((p) => !projects.some((q) => q.root === p.root)).map((p) => ({ path: p.root, label: p.name, repository: false })),
  ];
  /** A project already in Seatworks opens on its own settings, so adding it again cannot undo them. */
  const load = async (value: string, lists = listFolders, reads = readSettings, known = projects) => {
    const picked = await lists(value);
    if ("error" in picked) throw new Error(picked.error);
    const there = known.find((p) => p.root === (picked.root ?? picked.path));
    const held = there ? await reads(there.slug) : null;
    if (held && ("error" in held || held.status !== "ready")) throw new Error("This project's settings could not be read. Retry before changing them.");
    return { picked, values: held && "values" in held ? held.values ?? {} : {} };
  };
  const choose = async (value: string) => {
    setBusy(true); setTrouble(null);
    try { const { picked, values } = await load(value); setFolder(picked); setDraft(values); setStep(1); }
    catch (e) { setTrouble(message(e)); } finally { setBusy(false); }
  };
  const bootstrap = useRef({ listFolders, readSettings, projects }); bootstrap.current = { listFolders, readSettings, projects };
  useEffect(() => {
    if (!open || !initialRoot) return;
    let alive = true; setBusy(true); setTrouble(null);
    void (async () => {
      try { const { picked, values } = await load(initialRoot, bootstrap.current.listFolders, bootstrap.current.readSettings, bootstrap.current.projects); if (alive) { setFolder(picked); setDraft(values); setStep(1); } }
      catch (e) { if (alive) setTrouble(message(e)); } finally { if (alive) setBusy(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialRoot]);
  const finish = async () => {
    setBusy(true); setTrouble(null);
    try {
      for (const role of roles) {
        const choice = roleChoice(catalog, role, draft, machine);
        if (!choice.harness || !choice.harness.models.some((m) => m.id === choice.model)) throw new Error(`Choose an agent and model for the ${role.label}.`);
      }
      const slug = await addSupervisedProject({ root, name, values: {}, grants: mode === "work" ? workGrants : ["observe"] }, {
        projects: async () => (await paseo.projects.list()).projects.map((p) => ({ id: p.projectId, root: p.projectRootPath })),
        register: async (path, title) => { await paseo.workspaces.create({ title, source: { kind: "directory", path } }); },
        attach, read: async () => await read({}) as unknown as SupervisionView, bind: async (value) => bind(value),
      });
      await writeRoles(slug, draft.roles, { read: async (input) => await readLayer(input) as never, write: async (input) => await writeLayer(input as never) as never });
      reset(); onOpenChange(false); onAttached(slug);
    } catch (e) { setTrouble(message(e)); } finally { setBusy(false); }
  };
  return <Modal title={step === 0 ? "Add a project" : existing ? `${name} settings` : `Add ${name}`} open={open} onOpenChange={(value) => { if (!value) close(); }}>
    <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>
      <View style={{ padding: 24, gap: 16 }}>
        {trouble || error ? <Text accessibilityRole="alert" style={{ ...text, color: c.statusDanger }}>{trouble ?? error}</Text> : null}
        {step === 0 ? <FolderPalette theme={theme} connected={connected} busy={locked} onPick={(f) => void choose(f.path)} /> : <>
          <Text selectable numberOfLines={1} ellipsizeMode="head" style={muted}>{root}</Text>
          {folder && !(folder.repository || folder.root) ? <Text style={{ ...muted, color: c.statusWarning }}>Not a Git repository yet. Run git init and make a first commit before the team starts work here.</Text> : null}
          <Text style={{ ...text, fontWeight: "600" }}>Team</Text>
          <PresetPicker catalog={catalog} machine={machine} selected={presetOf(draft.roles)} theme={theme} disabled={locked}
            onSelect={(id) => setDraft({ ...draft, roles: withPreset(draft.roles, PRESETS.find((p) => p.id === id)!) })} />
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore(!more)}>
            <Text style={{ ...muted, color: c.foreground }}>{more ? "▾" : "▸"}  More options</Text>
          </Pressable>
          {more ? <View style={{ gap: 14 }}>
            {roles.map((role) => <RoleChoice key={role.id} catalog={catalog} role={role} values={draft} machine={machine} theme={theme} disabled={locked} onChange={setDraft} />)}
            <Text style={{ ...text, fontWeight: "600" }}>What can your Supervisor do here?</Text>
            {([["work", "Coordinate work", "Read activity, message Leads, answer questions, start work and set the project's checks."], ["observe", "Observe only", "Read activity. No messages or new work."]] as const).map(([value, label, detail]) =>
              <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: mode === value, disabled: locked }} accessibilityLabel={label} disabled={locked} onPress={() => setMode(value)}
                style={{ padding: 12, gap: 4, borderRadius: 8, borderWidth: 1, borderColor: mode === value ? c.accent : c.border, backgroundColor: c.surface1 }}>
                <Text style={{ ...text, fontWeight: "600" }}>{mode === value ? "●" : "○"} {label}</Text><Text style={muted}>{detail}</Text>
              </Pressable>)}
          </View> : <Text style={{ ...muted, fontSize: 12 }}>Your Supervisor can run the team here. Merging finished work into your branch is always your call.</Text>}
        </>}
      </View>
      {step === 1 ? <View style={{ ...row, justifyContent: "flex-end", padding: 16, borderTopWidth: 1, borderColor: c.border }}>
        <Button label="Back" theme={theme} disabled={locked || Boolean(initialRoot)} onPress={() => setStep(0)} />
        <Button label={busy ? "Saving…" : existing ? "Save" : "Add project"} tone="accent" theme={theme} disabled={locked || !root} onPress={() => void finish()} />
      </View> : null}
    </Modal.Content>
  </Modal>;
}
