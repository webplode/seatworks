import type { Team } from "../catalog/team.ts";
import { type Kit, type RoleSpec, can, roleThatCan, schemaOf, seatOf, worksTasks } from "../catalog/kit.ts";
import type { SeatView, Seats, Workspaces } from "../core/ports.ts";
import { Agents } from "./agents.ts";
import { argsProblems, shapeOf, typedArgs } from "./args.ts";
import { sortKeys } from "../core/store.ts";
import { type Args, type Caller, type CodeIndex, DeskContext, type DeskDeps, type Mailer, type Posted, type ToolReply, type ToolRequest, hash, no, ok } from "./context.ts";
import { errorText } from "../core/errors.ts";
import { type Ledger, type Task, loadLedger } from "./ledger.ts";
import { clip, letters } from "./letters.ts";
import { tidyRecords } from "./records.ts";
import { fileRecords, keepArchived, takeFinished } from "./archive.ts";
import { MergeQueue } from "./merge.ts";
import { type Project, projectOf } from "./project.ts";
import { Roster } from "./roster.ts";
import type { DeskServices, Tool } from "./services.ts";
import { Slots } from "./slots.ts";
import type { Finding, Verdict } from "../runtime/watch/findings.ts";
import { type Noticed, closeIncidentsOf, judge, notice, retell } from "./notice.ts";
import * as incidents from "./tools/incidents.ts";
import * as lead from "./tools/lead.ts";
import * as shared from "./tools/shared.ts";
import * as supervisor from "./tools/supervisor.ts";
import { openWaiting, startWaiting } from "./waiting.ts";
import { decidePlan } from "./approval.ts";
import * as critique from "./critique.ts";
import * as watcher from "./tools/watcher.ts";
import * as worker from "./tools/worker.ts";
import type { SupervisionControl } from "../runtime/supervision-control.ts";
import { DependencyRequest, DependencyChange } from "../runtime/dependencies.ts";
import type { Operation } from "../../shared/supervision.ts";
import { firstOverlap } from "../core/scope.ts";

const TOOLS: Record<string, Tool> = {
  open_lane: supervisor.openLane,
  close_lane: supervisor.closeLane,
  amend_lane: supervisor.amendLane,
  replace_lead: supervisor.replaceLead,
  approve_plan: supervisor.approvePlan,
  set_project: supervisor.setProject,
  start_task: lead.startTask,
  plan_tasks: lead.planTasks,
  start_review: lead.startReview,
  accept: lead.accept,
  rework: lead.rework,
  amend_task: lead.amendTask,
  cut: lead.cut,
  report: lead.report,
  done: worker.done,
  message: shared.message,
  answer: shared.answer,
  status: shared.status,
  incidents: incidents.incidents,
  ack: incidents.ack,
  raise: watcher.raise,
  judge: watcher.judge,
  findings: critique.findings,
};

const ASK: { holds: (role: RoleSpec) => boolean; tool: Tool }[] = [
  { holds: (role) => can(role, "lead"), tool: lead.ask },
  { holds: worksTasks, tool: worker.ask },
];

function toolFor(role: RoleSpec, name: string): Tool | undefined {
  return name === "ask" ? ASK.find((entry) => entry.holds(role))?.tool : TOOLS[name];
}

export type DeskOptions = {
  kit: Kit;
  supervision: SupervisionControl;
  outbox: Mailer;
  seats: Seats;
  workspaces: Workspaces;
  log: (project: Project, line: string) => void;
  teamFor: (project?: Project) => Team;
  indexesFor?: (project: Project) => CodeIndex[];
  sent?: DeskDeps["sent"];
};

const SPEAKS = ["done", "ask", "answer", "message", "report"];

export const ANSWER_WITHIN_MS = 240_000;

export class Desk {
  readonly projects: Map<string, Project>;
  readonly pendingArchive: Set<string>;
  private readonly services: DeskServices;
  private readonly supervision: SupervisionControl;
  /** Whether a call from this seat is still being worked on — which is not silence. */
  inFlight(agentId: string): boolean {
    for (const key of this.running.keys()) if (key.startsWith(`${agentId}\n`)) return true;
    return false;
  }

  private readonly running = new Map<string, { reply: Promise<ToolReply>; started: number }>();

