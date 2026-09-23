import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { BindingChange, LeadChange, type HostInventory, type SupervisionView, type Operation } from "../../shared/supervision.ts";
import { can, providerId, roleThatCan, seatOf, type Kit } from "../catalog/kit.ts";
import type { Seats, Workspaces } from "../core/ports.ts";
import { loadLedger, laneOfLead, findLane, findTask } from "../desk/ledger.ts";
import { letters } from "../desk/letters.ts";
import { projectOf } from "../desk/project.ts";
import { firstOverlap } from "../core/scope.ts";
import type { Outbox } from "./outbox.ts";
import type { TeamSource } from "./team-source.ts";
import { canonicalRoot, Supervision } from "./supervision.ts";
import { Dependencies } from "./dependencies.ts";

type Deps = {
  store: Supervision; kit: Kit; seats: Seats; workspaces: Workspaces; outbox: Outbox;
  inventory(): Promise<HostInventory>; source: TeamSource;
  activity(id: string, limit: number): Promise<unknown>;
  prepareProviders?(): Promise<void>;
  communication?(): SupervisionView["communication"];
};

export class SupervisionControl {
  readonly store: Supervision;
  readonly dependencies: Dependencies;
  private readonly deps: Deps;
  private creating = false;

  constructor(deps: Deps) {
    this.deps = deps;
    this.store = deps.store;
    this.dependencies = new Dependencies(deps.store, deps.outbox, deps.seats);
  }

  async view(): Promise<SupervisionView> {
    const [inventory, seats] = await Promise.all([this.deps.inventory(), this.deps.seats.open()]);
    const binding = this.store.read();
    const candidates = inventory.projects.flatMap((p) => {
      try { const root = canonicalRoot(p.root); return root === join(this.store.root, "supervisor-home") ? [] : [{ ...p, root }]; }
      catch { return []; }
    });
    const agents = seats.flatMap((seat) => {
      const workspace = inventory.workspaces.find((w) => w.id === seat.workspaceId);
      const project = workspace && candidates.find((p) => p.id === workspace.project);
      if (!workspace || !project) return [];
      try { if (canonicalRoot(seat.cwd) !== project.root) return []; } catch { return []; }
      return [{ id: seat.id, title: seat.title ?? seat.id, workspace: workspace.id, project: project.id,
        capable: can(seatOf(this.deps.kit, seat.provider)?.role, "lead"), status: seat.status,
        updatedAt: seat.updatedAt, waiting: Boolean(seat.pendingPermissions?.length) }];
    });
    const problems: Record<string, string> = {};
    for (const scope of binding.projects) {
      if (!candidates.some((p) => p.id === scope.id && p.root === scope.root)) problems[scope.id] = "The native project is missing or moved; reconcile its scope before acting.";
      let ledger;
      try { ledger = loadLedger(projectOf(scope.root, this.store.root).state); }
      catch { problems[scope.id] = "The project's ledger could not be read. Coverage is incomplete."; continue; }
      for (const lane of Object.values(ledger.lanes)) {
        const agent = agents.find((a) => a.id === lane.lead && a.project === scope.id);
        if (lane.status !== "open" || !agent || scope.leads.some((l) => l.agent === agent.id)) continue;
        scope.leads.push({ agent: agent.id, workspace: agent.workspace, objective: lane.outcome, ownership: lane.writeSet.length ? lane.writeSet : ["Ownership not declared"], origin: "managed", lane: lane.id });
      }
    }
    return {
      binding, candidates, agents, problems,
      supervisors: seats.filter((s) => s.workspaceId && can(seatOf(this.deps.kit, s.provider)?.role, "supervise"))
        .map((s) => ({ id: s.id, title: s.title ?? s.id, workspace: s.workspaceId! })),
      deliveries: this.deps.outbox.records().filter((l) => l.guard).slice(-100).reverse()
        .map(({ id, to, state, detail, at, text, guard }) => ({ id, to, state, ...(detail === undefined ? {} : { detail }), at, text, project: guard!.project })),
      dependencies: this.dependencies.read(),
      communication: this.deps.communication?.() ?? {},
    };
  }

