import { type TeamBrief, count } from "../../shared/brief.ts";
import type { Binding } from "../../shared/supervision.ts";
import type { SeatView } from "../core/ports.ts";
import type { Ledger } from "../desk/ledger.ts";
import type { LaneReport } from "./landing.ts";

/** What git and the event log say about a project, beyond its ledger. */
export type Look = { reports(root: string): Map<string, LaneReport>; diff(root: string, lane: Ledger["lanes"][string]): string | null; teamFiles(root: string): string[];
  /** Agents whose last turn failed: their role and the error. */
  failures?(): ReadonlyMap<string, { role: string; message: string }> };
const blind: Look = { reports: () => new Map(), diff: () => null, teamFiles: () => [] };
type Failing = { project: string; role: string; model: string; message: string };

/** Many agents failing on one model is one problem for the Human: which model, where, and the way out. */
function modelCards(failing: Failing[], folded: Map<string, number>): TeamBrief["items"] {
  const byModel = new Map<string, Failing[]>();
  for (const f of failing) byModel.set(f.model, [...(byModel.get(f.model) ?? []), f]);
  return [...byModel].map(([model, list]) => {
    const roles = new Map<string, number>();
    for (const f of list) roles.set(f.role, (roles.get(f.role) ?? 0) + 1);
    const who = [...roles].map(([role, n]) => n === 1 ? `a ${role}` : count(n, role)).join(" and ");
    const projects = [...new Set(list.map((f) => f.project))];
    const quiet = folded.get(model) ?? 0;
    return { id: `models:${model}`, project: projects.join(", "), kind: "error" as const, agent: null, action: "models" as const,
      title: "An AI model isn't working",
      plain: `${who[0]!.toUpperCase()}${who.slice(1)} in ${projects.join(" and ")} stopped because the model ${model} gave an error. Pick another model in Team & models, then ask your Supervisor to start the work again.${quiet ? ` ${count(quiet, "team question")} about this ${quiet === 1 ? "is" : "are"} folded into this card.` : ""}`,
      detail: list.map((f) => `${f.role} in ${f.project}: ${f.message}`).join("\n").slice(0, 600) };
  });
}

