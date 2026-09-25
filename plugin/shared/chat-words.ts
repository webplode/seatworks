import { z } from "zod";

/** What a chat shows in place of a message the team's desk or the Seatworks UI wrote for an agent: one plain line each, the original kept behind a toggle. */
export const LetterSchema = z.object({ project: z.string().nullable(), lines: z.array(z.string()), mine: z.boolean(), raw: z.string() });
export type PlainLetter = z.infer<typeof LetterSchema>;
/** What a chat shows in place of a call to one of the team's own tools. */
export const StepSchema = z.object({ label: z.string(), status: z.enum(["running", "completed", "failed", "canceled"]), raw: z.string() });
export type PlainStep = z.infer<typeof StepSchema>;

const first = (text: string) => (text.split("\n").find((l) => l.trim()) ?? "").trim();
const short = (text: string, limit = 140) => { const t = text.replace(/\s+/g, " ").trim(); return t.length <= limit ? t : `${t.slice(0, limit).trimEnd()}…`; };
const quoted = (text: string) => `"${short(text, 100)}"`;
/** "L1 (Add greet(name) with node test)" → the title inside the outer parentheses. */
const titled = (rest: string) => { const open = rest.indexOf("("), close = rest.lastIndexOf(")"); return open >= 0 && close > open ? rest.slice(open + 1, close) : rest; };

