import type { TeamBrief } from "../../shared/brief.ts";
import type { Binding } from "../../shared/supervision.ts";
import type { SeatView } from "../core/ports.ts";
import type { Ledger } from "../desk/ledger.ts";

export function teamBrief(binding: Binding, seats: SeatView[], read: (root: string) => Ledger, held: { to: string }[]): TeamBrief {
  const result: TeamBrief = { supervisor: binding.supervisor?.agent ?? null, workspace: binding.supervisor?.workspace ?? null, active: binding.active,
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
      result.items.push({ id: `permission:${id}:${i}`, project: name, kind: "permission", agent: id, title: "Waiting on you", detail: (p.title ?? p.description ?? p.name ?? "Open this agent to answer its permission request.").slice(0, 600) });
    }
  };
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
      for (const ask of questions) result.items.push({ id: `${scope.id}:${ask.id}`, project: scope.name, kind: "question", agent: byId.has(ask.to) ? ask.to : binding.supervisor.agent, title: "Team question", detail: ask.text.slice(0, 600) });
      for (const task of Object.values(ledger.tasks).filter(t => lanes.some(l => l.id === t.lane) && !["merged","cut"].includes(t.status))) {
        if (task.handback?.gate?.ok === false || task.status === "failed") result.items.push({ id: `${scope.id}:${task.id}`, project: scope.name, kind: "tests", agent: ledger.lanes[task.lane]?.lead ?? null, title: "Checks need attention", detail: `${task.title}: ${task.handback?.gate?.note ?? "Task reported a failure."}`.slice(0,600) });
        else if (task.status === "done") result.items.push({ id: `${scope.id}:${task.id}`, project: scope.name, kind: "review", agent: ledger.lanes[task.lane]?.lead ?? null, title: "Ready for Lead review", detail: task.title.slice(0,600) });
      }
      const queued = held.filter(l => ids.has(l.to)).length;
      result.held += queued;
      const running = [...ids].filter(id => ["running","starting"].includes(byId.get(id)?.status ?? "")).length;
      const human = result.items.slice(start).filter(i => i.kind === "permission").length;
      result.projects.push({ id: scope.id, name: scope.name, status: human ? `Waiting on you: ${human} requests` : questions.length ? `${questions.length} team questions` : queued ? `${queued} messages waiting for agents` : running ? `${running} agents working` : lanes.length ? "Team idle · open work remains" : "No active work" });
    } catch {
      result.projects.push({ id: scope.id, name: scope.name, status: "Status unavailable" });
      result.items.push({ id: `${scope.id}:error`, project: scope.name, kind: "error", agent: null, title: "Could not read project status", detail: "Open project settings to inspect its ledger and setup. No empty or successful state was inferred." });
    }
  }
  result.items.sort((a,b) => Number(b.kind === "permission") - Number(a.kind === "permission"));
  result.omitted = Math.max(0, result.items.length - 24);
  result.items = result.items.slice(0,24);
  result.projects = result.projects.slice(0,100);
  return result;
}