  async verifyTarget(actor: string, id: string, operation: Operation) {
    const scope = this.store.authorize(actor, id, operation);
    const native = (await this.deps.inventory()).projects.find((p) => p.id === id);
    if (!native || canonicalRoot(native.root) !== scope.scope.root) throw new Error("The native project moved or disappeared. Reconcile its scope first.");
    if (this.store.read().revision !== scope.revision) throw new Error("Scope changed while verifying the project.");
    return scope;
  }

  async bind(input: z.infer<typeof BindingChange>) {
    const view = await this.view();
    const supervisor = view.supervisors.find((s) => s.id === input.supervisor);
    if (input.supervisor && !supervisor) throw new Error("Choose a live agent with the supervise capability.");
    const changed = this.store.change(input.revision, (binding) => {
      binding.supervisor = supervisor ? { agent: supervisor.id, workspace: supervisor.workspace } : null;
      binding.active = input.active;
      binding.projects = input.projects.map((p) => {
        const native = view.candidates.find((c) => c.id === p.id);
        if (!native) throw new Error(`Paseo no longer knows project ${p.id}.`);
        const prior = binding.projects.find((old) => old.id === p.id);
        if (prior && prior.root !== native.root) throw new Error("Project moved. Remove its old scope and explicitly enroll the new location.");
        const project = projectOf(native.root, this.store.root);
        return { ...native, slug: project.slug, grants: [...new Set(p.grants)], leads: prior?.leads ?? [] };
      });
    });
    for (const project of changed.projects) this.deps.source.record(projectOf(project.root, this.store.root));
    const observed = changed.projects.find((p) => p.grants.includes("observe"));
    if (changed.active && changed.supervisor && observed) await this.deps.outbox.post({
      to: changed.supervisor.agent, key: `binding:${changed.revision}`,
      text: `The Human selected supervision revision ${changed.revision}. Read status for current project IDs, granted operations and associated Leads. Coordinate within the Human's existing objectives; scope enrollment is not a request to invent work.`,
      guard: { actor: changed.supervisor.agent, revision: changed.revision, project: observed.id, workspace: changed.supervisor.workspace, operation: "observe", recipient: "supervisor" },
    });
    return changed;
  }

  async adopt(input: z.infer<typeof LeadChange>) {
    const view = await this.view();
    const project = view.binding.projects.find((p) => p.id === input.project);
    if (!project) throw new Error("Enroll the project before associating its Leads.");
    const agent = view.agents.find((a) => a.id === input.agent && a.project === project.id);
    if (!input.remove && !agent) throw new Error("The agent's native workspace and project could not be verified.");
    const lane = agent ? laneOfLead(loadLedger(projectOf(project.root, this.store.root).state), agent.id) : undefined;
    return this.store.change(input.revision, (binding) => {
      const scope = binding.projects.find((p) => p.id === input.project)!;
      if (!input.remove) {
        for (const other of project.leads.filter((l) => l.agent !== input.agent)) {
          const collision = firstOverlap(input.ownership, other.ownership);
          if (collision) throw new Error(`Ownership overlaps ${other.agent}: ${collision}. Reconcile ownership before associating this Lead.`);
        }
      }
      scope.leads = scope.leads.filter((l) => l.agent !== input.agent);
      if (!input.remove) scope.leads.push({ agent: agent!.id, workspace: agent!.workspace, objective: input.objective,
        ownership: input.ownership, origin: lane?.status === "open" && agent!.capable ? "managed" : "external", ...(lane?.status === "open" ? { lane: lane.id } : {}) });
    });
  }

  async create(revision: number): Promise<{ agent: string }> {
    if (this.creating) throw new Error("Supervisor creation is already in progress.");
    if (this.store.read().revision !== revision) throw new Error("Supervision changed. Refresh before creating.");
    if (this.store.read().supervisor) throw new Error("A Supervisor is already selected. Select an existing replacement explicitly.");
    const role = roleThatCan(this.deps.kit, "supervise");
    const choice = role && this.deps.source.teamFor().roles[role.role];
    if (!role || !choice) throw new Error("No configured role can supervise.");
    this.creating = true;
    try {
      await this.deps.prepareProviders?.();
      const home = join(this.store.root, "supervisor-home");
      mkdirSync(home, { recursive: true });
      const workspace = await this.deps.workspaces.named("Seatworks supervision") ?? await this.deps.workspaces.make("Seatworks supervision", home);
      const agent = await this.deps.workspaces.seat(workspace.id, {
        idempotencyKey: `seatworks-supervisor-${revision}`,
        config: { provider: `${providerId(this.deps.kit, role.role, choice.harness.id)}${choice.model ? `/${choice.model.id}` : ""}`,
          ...(choice.thinking ? { thinkingOptionId: choice.thinking } : {}) },
        title: "Overall Supervisor", prompt: "Read status to learn your selected projects. Await the Human's objective; do not create work until they give one.",
        labels: { "seatworks.role": role.role, "seatworks.supervision": "overall" },
      });
      try { this.store.change(revision, (binding) => { binding.supervisor = { agent: agent.id, workspace: workspace.id }; }); }
      catch { throw new Error(`Agent ${agent.id} was created, but supervision changed during creation. Select that existing agent; do not create a duplicate.`); }
      return { agent: agent.id };
    } finally { this.creating = false; }
  }

