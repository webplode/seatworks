import type { SeatView } from "../core/paseo.ts";
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
  { laneId, waiting = [], held = [], copy }: { laneId?: string; waiting?: SeatView[]; held?: { to: string; text: string; at: number }[]; copy?: OwnCopy } = {},
): string {
  const gate = config.gate || (config.gate === "" ? "none, by this project's own choice" : "none");
  const lines = [`# Status: ${project.root}`, "", `Updated ${new Date(now).toISOString()}. Base ${config.base ?? "unset"}. Gate ${gate}.`, ""];
  if (copy) lines.push(...ownCopyLines(project, ledger, config, copy));
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
    lines.push(`## ${lane.id} ${lane.title}`, "", `Branch ${lane.branch}${lane.onBranch ? ", carried on in the project's own copy" : ` off ${lane.base}`}. Lead ${seatLine(seats, lane.lead, now)}.${detour}`, ...(copy ? laneAim(lane) : []), "");
    const tasks = Object.values(ledger.tasks).filter((task) => task.lane === lane.id);
    if (tasks.length === 0) lines.push("- no tasks yet");
    for (const task of tasks) {
      const detail = ["running", "rework"].includes(task.status)
        ? `, Peer ${seatLine(seats, task.peer, now)}`
        : task.status === "waiting"
          ? `, after ${(task.after ?? []).join(", ")}${task.held ? `. Not started: ${task.held.why}` : ""}`
          : task.handback
            ? `, hand-back ${minutes(now, task.handback.at)} min ago`
            : "";
      lines.push(`- ${task.id} ${task.title}: ${task.status}${detail}`);
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
