import { type TeamBrief, count } from "../../shared/brief.ts";
import type { Binding } from "../../shared/supervision.ts";
import type { SeatView } from "../core/ports.ts";
import type { Ledger } from "../desk/ledger.ts";
import type { LaneReport } from "./landing.ts";

/** What git and the event log say about a project, beyond its ledger. */
export type Look = { reports(root: string): Map<string, LaneReport>; diff(root: string, lane: Ledger["lanes"][string]): string | null; teamFiles(root: string): string[] };
const blind: Look = { reports: () => new Map(), diff: () => null, teamFiles: () => [] };

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
      for (const ask of questions) result.items.push({ id: `${scope.id}:${ask.id}`, project: scope.name, kind: "question", agent: byId.has(ask.to) ? ask.to : binding.supervisor.agent, title: "Team question", plain: "A teammate asked your Supervisor something. Your Supervisor usually answers it; open it if you want to answer yourself.", detail: ask.text.slice(0, 600) });
      const reports = look.reports(scope.root);
      for (const lane of lanes) {
        const report = reports.get(lane.id);
        if (!report?.ready) continue;
        const detail = `${lane.title}${report.summary ? `\n${report.summary}` : ""}`.slice(0, 600);
        // A lane that carried on the Human's own branch merges nowhere: finishing it runs its gate and closes it.
        const diff = lane.onBranch ? undefined : look.diff(scope.root, lane) ?? undefined;
        const checked = report.gate ? "Its tests passed." : "No tests were set, so nothing checked it.";
        if (report.gate === false) result.items.push({ id: `${scope.id}:${lane.id}:gate`, project: scope.name, kind: "tests", agent: lane.lead ?? null, scope: scope.id, lane: lane.id, diff, title: "Tests must pass before this can land", plain: `Nothing to approve yet. "${lane.title}" is finished, but its tests fail. Open the Lead to see why.`, detail });
        else if (lane.onBranch) result.items.push({ id: `${scope.id}:${lane.id}:land`, project: scope.name, kind: "land", agent: lane.lead ?? null, scope: scope.id, lane: lane.id, stays: true, diff: `Stays on ${lane.branch} · nothing is merged`, title: report.gate ? "Ready to finish · tests passed" : "Ready to finish · no tests set", plain: `Approve to finish "${lane.title}". The work already sits on ${lane.branch}, so nothing is merged: your Supervisor runs the tests once more and closes this work stream. ${checked}`, detail });
        else result.items.push({ id: `${scope.id}:${lane.id}:land`, project: scope.name, kind: "land", agent: lane.lead ?? null, scope: scope.id, lane: lane.id, diff: diff ? `${lane.branch} → ${lane.base} · ${diff}` : `${lane.branch} → ${lane.base}`, title: report.gate ? "Ready to land · tests passed" : "Ready to land · no tests set", plain: `Approve to merge "${lane.title}" into ${lane.base}${diff ? ` (${diff})` : ""}. ${checked} Your Supervisor merges it and closes this work stream.`, detail });
      }
      const teamFiles = look.teamFiles(scope.root);
      if (teamFiles.length) result.items.push({ id: `${scope.id}:team-files`, project: scope.name, kind: "commit", agent: null, scope: scope.id, files: teamFiles, title: "Commit the team instructions?", plain: `Approve to commit ${teamFiles.join(" and ")} in ${scope.name}. ${teamFiles.length === 1 ? "It holds" : "They hold"} the rules every agent on this project follows. Nothing else is committed.`, detail: `Seatworks added its team block to ${teamFiles.join(" and ")}. Committing it keeps every agent and teammate on the same instructions. Only ${teamFiles.length === 1 ? "this file is" : "these files are"} committed.` });
      for (const task of Object.values(ledger.tasks).filter(t => lanes.some(l => l.id === t.lane) && !["merged","cut"].includes(t.status))) {
        if (task.handback?.gate?.ok === false || task.status === "failed") result.items.push({ id: `${scope.id}:${task.id}`, project: scope.name, kind: "tests", agent: ledger.lanes[task.lane]?.lead ?? null, title: "Checks need attention", plain: `Nothing to approve. A task failed its checks; the Lead is on it. Open the Lead to see what went wrong.`, detail: `${task.title}: ${task.handback?.gate?.note ?? "Task reported a failure."}`.slice(0,600) });
        else if (task.status === "done") result.items.push({ id: `${scope.id}:${task.id}`, project: scope.name, kind: "review", agent: ledger.lanes[task.lane]?.lead ?? null, title: "Ready for Lead review", plain: "Nothing needed from you. A task is done and its Lead is reviewing it.", detail: task.title.slice(0,600) });
      }
      const queued = held.filter(l => ids.has(l.to)).length;
      result.held += queued;
      const running = [...ids].filter(id => ["running","starting"].includes(byId.get(id)?.status ?? "")).length;
      const human = result.items.slice(start).filter(i => i.kind === "permission").length;
      const landing = result.items.slice(start).filter(i => i.kind === "land").length;
      const waiting = Object.values(ledger.lanes).filter(l => l.status === "waiting");
      const streams = [...lanes.slice(0, 6).map((lane) => {
        const tasks = Object.values(ledger.tasks).filter(t => t.lane === lane.id && t.status !== "cut");
        const merged = tasks.filter(t => t.status === "merged").length;
        const report = reports.get(lane.id);
        const lead = lane.lead ? byId.get(lane.lead) : undefined;
        const state = report?.ready ? (report.gate === false ? "tests failed" : "ready to land")
          : tasks.length ? `${merged} of ${count(tasks.length, "task")} done` : lead && ["running", "starting"].includes(lead.status ?? "") ? "planning" : "waiting";
        return { id: lane.id, title: lane.title.slice(0, 120), state, agent: lane.lead ?? null };
      }), ...waiting.slice(0, Math.max(0, 6 - lanes.length)).map((lane) => ({ id: lane.id, title: lane.title.slice(0, 120), state: lane.after?.length ? `starts after ${lane.after.join(", ")} lands` : "waiting to start", agent: null }))];
      result.projects.push({ id: scope.id, name: scope.name, streams, status: human ? `Waiting on you: ${count(human, "request")}` : landing ? `${landing} ready to land` : questions.length ? count(questions.length, "team question") : queued ? `${count(queued, "message")} waiting for agents` : running ? `${count(running, "agent")} working` : lanes.length ? "Team idle · open work remains" : waiting.length ? `${count(waiting.length, "work stream")} waiting to start` : "No active work" });
    } catch {
      result.projects.push({ id: scope.id, name: scope.name, status: "Status unavailable" });
      result.items.push({ id: `${scope.id}:error`, project: scope.name, kind: "error", agent: null, title: "Could not read project status", detail: "Open project settings to inspect its ledger and setup. No empty or successful state was inferred." });
    }
  }
  const rank = (item: TeamBrief["items"][number]) => item.action ? -1 : ["permission", "land", "tests", "question"].indexOf(item.kind) >>> 0;
  result.items.sort((a,b) => rank(a) - rank(b));
  result.omitted = Math.max(0, result.items.length - 24);
  result.items = result.items.slice(0,24);
  result.projects = result.projects.slice(0,100);
  return result;
}