  async activity(actor: string, project: string, agent: string, limit = 20): Promise<unknown> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Activity limit must be an integer from 1 to 50.");
    const scope = await this.verifyTarget(actor, project, "observe");
    const verify = async () => {
      const current = await this.verifyTarget(actor, project, "observe");
      const seat = await this.deps.seats.look(agent);
      if (current.revision !== scope.revision || this.store.read().revision !== scope.revision) throw new Error("Scope changed during the activity read.");
      if (seat.projectId !== project || !seat.workspaceId || seat.archivedAt || !seat.cwd || canonicalRoot(seat.cwd) !== scope.scope.root) throw new Error("The agent does not belong to this observed project.");
      const lead = scope.scope.leads.find((l) => l.agent === agent);
      if (lead && lead.workspace !== seat.workspaceId) throw new Error("The Lead's workspace changed. Reassociate it explicitly.");
      return seat.workspaceId;
    };
    const workspace = await verify();
    const activity = await this.deps.activity(agent, limit);
    if (await verify() !== workspace) throw new Error("The agent changed workspace during the activity read.");
    return activity;
  }

  async message(actor: string, project: string, to: string, text: string, key: string): Promise<string> {
    const scope = await this.verifyTarget(actor, project, "message");
    const ledger = loadLedger(scope.project.state);
    const lane = findLane(ledger, to);
    const task = findTask(ledger, to);
    if (task && ["merged", "cut"].includes(task.status)) throw new Error(`${task.id} is ${task.status}.`);
    const owner = task ? ledger.lanes[task.lane] : undefined;
    const id = task?.peer ?? (lane?.status === "open" ? lane.lead : to);
    const lead = scope.scope.leads.find((l) => l.agent === id);
    const managed = id ? laneOfLead(ledger, id) : undefined;
    if (!id || (!task && !lead && managed?.status !== "open")) throw new Error("Address an associated Lead ID or an open lane in this project.");
    const seat = await this.deps.seats.look(id);
    if (seat.projectId !== project || !seat.workspaceId || seat.archivedAt || !seat.cwd || canonicalRoot(seat.cwd) !== scope.scope.root) throw new Error("The addressed Lead no longer belongs to this project.");
    if (lead && lead.workspace !== seat.workspaceId) throw new Error("The Lead's workspace changed. Reassociate it explicitly.");
    if (task) {
      if (["merged", "cut"].includes(task.status)) throw new Error(`${task.id} is ${task.status}.`);
      if (!owner?.lead || owner.status !== "open") throw new Error("There is no running Lead to tell about the direct intervention.");
      const reader = await this.deps.seats.look(owner.lead);
      if (reader.archivedAt || !reader.workspaceId) throw new Error("There is no running Lead to tell about the direct intervention.");
      await this.deps.outbox.post({ to: owner.lead, key: `reconcile:${key}`, text: `[Project ${project}] ${letters.reconciled(owner, task, id, text)}`,
        guard: { actor, revision: scope.revision, project, workspace: reader.workspaceId, operation: "message" } });
    }
    const result = await this.deps.outbox.post({ to: id, key, text: `[Project ${project}] ${text}`,
      guard: { actor, revision: scope.revision, project, workspace: seat.workspaceId, operation: "message" } });
    const receipt = this.deps.outbox.records().find((l) => l.key === key && l.to === id);
    return `Intervention ${receipt?.id}: ${receipt?.state ?? result}. Delivery is not acknowledgment or compliance.`;
  }
}