  constructor(options: DeskOptions) {
    this.supervision = options.supervision;
    const ctx = new DeskContext({
      kit: options.kit,
      outbox: options.outbox,
      log: options.log,
      teamFor: options.teamFor,
      indexesFor: options.indexesFor ?? (() => []),
      sent: options.sent,
      supervision: options.supervision.store,
    });
    const roster = new Roster(options.kit, options.seats, options.supervision.store);
    const slots = new Slots(ctx, options.workspaces);
    const agents = new Agents(ctx, roster, slots, options.workspaces);
    this.services = { ctx, roster, slots, agents, merges: new MergeQueue(ctx, agents) };
    this.projects = ctx.projects;
    this.pendingArchive = roster.pendingArchive;
  }

  ledger<T>(project: Project, change: (ledger: Ledger) => T | Promise<T>): Promise<T> {
    return this.services.ctx.ledger(project, change);
  }

  settled(project: Project): Promise<unknown> {
    return this.services.merges.settled(project);
  }

  event(project: Project, data: Record<string, unknown>): void {
    this.services.ctx.event(project, data);
  }

  notice(project: Project, seat: Noticed, findings: Finding[]): ReturnType<typeof notice> {
    return notice(this.services, project, seat, findings);
  }

  judge(project: Project, seat: Noticed, verdicts: Verdict[]): Promise<string[]> {
    return judge(this.services, project, seat, verdicts);
  }

  retell(project: Project): Promise<string[]> {
    return retell(this.services, project);
  }

  closeIncidents(project: Project, seat: string): Promise<string[]> {
    return closeIncidentsOf(this.services, project, seat);
  }

  post(to: string | undefined, key: string, text: string, project?: Project): Promise<Posted | "nobody"> {
    return this.services.ctx.post(to, key, text, project);
  }

  supervisorFor(project: Project, preferred?: string): Promise<string | undefined> {
    return this.services.roster.supervisorFor(project, preferred);
  }

  watchers(project: Project, seats: Iterable<SeatView>): SeatView[] {
    return this.services.roster.watchers(project, seats);
  }

  /** Seats the project's Watcher. The patrol is its only caller, one round at a time, so there is no second create to race. */
  async seatWatcher(project: Project): Promise<string | undefined> {
    const role = roleThatCan(this.services.ctx.kit, "watch");
    if (!role) return undefined;
    const id = await this.services.agents.startResident(project, role.role, {
      title: `${role.label} ${project.slug}`,
      prompt: letters.watcherSeated(role.label, this.services.ctx.kit.watcher),
      labels: {},
    });
    this.services.ctx.event(project, { kind: "watcher.seated", agent: id });
    return id;
  }

  decidePlan(project: Project, lane: string, approve: boolean, by: string, note: string): Promise<{ ok: boolean; text: string }> {
    return decidePlan(this.services, project, lane, approve, by, note);
  }

  decideLand(project: Project, lane: string, approve: boolean, note: string): Promise<{ ok: boolean; text: string }> {
    return supervisor.decideLand(this.services, project, lane, approve, note);
  }

  approveReady(project: Project, lane: string): Promise<{ ok: boolean; text: string }> {
    return supervisor.approveReady(this.services, project, lane);
  }

  archive(agentId: string | undefined, force = false): Promise<void> {
    return this.services.roster.archive(agentId, force);
  }

  /** A seat's turn ended: finish the teardown its own writing was holding up. */
  async stopped(agentId: string): Promise<void> {
    await this.services.slots.stopped(agentId);
    const { ctx } = this.services;
    for (const project of ctx.projects.values()) {
      const waiting = Object.values(loadLedger(project.state).lanes).filter((lane) => lane.status === "open" && lane.landing?.writers.includes(agentId));
      for (const lane of waiting) {
        const left = lane.landing!.writers.filter((id) => id !== agentId);
        await ctx.ledger(project, (ledger) => {
          const entry = ledger.lanes[lane.id];
          if (!entry?.landing) return;
          if (left.length > 0) entry.landing.writers = left;
          else delete entry.landing;
        });
        if (left.length === 0) await ctx.post(lane.landing!.by, `canland:${lane.id}:${Date.now()}`, letters.canLand(lane), project);
      }
    }
  }

  /** In the round: finish a teardown whose writers are not seats any more. */
  reapSlots(project: Project, live: Set<string>): Promise<void> {
    return this.services.slots.reap(project, live);
  }

  setTask(project: Project, taskId: string, change: (task: Task) => void): Promise<Task | undefined> {
    return this.services.ctx.setTask(project, taskId, change);
  }

