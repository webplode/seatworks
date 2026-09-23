import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { Dependency } from "../../shared/supervision.ts";
import { writeJson } from "../core/store.ts";
import type { Seats } from "../core/ports.ts";
import { loadLedger, laneOfLead } from "../desk/ledger.ts";
import { projectOf } from "../desk/project.ts";
import type { Outbox } from "./outbox.ts";
import { canonicalRoot, type Supervision } from "./supervision.ts";

export const DependencyRequest = z.object({
  producer: z.object({ project: z.string(), agent: z.string() }),
  consumer: z.object({ project: z.string(), agent: z.string() }),
  request: z.string().min(1), checkpoint: z.string().min(1),
});
export const DependencyChange = z.object({ id: z.string(), revision: z.number().int(), state: Dependency.shape.state,
  checkpoint: z.string().min(1), artifact: z.string().min(1).optional() });

export class Dependencies {
  private readonly store: Supervision;
  private readonly outbox: Outbox;
  private readonly seats: Seats;
  private readonly file: string;

  constructor(store: Supervision, outbox: Outbox, seats: Seats) {
    this.store = store; this.outbox = outbox; this.seats = seats;
    this.file = join(store.root, "dependencies.json");
  }

  read(): Dependency[] {
    return existsSync(this.file) ? z.array(Dependency).parse(JSON.parse(readFileSync(this.file, "utf8"))) : [];
  }

  private async owner(owner: Dependency["producer"]): Promise<string> {
    const binding = this.store.read();
    const scope = binding.projects.find((p) => p.id === owner.project);
    if (!binding.active || !scope?.grants.includes("coordinate")) throw new Error("Both projects must grant coordination.");
    const lead = scope.leads.find((l) => l.agent === owner.agent);
    const lane = laneOfLead(loadLedger(projectOf(scope.root, this.store.root).state), owner.agent);
    if (!lead && lane?.status !== "open") throw new Error("Dependency owner is not an associated Lead.");
    const seat = await this.seats.look(owner.agent);
    if (seat.projectId !== scope.id || !seat.cwd || canonicalRoot(seat.cwd) !== scope.root || !seat.workspaceId || seat.archivedAt || (lead && lead.workspace !== seat.workspaceId)) throw new Error("Dependency owner is unavailable or changed workspace.");
    return seat.workspaceId;
  }

  async request(actor: string, input: z.infer<typeof DependencyRequest>): Promise<Dependency> {
    const binding = this.store.read();
    if (binding.supervisor?.agent !== actor) throw new Error("Only the bound Supervisor can open a cross-project dependency.");
    await Promise.all([this.owner(input.producer), this.owner(input.consumer)]);
    if (this.store.read().revision !== binding.revision) throw new Error("Scope changed during the request.");
    if (input.producer.project === input.consumer.project) throw new Error("Use the project's own lane workflow for local dependencies.");
    const item: Dependency = { ...input, id: randomUUID(), revision: 0, state: "requested", artifact: null, by: actor, at: Date.now() };
    writeJson(this.file, [...this.read(), item]);
    await this.notify(item);
    return item;
  }

  async change(actor: string, input: z.infer<typeof DependencyChange>): Promise<Dependency> {
    const held = this.read().find((d) => d.id === input.id);
    if (!held || held.revision !== input.revision) throw new Error("Dependency changed; read its current revision.");
    const binding = this.store.read();
    const supervisor = binding.supervisor?.agent === actor;
    const producer = held.producer.agent === actor;
    const consumer = held.consumer.agent === actor;
    if (!supervisor && !producer && !consumer) throw new Error("This agent is not an owner of that dependency.");
    const transitions: Record<Dependency["state"], Dependency["state"][]> = {
      requested: ["accepted", "blocked", "canceled"], accepted: ["delivered", "blocked", "canceled"],
      delivered: ["confirmed", "blocked", "canceled"], blocked: ["accepted", "delivered", "canceled"], confirmed: [], canceled: [],
    };
    if (!transitions[held.state].includes(input.state)) throw new Error("Invalid dependency transition.");
    if ((input.state === "accepted" || input.state === "delivered") && !producer) throw new Error("The producer must accept or deliver this dependency.");
    if (input.state === "confirmed" && !consumer) throw new Error("Only the consumer can confirm that the artifact unblocks its work.");
    if (input.state === "delivered" && !input.artifact) throw new Error("Delivery requires an exact artifact reference or version.");
    await Promise.all([this.owner(held.producer), this.owner(held.consumer)]);
    const all = this.read();
    const item = all.find((d) => d.id === input.id)!;
    if (item.revision !== input.revision || this.store.read().revision !== binding.revision) throw new Error("Dependency or scope changed while verifying its owners.");
    Object.assign(item, { state: input.state, checkpoint: input.checkpoint, artifact: input.artifact ?? item.artifact, revision: item.revision + 1, by: actor, at: Date.now() });
    writeJson(this.file, all);
    await this.notify(item);
    return item;
  }

  async recover(): Promise<void> {
    for (const item of this.read()) await this.notify(item).catch(() => undefined);
  }

  private async notify(item: Dependency): Promise<void> {
    const binding = this.store.read();
    if (!binding.active || !binding.supervisor) return;
    for (const owner of [item.producer, item.consumer]) {
      const workspace = await this.owner(owner);
      await this.outbox.post({ to: owner.agent, key: `dependency:${item.id}:${item.revision}`,
        text: `Dependency ${item.id} revision ${item.revision}: ${item.state}. Producer ${item.producer.project}/${item.producer.agent}; consumer ${item.consumer.project}/${item.consumer.agent}. Requested: ${item.request}. Artifact: ${item.artifact ?? "none"}. Next checkpoint: ${item.checkpoint}. Only the consumer can confirm it can proceed.`,
        guard: { actor: binding.supervisor.agent, revision: binding.revision, project: owner.project, workspace, operation: "coordinate" } });
    }
  }
}