export function teamBrief(binding: Binding, seats: SeatView[], read: (root: string) => Ledger, held: { to: string }[], look: Look = blind, signIn?: string): TeamBrief {
  const result: TeamBrief = { supervisor: binding.supervisor?.agent ?? null, workspace: binding.supervisor?.workspace ?? null, active: binding.active, signIn: null,
    lines: 0, needsYou: 0, questions: 0, held: 0, projects: [], items: [], omitted: 0 };
  if (!binding.active || !binding.supervisor) return result;
  const byId = new Map(seats.filter(s => !s.archivedAt).map(s => [s.id, s]));
  const seen = new Set<string>();
  const permissions = (id: string, name: string) => {
    const seat = byId.get(id);
    if (!seat || seen.has(id)) return;
    seen.add(id);
    for (const [i, p] of (seat.pendingPermissions ?? []).entries()) {
      result.needsYou++;
      result.items.push({ id: `permission:${id}:${i}`, project: name, kind: "permission", agent: id, title: "Waiting on you", plain: "An agent wants your permission before it goes on. Open it to allow or deny the request.", detail: (p.title ?? p.description ?? p.name ?? "Open this agent to answer its permission request.").slice(0, 600) });
    }
  };
  if (signIn) {
    result.signIn = signIn;
    result.needsYou++;
    result.items.push({ id: "supervisor:sign-in", project: "Overall Supervisor", kind: "error", agent: binding.supervisor.agent, action: "reload", title: "Your Supervisor can't sign in", detail: `It answered "${signIn}". Reload it so it starts again with your saved sign-in; nothing you asked is lost, send it again after.` });
  }
  permissions(binding.supervisor.agent, "Overall Supervisor");
  const failures = look.failures?.() ?? new Map();
  const failing: Failing[] = [], folded = new Map<string, number>();
  for (const scope of binding.projects.filter(p => p.grants.includes("observe"))) {
    const start = result.items.length;
    try {
      const ledger = read(scope.root);
      const lanes = Object.values(ledger.lanes).filter(l => l.status === "open");
      const ids = new Set([ ...lanes.flatMap(l => l.lead ? [l.lead] : []), ...scope.leads.map(l => l.agent), ...Object.values(ledger.tasks).filter(t => lanes.some(l => l.id === t.lane) && !["merged","cut"].includes(t.status)).flatMap(t => t.peer ? [t.peer] : []) ]);
      for (const id of ids) permissions(id, scope.name);
      result.lines += lanes.length + scope.leads.filter(lead => !lanes.some(l => l.lead === lead.agent)).length;
      const questions = Object.values(ledger.asks).filter(a => a.status === "open");
      result.questions += questions.length;
      const here = [...ids].flatMap((id) => { const f = failures.get(id), seat = byId.get(id); return f && seat ? [{ project: scope.name, role: f.role, model: seat.model ?? seat.provider, message: f.message }] : []; });
      failing.push(...here);
      const about = (text: string) => here.find((f) => text.includes(f.model) || (f.message.length >= 12 && text.includes(f.message.slice(0, 40))));
      for (const ask of questions) if (about(ask.text)) folded.set(about(ask.text)!.model, (folded.get(about(ask.text)!.model) ?? 0) + 1); else result.items.push({ id: `${scope.id}:${ask.id}`, project: scope.name, kind: "question", agent: byId.has(ask.to) ? ask.to : binding.supervisor.agent, title: "Team question", plain: "A teammate asked your Supervisor something. Your Supervisor usually answers it; open it if you want to answer yourself.", detail: ask.text.slice(0, 600) });
      const reports = look.reports(scope.root);
      // Lanes are often titled "<project>: what it does"; the card already names the project.
      const titleOf = (lane: { title: string }) => lane.title.toLowerCase().startsWith(`${scope.name.toLowerCase()}:`) ? lane.title.slice(scope.name.length + 1).trim() : lane.title;
      for (const lane of lanes) {
        if (lane.approval?.by === "human") {
          const steps = Object.values(ledger.tasks).filter((t) => t.lane === lane.id && t.plan === lane.approval!.plan && t.status !== "cut");
          result.needsYou++;
          result.items.push({ id: `${scope.id}:${lane.id}:plan:${lane.approval.plan}`, project: scope.name, kind: "plan", agent: lane.lead ?? null, scope: scope.id, lane: lane.id, held: true, title: "A plan waits for your approval",
            plain: `Your team planned "${titleOf(lane)}"${steps.length ? ` in ${count(steps.length, "step")}` : ""}. Nothing starts until you approve it. Send it back with a note if something should change.`,
            detail: [...steps.map((t) => `• ${t.title}`), lane.approval.signals.join(" ")].filter(Boolean).join("\n").slice(0, 600) });
        }
        if (lane.landApproval && !lane.landApproval.approved) {
          result.needsYou++;
          result.items.push({ id: `${scope.id}:${lane.id}:land`, project: scope.name, kind: "land", agent: lane.lead ?? null, scope: scope.id, lane: lane.id, held: true, diff: `${lane.branch} → ${lane.base}`, title: "Held for your approval before merging",
            plain: `"${titleOf(lane)}" is finished, and this project asks you before it is merged into ${lane.base}. Approve to merge it now, or send it back with a note.`,
            detail: [...lane.landApproval.signals, ...lane.landApproval.evidence].join("\n").slice(0, 600) });
          continue;
        }
        const report = reports.get(lane.id);
        if (!report?.ready) continue;
        const detail = `${titleOf(lane)}${report.summary ? `\n${report.summary}` : ""}`.slice(0, 600);
        // A lane that carried on the Human's own branch merges nowhere: finishing it runs its gate and closes it.
        const diff = lane.onBranch ? undefined : look.diff(scope.root, lane) ?? undefined;
        const checked = report.gate ? "Its tests passed." : "No tests were set, so nothing checked it.";
        if (report.gate === false) result.items.push({ id: `${scope.id}:${lane.id}:gate`, project: scope.name, kind: "tests", agent: lane.lead ?? null, scope: scope.id, lane: lane.id, diff, title: "Tests failed, so this can't be merged yet", plain: `Nothing to approve yet. "${titleOf(lane)}" is finished, but its tests fail. Open the work chat to see why.`, detail });
        else if (lane.onBranch) result.items.push({ id: `${scope.id}:${lane.id}:land`, project: scope.name, kind: "land", agent: lane.lead ?? null, scope: scope.id, lane: lane.id, stays: true, diff: `Stays on ${lane.branch} · nothing is merged`, title: report.gate ? "Ready to finish · tests passed" : "Ready to finish · no tests set", plain: `Approve to finish "${titleOf(lane)}". The work is already on your branch ${lane.branch}, so nothing is merged: your Supervisor runs the tests once more and wraps it up. ${checked}`, detail });
        else result.items.push({ id: `${scope.id}:${lane.id}:land`, project: scope.name, kind: "land", agent: lane.lead ?? null, scope: scope.id, lane: lane.id, diff: diff ? `${lane.branch} → ${lane.base} · ${diff}` : `${lane.branch} → ${lane.base}`, title: report.gate ? "Ready to merge · tests passed" : "Ready to merge · no tests set", plain: `Approve to add "${titleOf(lane)}" to ${lane.base}${diff ? ` (${diff})` : ""}. ${checked} Your Supervisor merges it and wraps it up.`, detail });
      }
      const teamFiles = look.teamFiles(scope.root);
      if (teamFiles.length) result.items.push({ id: `${scope.id}:team-files`, project: scope.name, kind: "commit", agent: null, scope: scope.id, files: teamFiles, title: "Save the team's instructions?", plain: `Approve to save ${teamFiles.join(" and ")} in the project's history (a git commit). ${teamFiles.length === 1 ? "It holds" : "They hold"} the rules every agent on this project follows. Nothing else is included.`, detail: `Seatworks added its team block to ${teamFiles.join(" and ")}. Committing it keeps every agent and teammate on the same instructions. Only ${teamFiles.length === 1 ? "this file is" : "these files are"} committed.` });
      for (const task of Object.values(ledger.tasks).filter(t => lanes.some(l => l.id === t.lane) && !["merged","cut"].includes(t.status))) {
        if (task.handback?.gate?.ok === false || task.status === "failed") result.items.push({ id: `${scope.id}:${task.id}`, project: scope.name, kind: "tests", agent: ledger.lanes[task.lane]?.lead ?? null, title: "Checks need attention", plain: `Nothing to approve. A step failed its checks and the team is fixing it. Open the work chat to see what went wrong.`, detail: `${task.title}: ${task.handback?.gate?.note ?? "Task reported a failure."}`.slice(0,600) });
        else if (task.status === "done") result.items.push({ id: `${scope.id}:${task.id}`, project: scope.name, kind: "review", agent: ledger.lanes[task.lane]?.lead ?? null, title: "Being reviewed", plain: "Nothing needed from you. A step is done and the team is checking it.", detail: task.title.slice(0,600) });
      }
      const queued = held.filter(l => ids.has(l.to)).length;
      result.held += queued;
      const running = [...ids].filter(id => ["running","starting"].includes(byId.get(id)?.status ?? "")).length;
      const human = result.items.slice(start).filter(i => i.kind === "permission").length;
      const landing = result.items.slice(start).filter(i => i.kind === "plan" || i.kind === "land" || i.kind === "commit").length;
      const waiting = Object.values(ledger.lanes).filter(l => l.status === "waiting");
      const streams = [...lanes.slice(0, 6).map((lane) => {
        const tasks = Object.values(ledger.tasks).filter(t => t.lane === lane.id && t.status !== "cut");
        const merged = tasks.filter(t => t.status === "merged").length;
        const report = reports.get(lane.id);
        const lead = lane.lead ? byId.get(lane.lead) : undefined;
        const state = lane.approval?.by === "human" ? "plan waits for you" : lane.landApproval && !lane.landApproval.approved ? "ready for you" : report?.ready ? (report.gate === false ? "tests failed" : "ready for you")
          : tasks.length ? `${merged} of ${count(tasks.length, "task")} done` : lead && ["running", "starting"].includes(lead.status ?? "") ? "planning" : "waiting";
        return { id: lane.id, title: titleOf(lane).slice(0, 120), state, agent: lane.lead ?? null };
      }), ...waiting.slice(0, Math.max(0, 6 - lanes.length)).map((lane) => ({ id: lane.id, title: titleOf(lane).slice(0, 120), state: lane.after?.length ? "starts when earlier work is merged" : "waiting to start", agent: null }))];
      result.projects.push({ id: scope.id, name: scope.name, streams, status: human ? `Waiting on you: ${count(human, "request")}` : landing ? `${landing} ready for your approval` : questions.length ? count(questions.length, "team question") : queued ? `${count(queued, "message")} waiting for busy teammates` : running ? `${count(running, "agent")} working` : lanes.length ? "Team is idle · work isn't finished" : waiting.length ? `${count(waiting.length, "piece of work", "pieces of work")} waiting to start` : "No active work" });
    } catch {
      result.projects.push({ id: scope.id, name: scope.name, status: "Status unavailable" });
      result.items.push({ id: `${scope.id}:error`, project: scope.name, kind: "error", agent: null, title: "Could not read project status", detail: "Seatworks couldn't read this project's records. Open its settings to check the setup." });
    }
  }
  if (failing.length) { const cards = modelCards(failing, folded); result.needsYou += cards.length; result.items.push(...cards); }
  const rank = (item: TeamBrief["items"][number]) => item.action ? -1 : ["permission", "plan", "land", "tests", "question"].indexOf(item.kind) >>> 0;
  result.items.sort((a,b) => rank(a) - rank(b));
  result.omitted = Math.max(0, result.items.length - 24);
  result.items = result.items.slice(0,24);
  result.projects = result.projects.slice(0,100);
  return result;
}