/** One letter's head line, in the words a person uses. `body` is everything after the head. */
function sentence(head: string, body: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = head.match(/^OWNER DIRECTIVE [A-Z]+[0-9][\w-]*: (.+)$/))) return `A Lead was given new work: ${quoted(m[1]!)}.`;
  if ((m = head.match(/^TASK [A-Z]+[0-9][\w-]*: (.+)$/))) return `A teammate was given a task: ${quoted(m[1]!)}.`;
  if ((m = head.match(/^REVIEW [A-Z]+[0-9][\w-]*(?: of [A-Z]+[0-9][\w-]*)?: (.+)$/))) return `A reviewer was asked to check ${quoted(m[1]!)}.`;
  if (/^ANSWER to your \w+ call/.test(head)) return "A slow step finished.";
  if (/^ANSWER to your ask/.test(head)) return `The question got an answer: ${quoted(first(body))}.`;
  if ((m = head.match(/^HANDBACK [A-Z]+[0-9][\w-]* (\(.+\))/))) return `A teammate finished ${quoted(titled(m[1]!))} and handed it back.`;
  if (/^ASK [A-Z]+[0-9][\w-]* \(/.test(head)) return `A teammate asks: ${quoted(first(body))}`;
  if (/^ANSWERED FOR YOU/.test(head)) return "Someone else answered a question that was waiting.";
  if (/^MESSAGE from/.test(head)) return `Message: ${quoted(first(body))}`;
  if (/^RECONCILE/.test(head)) return "The Supervisor spoke to a teammate directly.";
  if ((m = head.match(/^MERGE FAILED [A-Z]+[0-9][\w-]* (.+?\)):/))) return `A task couldn't be added to the work: ${quoted(titled(m[1]!))}.`;
  if ((m = head.match(/^MERGE CONFLICT [A-Z]+[0-9][\w-]* (.+?\)) with/))) return `A task clashes with other changes: ${quoted(titled(m[1]!))}.`;
  if ((m = head.match(/^MERGED [A-Z]+[0-9][\w-]* (.+?\))/))) return `A finished task was added to the work: ${quoted(titled(m[1]!))}.`;
  if (/^REWORK requested/.test(head)) return `The Lead asked for changes: ${quoted(first(body))}`;
  if (/^STOP:/.test(head)) return "This task was stopped.";
  if (/^Your turn ended without calling/.test(head)) return "A reminder to report back.";
  if ((m = head.match(/^SILENT [A-Z]+[0-9][\w-]* (.+?\)):/))) return `A teammate went quiet on ${quoted(titled(m[1]!))}.`;
  if ((m = head.match(/^FAILED: .+? ended its turn with an error: (.+)$/))) return `An agent stopped with an error: ${quoted(m[1]!)}`;
  if (/^WAITING FOR PERMISSION/.test(head)) return "An agent is waiting for permission.";
  if ((m = head.match(/^LANE IDLE [A-Z]+[0-9][\w-]* (.+?\)):/))) return `Work has stalled: ${quoted(titled(m[1]!))}.`;
  if (/^INCIDENT /.test(head)) { const seen = body.match(/^What was seen: (.+)$/m); return `The watcher flagged something to check${seen ? `: ${quoted(seen[1]!)}` : "."}`; }
  if ((m = head.match(/^REPORT [A-Z]+[0-9][\w-]* (.+?\)): (ready to land|not ready)/))) return m[2] === "ready to land" ? `Work is ready for your approval: ${quoted(titled(m[1]!))}.` : `Progress update on ${quoted(titled(m[1]!))}.`;
  if ((m = head.match(/^CAN LAND [A-Z]+[0-9][\w-]* (.+?\)):/))) return `Work can be merged now: ${quoted(titled(m[1]!))}.`;
  if (/^CLEARED /.test(head)) return "Work that another piece of work was waiting on is done.";
  if ((m = head.match(/^AMENDED [A-Z]+[0-9][\w-]* (.+?\)):/))) return `The plan changed for ${quoted(titled(m[1]!))}.`;
  if ((m = head.match(/^LEAD GONE [A-Z]+[0-9][\w-]* (.+?\)):/))) return `The Lead of ${quoted(titled(m[1]!))} stopped, so that work is paused.`;
  if (/^You take over /.test(head)) return "A new Lead takes over work from one that stopped.";
  if (/^NOT OPENED /.test(head)) return "A piece of work couldn't start.";
  if (/^OPENED /.test(head)) return "A piece of work started after a restart.";
  if ((m = head.match(/^WAITING [A-Z]+[0-9][\w-]* (.+?\)),/))) return `${quoted(titled(m[1]!))} is waiting on other work.`;
  if (/^STILL OPEN after/.test(head)) return "A question is still waiting for an answer.";
  if (/^UNANSWERED /.test(head)) return "A teammate is still waiting on its Lead for an answer.";
  if (/^READING /.test(head)) return "The watcher checked on an agent.";
  if (/^You are seated on this project/.test(head)) return "The watcher started.";
  if (/^The Human selected supervision revision/.test(head)) return "Your project list or permissions changed.";
  if ((m = head.match(/^PLAN \d+ of [A-Z]+[0-9][\w-]* (\(.+?\)) waits for (the Human's|your) approval/))) return m[2] === "the Human's" ? `The plan for ${quoted(titled(m[1]!))} waits for your approval.` : `The plan for ${quoted(titled(m[1]!))} is waiting to be approved.`;
  if ((m = head.match(/^APPROVED plan \d+ of [A-Z]+[0-9][\w-]* (\(.+?\))/))) return `The plan for ${quoted(titled(m[1]!))} was approved.`;
  if ((m = head.match(/^SENT BACK plan \d+ of [A-Z]+[0-9][\w-]* (\(.+?\)):/))) return `The plan for ${quoted(titled(m[1]!))} was sent back for changes.`;
  if ((m = head.match(/^LAND HELD [A-Z]+[0-9][\w-]* (\(.+?\)): the owner/))) return `${quoted(titled(m[1]!))} is held for a closer look before it is merged.`;
  if ((m = head.match(/^LAND SENT BACK [A-Z]+[0-9][\w-]* (\(.+?\)):/))) return `Merging ${quoted(titled(m[1]!))} was sent back for changes.`;
  if ((m = head.match(/^LANDED [A-Z]+[0-9][\w-]* (\(.+?\)) after the Human approved it/))) return `${quoted(titled(m[1]!))} was merged after you approved it.`;
  if ((m = head.match(/^HELD AGAIN [A-Z]+[0-9][\w-]* (\(.+?\)): the Human approved it/))) return `You approved ${quoted(titled(m[1]!))}, but merging it turned up more to check.`;
  if ((m = head.match(/^CHANGED [A-Z]+[0-9][\w-]* (\(.+?\)) after its landing was held/))) return `${quoted(titled(m[1]!))} changed after it was held, so it needs approving again.`;
  if ((m = head.match(/^APPROVED [A-Z]+[0-9][\w-]* (\(.+?\)) for landing by the Human/))) return `You approved ${quoted(titled(m[1]!))}, but it can't be merged yet.`;
  if ((m = head.match(/^SENT BACK [A-Z]+[0-9][\w-]* (\(.+?\)) by the Human/))) return `You sent ${quoted(titled(m[1]!))} back for changes.`;
  if ((m = head.match(/^CRITIQUE [A-Z]+[0-9][\w-]* (\(.+?\)): (\d+) point/))) return `A second reader found ${m[2] === "1" ? "1 point" : `${m[2]} points`} where ${quoted(titled(m[1]!))} may not match what you asked.`;
  if (/^Read lane [A-Z]+[0-9][\w-]* against what the Human wrote/.test(head)) return "A second reader was asked to check the new work against your own words.";
  if (/^CHECK DIGEST /.test(head)) return "A safety check has a summary of how it has been doing.";
  if ((m = head.match(/^NOT STARTED [A-Z]+[0-9][\w-]* (\(.+?\)):/))) return `A task was dropped because it never started: ${quoted(titled(m[1]!))}.`;
  return null;
}

/** Messages the Seatworks UI itself sends for the Human. */
function mine(text: string): PlainLetter | null {
  let m = text.match(/^Human objective for project (\S+) \([^)]*\):\n([\s\S]*?)\n\nInspect current activity\./);
  if (m) return { project: m[1]!, lines: [m[2]!.trim()], mine: true, raw: text };
  m = text.match(/^The Human approved landing (?:this lane|these lanes)\. Close each with land: true now, one at a time:\n((?:- .+\n?)+)/);
  if (m) { const lanes = m[1]!.trim().split("\n"); return { project: lanes.length === 1 ? lanes[0]!.match(/ in project (\S+) /)?.[1] ?? null : null, lines: [lanes.length === 1 ? "You approved merging this work." : `You approved merging ${lanes.length} pieces of work.`], mine: true, raw: text }; }
  m = text.match(/^The Human approved landing L\S+ in project (\S+) /);
  if (m) return { project: m[1]!, lines: ["You approved merging this work."], mine: true, raw: text };
  return null;
}

/** A message in a chat that the desk or the UI wrote, turned into plain lines; null for anything a person typed. */
export function plainLetter(text: string): PlainLetter | null {
  const own = mine(text);
  if (own) return own;
  let body = text.replace(/^\d+ messages\n\n/, "");
  let asks = 0;
  const open = body.indexOf("\n\n---\n\nOpen asks waiting on you:\n");
  if (open >= 0) { asks = body.slice(open).split("\n").filter((l) => l.startsWith("- ")).length; body = body.slice(0, open); }
  let project: string | null = null;
  const lines: string[] = [];
  for (const part of body.split("\n\n---\n\n")) {
    let rest = part.replace(/^\[Delivery [^\]]+\]\n/, "");
    const scoped = rest.match(/^\[Project (\S+)\] ?\n?/);
    if (scoped) { project ??= scoped[1]!; rest = rest.slice(scoped[0].length); }
    const head = first(rest);
    const said = sentence(head, rest.slice(rest.indexOf(head) + head.length));
    if (!said) return null;
    lines.push(said);
  }
  if (!lines.length) return null;
  if (asks) lines.push(asks === 1 ? "1 question is still waiting for an answer." : `${asks} questions are still waiting for an answer.`);
  return { project, lines, mine: false, raw: text };
}

const steps: Record<string, [running: string, done: string]> = {
  status: ["Checking on the team", "Checked on the team"],
  incidents: ["Looking at problems the team hit", "Looked at problems the team hit"],
  activity: ["Reading what an agent has been doing", "Read what an agent has been doing"],
  open_lane: ["Starting new work", "Started new work"],
  close_lane: ["Closing finished work", "Closed finished work"],
  amend_lane: ["Changing the plan", "Changed the plan"],
  replace_lead: ["Putting a new Lead on the work", "Put a new Lead on the work"],
  set_project: ["Updating project settings", "Updated project settings"],
  message: ["Sending a message to the team", "Sent a message to the team"],
  answer: ["Answering a teammate", "Answered a teammate"],
  ack: ["Marking a problem as checked", "Marked a problem as checked"],
  acknowledge: ["Confirming a message was read", "Confirmed a message was read"],
  coordinate: ["Linking work across projects", "Linked work across projects"],
  start_task: ["Giving a teammate a task", "Gave a teammate a task"],
  start_review: ["Asking for a review", "Asked for a review"],
  accept: ["Accepting a teammate's work", "Accepted a teammate's work"],
  rework: ["Sending work back for changes", "Sent work back for changes"],
  amend_task: ["Changing a task", "Changed a task"],
  cut: ["Dropping a task", "Dropped a task"],
  ask: ["Asking a question", "Asked a question"],
  report: ["Reporting progress", "Reported progress"],
  done: ["Handing back finished work", "Handed back finished work"],
  raise: ["Flagging something to check", "Flagged something to check"],
  judge: ["Checking a flagged step", "Checked a flagged step"],
  approve_plan: ["Deciding on a plan", "Decided on a plan"],
  plan_tasks: ["Laying out the plan", "Laid out the plan"],
  findings: ["Handing in what it found", "Handed in what it found"],
};

/** `mcp__team__status`, `team__status`, `team.status` or `team_status` → the tool's own name, if it is one of the team's. */
export function teamTool(name: string): string | null {
  const m = name.match(/^(?:mcp__)?team(?:__|\.|_|\/)([a-z_]+)$/);
  return m && steps[m[1]!] ? m[1]! : null;
}

export function plainStep(name: string, status: PlainStep["status"], input: unknown): PlainStep | null {
  const tool = teamTool(name);
  if (!tool) return null;
  const [running, done] = steps[tool]!;
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const label = tool === "close_lane" && args.land === true ? (status === "running" ? "Merging finished work" : "Merged finished work")
    : status === "running" ? `${running}…` : status === "completed" ? done : `${running}: didn't go through`;
  return { label, status, raw: `${name} ${short(JSON.stringify(input ?? {}), 600)}` };
}