  /** The patrol's net under a close or an acceptance that never got to start what waited on it; one whose start failed waits for the next. */
  async openWaiting(project: Project): Promise<void> {
    await openWaiting(this.services, project, false);
    await startWaiting(this.services, project, false);
  }

  /** Checked on a plain read first, so a round with nothing to archive does not rewrite the ledger; records follow once it is saved. */
  async archiveFinished(project: Project, gone: (agentId: string) => boolean): Promise<void> {
    const taken = takeFinished(loadLedger(project.state), gone)
      ? await this.services.ctx.ledger(project, (ledger) => {
          const found = takeFinished(ledger, gone);
          if (found) keepArchived(project.state, found);
          return found;
        })
      : undefined;
    const filed = fileRecords(project.state, loadLedger(project.state));
    if (taken || filed.length > 0) {
      this.services.ctx.event(project, { kind: "ledger.archived", lanes: taken?.lanes.map((entry) => entry.lane!.id) ?? [], agents: taken?.agents.length ?? 0, asks: taken?.asks.length ?? 0, records: filed.length });
    }
  }

  async sweep(project: Project, busy = false): Promise<void> {
    await this.services.slots.sweep(project, busy);
    const dropped = tidyRecords(project.state, loadLedger(project.state));
    if (dropped.length > 0) this.services.ctx.event(project, { kind: "records.tidied", files: dropped.length });
  }

  /**
   * The seat's bridge (`mcp/team.mjs`) waits five minutes but a gate may run thirty: a call that runs long is
   * answered with what is happening and its result mailed, and the same call again while it runs joins it.
   */
  answer(request: ToolRequest, within = ANSWER_WITHIN_MS): Promise<ToolReply> {
    const key = `${request.agent}\n${request.tool}\n${JSON.stringify(sortKeys(request.args ?? {}))}`;
    const running = this.running.get(key);
    if (running) return this.inTime(request, running.reply, running.started, within, true);
    const started = Date.now();
    // A throw is answered too: only a resolved reply posts the letter the seat was promised.
    const reply = this.handle(request)
      .catch((error: unknown) => no(`The desk failed: ${errorText(error)}`))
      .finally(() => {
        if (this.running.get(key)?.started === started) this.running.delete(key);
      });
    this.running.set(key, { reply, started });
    return this.inTime(request, reply, started, within, false);
  }

