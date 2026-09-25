import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, type SettingsInputHandle, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Text } from "react-native";
import { landDecideRpc, planDecideRpc } from "../shared/rpc.ts";
import type { FlowLane } from "./data.ts";

type Decided = { decided?: string; error?: string };
type Decide = (input: { project: string; lane: string; approve: boolean; note: string }) => Promise<Decided>;

const waited = (minutes: number) => (minutes < 1 ? "since just now" : `${minutes} min`);

/** Something held for the Human: their word comes from here and nowhere else, since no seat may give it for them. */
function Held({ project, lane, decide, label, hint, approved, sentBack, theme }: { project: string; lane: string; decide: Decide; label: string; hint: string; approved: string; sentBack: string; theme: PluginTheme }) {
  const field = useRef<SettingsInputHandle>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Decided | null>(null);
  const send = (approve: boolean) => {
    setBusy(true);
    void decide({ project, lane, approve, note })
      .then((answer) => {
        setSaid(answer);
        if (answer.decided) field.current?.replaceText("");
      })
      .catch((error: unknown) => setSaid({ error: error instanceof Error ? error.message : String(error) }))
      .finally(() => setBusy(false));
  };
  return (
    <SettingsCard>
      <SettingsRow label={label} hint={hint} />
      <SettingsInput ref={field} label="Note for the Lead" hint="Say what to change when you send it back; optional when you approve." placeholder="What should change" onChangeText={setNote} disabled={busy} />
      <SettingsAction label="Approve" hint={approved} actionLabel="Approve" onPress={() => send(true)} disabled={busy} />
      <SettingsAction label="Send back" hint={sentBack} actionLabel="Send back" onPress={() => send(false)} disabled={busy} />
      {said ? <Text style={{ color: said.error ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>{said.error ?? said.decided}</Text> : null}
    </SettingsCard>
  );
}

export function ApprovalsCards({ project, lanes, theme }: { project: string; lanes: FlowLane[]; theme: PluginTheme }) {
  const plan = useRpc(planDecideRpc) as unknown as Decide;
  const land = useRpc(landDecideRpc) as unknown as Decide;
  return (
    <>
      {lanes.map((lane) =>
        lane.approval?.by === "human" ? (
          <Held
            key={`${lane.id}:plan:${lane.approval.plan}`}
            project={project}
            lane={lane.id}
            decide={plan}
            theme={theme}
            label={`Plan ${lane.approval.plan} of ${lane.id} ${lane.title} waits for you`}
            hint={`${lane.approval.signals.join(" ") || "This project approves every plan before it runs."} Waiting ${waited(lane.approval.minutes)}; open the lane above to read its tasks.`}
            approved="Its tasks start as what each waits for is accepted."
            sentBack="Its tasks are cut, and the Lead plans again with your note."
          />
        ) : null,
      )}
      {lanes.map((lane) =>
        lane.landApproval && !lane.landApproval.approved ? (
          <Held
            key={`${lane.id}:land`}
            project={project}
            lane={lane.id}
            decide={land}
            theme={theme}
            label={`${lane.id} ${lane.title} waits for you to land it on ${lane.base ?? "its base"}`}
            hint={`${lane.landApproval.signals.join(" ") || "This project approves every landing."} ${lane.landApproval.evidence.join(" ")} Waiting ${waited(lane.landApproval.minutes)}; the branch is ${lane.branch}.`}
            approved="It lands now, as the project lands lanes; if something stops it, it lands when the Supervisor closes the lane again."
            sentBack="Nothing lands; the lane stays open and its Lead gets your note."
          />
        ) : null,
      )}
    </>
  );
}
