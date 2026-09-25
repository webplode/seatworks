import type { CheckpointMode, Team } from "../catalog/team.ts";
import type { SeatView } from "../core/paseo.ts";
import { digestOf, runsOf } from "./checkpoints.ts";
import { type Lane, type Ledger, ownCopyHolder } from "./ledger.ts";
import { type Project, type ProjectConfig, projectOf } from "./project.ts";


const minutes = (now: number, at: number | string) => Math.max(0, Math.round((now - (typeof at === "string" ? Date.parse(at) : at)) / 60_000));

function seatLine(seats: Map<string, SeatView>, id: string | undefined, now: number): string {
  if (!id) return "none";
  const seat = seats.get(id);
  if (!seat) return `${id} gone`;
  return seat.status === "idle" ? `${id} idle ${minutes(now, seat.updatedAt)} min` : `${id} ${seat.status}`;
}

/** What the status tool read from the project's own checkout; `work` is undefined when git could not say. */
export type OwnCopy = { branch?: string; head?: string; work?: string[] };

const SHOWN_FILES = 10;
const SHOWN_OUTCOME = 300;

/** Names a choice for the Human only where one is real: uncommitted work, or a branch that is not the base, with no lane in the copy. */
function ownCopyLines(project: Project, ledger: Ledger, config: ProjectConfig, copy: OwnCopy): string[] {
  const at = copy.branch ? `on ${copy.branch}` : `not on a branch (detached at ${copy.head ?? "an unknown commit"})`;
  const work = copy.work ? [...copy.work].sort() : undefined;
  const more = work && work.length > SHOWN_FILES ? `, and ${work.length - SHOWN_FILES} more` : "";
  const state = !work ? "and git could not say what is uncommitted" : work.length === 0 ? "clean" : `with ${work.length} uncommitted ${work.length === 1 ? "file" : "files"}: ${work.slice(0, SHOWN_FILES).join(", ")}${more}`;
  const holder = ownCopyHolder(Object.values(ledger.lanes));
  const held = holder?.status === "open" ? `Lane ${holder.id} is working in it.` : holder ? `Lane ${holder.id} is closed, and its Lead is ending a turn in it; it goes back to ${holder.base} after.` : "No lane is working in it.";
  const lines = ["## The project's own copy", "", `${project.root} is ${at}, ${state}.`, held];
  if (!holder && copy.branch && work) {
    if (work.length > 0) lines.push(`The Human decides where the next lane works, before it opens: carry on ${copy.branch} here, a new branch that takes the uncommitted work along, or a new branch that leaves it where it is.`);
    else if (config.base && copy.branch !== config.base) lines.push(`The Human decides where the next lane works, before it opens: carry on ${copy.branch} here, or a new branch off ${config.base}.`);
  }
  lines.push("");
  return lines;
}

/** What each checkpoint is set to and what its log holds, so a shadow period can be read before it is turned on. */
function checkLines(project: Project, checks: Team["checkpoints"]): string[] {
  const line = (checkpoint: "plan" | "land", set: CheckpointMode, approval: string, holds: boolean) => {
    const { runs, held, asked, last } = runsOf(project, checkpoint);
    const kept = runs === 0 ? "nothing checked yet" : `${runs} checked, ${holds ? `${held} ${set === "on" ? "held" : "would have been held"}, ` : ""}${asked} ${set === "on" ? "sent for approval" : "would have been sent for approval"}${last ? `; last flagged ${last.lane} at ${last.at}: ${(last.findings[0] ?? "").replace(/[.!?]+$/, "")}` : ""}`;
    const digest = digestOf(project, checkpoint, checks.forced ? "on" : set).lines.map((text) => `  ${text}`);
    return [`- ${checkpoint}: ${checks.forced ? `on, because ${checks.forced}` : set}. ${set === "off" && !checks.forced ? "Nothing is checked." : `${approval}. In checkpoints.log: ${kept}.`}`, ...digest].join("\n");
  };
  return [
    "## Checkpoints",
    "",
    line("plan", checks.plan, `Plans are approved ${checks.approve === "every" ? "every time" : "when they touch risky paths"}, by ${checks.approver === "human" ? "the Human on the panel" : "the Supervisor"}`, true),
    line("land", checks.land, `Landings are approved ${checks.landApprove === "every" ? "every time" : "when something in them should be seen first"}, by the Human on the panel`, false),
    "",
  ];
}