  private inTime(request: ToolRequest, reply: Promise<ToolReply>, started: number, within: number, again: boolean): Promise<ToolReply> {
    return new Promise((resolve) => {
      let answered = false;
      const timer = setTimeout(() => {
        if (answered) return;
        answered = true;
        resolve(
          ok(
            again
              ? `That ${request.tool} call is already running from before. Its answer arrives as mail; there is nothing to call again.`
              : `The desk is still working on ${request.tool} — a gate can take as long as the project allows it. The answer arrives as mail. End your turn now; do not call ${request.tool} again.`,
          ),
        );
        // One letter for one run, whichever of its callers gave up waiting first.
        void reply.then((done) => this.services.ctx.post(request.agent, `later:${hash(request.agent, request.tool, String(started))}`, letters.later(request.tool, done)));
      }, within);
      timer.unref?.();
      void reply.then((done) => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        resolve(done);
      });
    });
  }

  async handle(request: ToolRequest): Promise<ToolReply> {
    const caller = await this.caller(request);
    if ("error" in caller) return no(caller.error);
    const { ctx } = this.services;
    const schema = schemaOf(ctx.kit, caller.role, request.tool);
    const tool = schema ? toolFor(caller.role, request.tool) : undefined;
    const args = (schema ? typedArgs(schema, request.args ?? {}) : request.args ?? {}) as Args;
    const problems = schema ? argsProblems(schema, args) : [];
    if (schema && problems.length === 0) {
      try {
        if (request.tool === "coordinate") {
          const result = args.id
            ? await this.supervision.dependencies.change(caller.id, DependencyChange.parse(args))
            : await this.supervision.dependencies.request(caller.id, DependencyRequest.parse(args));
          return ok(JSON.stringify(result));
        }
        if (request.tool === "acknowledge") {
          this.services.ctx.acknowledge(String(args.delivery), caller.id);
          return ok("Receipt acknowledged. This does not mark the work accepted or compliant.");
        }
        if (can(caller.role, "supervise")) {
          if (request.tool === "activity") return ok(JSON.stringify(await this.supervision.activity(caller.id, String(args.project), String(args.agent), args.limit === undefined ? 20 : Number(args.limit))));
          const binding = this.supervision.store.read();
          if (!binding.active || binding.supervisor?.agent !== caller.id) return no("This agent is not the active overall Supervisor.");
          if (request.tool === "status" && !args.project) {
            const view = await this.supervision.view();
            if (!view.binding.active || view.binding.supervisor?.agent !== caller.id) return no("The selected Supervisor changed during this read.");
            const selected = new Set(view.binding.projects.filter((p) => p.grants.includes("observe")).map((p) => p.id));
            const scoped = <T>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([id]) => selected.has(id)));
            return ok(JSON.stringify({ binding: { ...view.binding, projects: view.binding.projects.filter((p) => selected.has(p.id)) }, agents: view.agents.filter((a) => selected.has(a.project)), deliveries: view.deliveries.filter((d) => selected.has(d.project)), dependencies: view.dependencies.filter((d) => selected.has(d.producer.project) && selected.has(d.consumer.project)), communication: scoped(view.communication), problems: scoped(view.problems) }));
          }
          const operation = ({ status: "observe", incidents: "observe", amend_lane: "open_lane", replace_lead: "open_lane", approve_plan: "open_lane" } as Record<string, Operation>)[request.tool] ?? request.tool as Operation;
          const scope = await this.supervision.verifyTarget(caller.id, String(args.project ?? ""), operation);
          if (request.tool === "close_lane" && args.land) this.supervision.store.authorize(caller.id, scope.scope.id, "land");
          caller.project = scope.project;
          caller.deliveryGuard = { actor: caller.id, revision: scope.revision, project: scope.scope.id, operation };
          caller.revalidate = () => {
            const current = this.supervision.store.authorize(caller.id, scope.scope.id, operation);
            if (current.revision !== scope.revision) throw new Error("Scope changed while this operation was pending.");
          };
          if (request.tool === "open_lane") {
            const paths = Array.isArray(args.writeSet) ? args.writeSet as string[] : [];
            const conflict = scope.scope.leads.find((lead) => lead.origin === "external" && (!paths.length || firstOverlap(paths, lead.ownership)));
            if (conflict) return no(`Existing Lead ${conflict.agent} owns overlapping work. Reconcile ownership before creating another lane.`);
          }
          if (request.tool === "message") return ok(await this.supervision.message(caller.id, scope.scope.id, String(args.to), String(args.text), `intervention:${request.id}`));
        }
      } catch (error) { return no(errorText(error)); }
    }
    let reply: ToolReply;
    try {
      reply = problems.length > 0
        ? no(`${request.tool} was not carried out: it ${problems.join("; ")}. ${shapeOf(schema!)}`)
        : !tool
          ? no(`Unknown tool ${request.tool}.`)
          : await tool(this.services, caller, args);
    } catch (error) {
      ctx.log(caller.project, `${caller.role.role} ${caller.id} ${request.tool} crashed: ${errorText(error)}`);
      reply = no(`${request.tool} failed: ${errorText(error)}`);
    }
    ctx.event(caller.project, { kind: "tool", agent: caller.id, role: caller.role.role, tool: request.tool, ok: reply.ok, reply: clip(reply.text, 300) });
    if (reply.ok) {
      // Noting that the seat was heard from must not turn a reply it has earned into a crash.
      try {
        await ctx.ledger(caller.project, (ledger) => {
          const ref = ledger.agents[caller.id] ?? { id: caller.id, role: caller.role.role };
          ref.recordedAt = Date.now();
          if (SPEAKS.includes(request.tool)) ref.spokeAt = ref.recordedAt;
          ledger.agents[caller.id] = ref;
        });
      } catch (error) {
        ctx.log(caller.project, `could not record that ${caller.id} was heard from: ${errorText(error)}`);
      }
    }
    return reply;
  }

  private async caller(request: ToolRequest): Promise<Caller | { error: string }> {
    if (!request.agent) return { error: "This tool works only inside a team agent." };
    const seat = await this.services.roster.look(request.agent);
    const role = seatOf(this.services.ctx.kit, seat.provider)?.role;
    if (!role?.tools) return { error: "This agent is not part of the team." };
    if (role.role !== request.role) return { error: `This agent is a ${role.label}, so ${request.role} tools are not available to it.` };
    if (seat.archivedAt) return { error: "This agent was archived." };
    return { id: request.agent, role, title: seat.title ?? request.agent, project: projectOf(seat.cwd ?? request.cwd) };
  }
}