function laneAim(lane: Lane): string[] {
  const outcome = lane.outcome.replace(/\s+/g, " ").trim();
  return [
    `Outcome: ${outcome.length > SHOWN_OUTCOME ? `${outcome.slice(0, SHOWN_OUTCOME).trimEnd()}…` : outcome}`,
    `Writes: ${lane.writeSet.join(", ") || "not declared, so taken to reach every path this project keeps to one writer"}`,
    ...(lane.contracts.length > 0 ? [`Depends on: ${lane.contracts.join(", ")}`] : []),
  ];
}

export function statusText(
  project: Project,
  ledger: Ledger,
  config: ProjectConfig,
  seats: Map<string, SeatView>,
  now: number,
  { laneId, waiting = [], held = [], copy, checks }: { laneId?: string; waiting?: SeatView[]; held?: { to: string; text: string; at: number }[]; copy?: OwnCopy; checks?: Team["checkpoints"] } = {},
): string {
  const gate = config.gate || (config.gate === "" ? "none, by this project's own choice" : "none");
  const lines = [`# Status: ${project.root}`, "", `Updated ${new Date(now).toISOString()}. Base ${config.base ?? "unset"}. Gate ${gate}. Lanes land as ${config.landAs}.`, ""];
  if (copy) lines.push(...ownCopyLines(project, ledger, config, copy));
  if (checks) lines.push(...checkLines(project, checks));
  // One outbox holds every project's mail: a seated recipient belongs to its copy's project, a gone one to this project's record.
  const mine = held.filter((letter) => {
    const seat = seats.get(letter.to);
    return seat ? Boolean(seat.cwd) && projectOf(seat.cwd).slug === project.slug : Boolean(ledger.agents[letter.to]);
  });
  const stranded = mine.filter((letter) => !seats.has(letter.to));
  const queued = mine.filter((letter) => seats.has(letter.to));
  if (stranded.length > 0) {
    lines.push("## Mail with nobody to read it", "", "The seat each of these was addressed to is gone. Nothing is lost; they are held until a seat can take them.", "");
    for (const letter of stranded) {
      const first = letter.text.split(/\r?\n/).find((line) => line.trim()) ?? "";
      lines.push(`- to ${letter.to}, waiting ${minutes(now, letter.at)} min: ${first.slice(0, 160)}`);
    }
    lines.push("");
  }
  // Held for a seat that is there but has not taken it: this is where a letter going nowhere shows.
  if (queued.length > 0) {
    lines.push("## Mail waiting to be taken", "", "The seat is there and has not read these yet.", "");
    for (const letter of queued) lines.push(`- to ${letter.to}, waiting ${minutes(now, letter.at)} min (${seats.get(letter.to)?.status ?? "unknown"})`);
    lines.push("");
  }
  if (waiting.length > 0) {
    lines.push("## Waiting on the Human", "");
    for (const seat of waiting) {
      const asked = (seat.pendingPermissions ?? []).map((request) => request.title ?? request.name ?? "a request").join("; ");
      lines.push(`- ${seat.title ?? seat.id} (${seat.id}): ${asked}`);
    }
    lines.push("");
  }
  const lanes = Object.values(ledger.lanes).filter((lane) => (laneId ? lane.id === laneId : true));
  const open = lanes.filter((lane) => lane.status === "open");
  if (open.length === 0) lines.push("No open lanes.", "");
  for (const lane of open) {
    const detour = lane.detourOf ? ` Clearing the way for ${lane.detourOf}.` : "";
    const land = lane.landApproval;
    const approval = [
      ...(lane.approval
        ? [`Plan ${lane.approval.plan} waits ${minutes(now, lane.approval.since)} min for approval by ${lane.approval.by === "human" ? "the Human, on the panel" : "the owner"}: ${lane.approval.signals.join(" ") || "every plan here is approved first."} None of its tasks starts until then.`]
        : []),
      ...(lane.ready ? [`Reported ready ${minutes(now, lane.ready.at)} min ago.`] : []),
      ...(land?.approved
        ? [`Landing approved by the Human ${minutes(now, land.approved.at)} min ago; close_lane with land true lands it.`]
        : land
          ? [`Landing waits ${minutes(now, land.since)} min for the Human's approval: ${land.signals.join(" ") || "every landing here is approved first."}`]
          : []),
    ];
    lines.push(`## ${lane.id} ${lane.title}`, "", `Branch ${lane.branch}${lane.onBranch ? ", carried on in the project's own copy" : ` off ${lane.base}`}. Lead ${seatLine(seats, lane.lead, now)}.${detour}`, ...approval, ...(copy ? laneAim(lane) : []), "");
    const tasks = Object.values(ledger.tasks).filter((task) => task.lane === lane.id);
    if (tasks.length === 0) lines.push("- no tasks yet");
    for (const task of tasks) {
      const detail = ["running", "rework"].includes(task.status)
        ? `, Peer ${seatLine(seats, task.peer, now)}`
        : task.status === "waiting"
          ? `${task.after?.length ? `, after ${task.after.join(", ")}` : ""}${task.held ? `. Not started: ${task.held.why}` : ""}`
          : task.handback
            ? `, hand-back ${minutes(now, task.handback.at)} min ago`
            : "";
      // A plan waiting for approval is judged on what each task is for and what it will write, not on its titles.
      const judged = lane.approval && task.plan === lane.approval.plan ? [`  Goal: ${task.goal}`, `  Owns: ${task.owned.join(", ")}${task.mode === "parallel" ? ", in parallel" : ""}`] : [];
      lines.push(`- ${task.id} ${task.title}: ${task.status}${detail}`, ...judged);
    }
    lines.push("");
  }
  const pending = lanes.filter((lane) => lane.status === "waiting");
  if (pending.length > 0) lines.push("## Waiting lanes", "");
  for (const lane of pending) {
    const after = (lane.after ?? []).map((id) => {
      const other = ledger.lanes[id];
      return `${id} ${other?.status === "closed" ? (other.landed ? "landed" : "closed without landing") : (other?.status ?? "gone")}`;
    });
    lines.push(`- ${lane.id} ${lane.title}: after ${after.join(", ")}${lane.held ? `. Not open: ${lane.held.why}` : ""}`, ...(copy ? laneAim(lane).map((line) => `  ${line}`) : []));
  }
  if (pending.length > 0) lines.push("");
  if (!laneId) {
    const slots = Object.values(ledger.slots ?? {});
    if (slots.length > 0) {
      lines.push("## Working copies", "");
      for (const slot of slots) lines.push(`- ${slot.id} ${slot.path}: ${slot.lane ? `lane ${slot.lane}` : slot.task ? `task ${slot.task}` : "free"}`);
      lines.push("");
    }
  }
  const asks = Object.values(ledger.asks).filter((ask) => ask.status === "open" && (laneId ? ask.lane === laneId : true));
  lines.push("## Open asks", "");
  if (asks.length === 0) lines.push("None.");
  for (const ask of asks) {
    const first = ask.text.split(/\r?\n/).find((line) => line.trim()) ?? "";
    lines.push(`- ${ask.id} ${ask.kind} from ${ask.fromRole} ${ask.from} to ${ask.to}, open ${minutes(now, ask.openedAt)} min: ${first.slice(0, 160)}`);
  }
  if (!laneId) {
    const closed = lanes.filter((lane) => lane.status === "closed").slice(-5);
    if (closed.length > 0) {
      lines.push("", "## Recently closed", "");
      for (const lane of closed) lines.push(`- ${lane.id} ${lane.title} (${lane.branch})`);
    }
  }
  return `${lines.join("\n")}\n`;
}
