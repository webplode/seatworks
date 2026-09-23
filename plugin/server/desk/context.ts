import { createHash } from "node:crypto";
import type { Team } from "../catalog/team.ts";
import type { Kit, RoleSpec } from "../catalog/kit.ts";
import { type Ledger, type Task, ledgerFault, loadLedger, saveLedger } from "./ledger.ts";
import type { Project } from "./project.ts";
import { appendRecord } from "./records.ts";
import { type Incidents, incidentsFault, loadIncidents, saveIncidents } from "./incidents.ts";
import type { Sent } from "../runtime/watch/seat/reader.ts";
import type { Supervision } from "../runtime/supervision.ts";
import type { DeliveryGuard } from "../../shared/supervision.ts";

export type ToolRequest = { id: string; agent: string; role: string; tool: string; args: Record<string, unknown>; cwd: string; at: number };
export type ToolReply = { ok: boolean; text: string };
export type Args = Record<string, unknown>;
export type Caller = { id: string; role: RoleSpec; title: string; project: Project; revalidate?: () => void; deliveryGuard?: Omit<DeliveryGuard, "workspace"> };

export const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
export const strs = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : typeof value === "string" && value.trim() ? [value.trim()] : [];
/** Only the fields the call names, read as text or as a list: an amendment changes what it is given and nothing else. */
export const given = (args: Args, texts: string[], lists: string[]): Record<string, string | string[]> =>
  Object.fromEntries([...texts.map((key) => [key, str(args[key])] as const), ...lists.map((key) => [key, strs(args[key])] as const)].filter(([key]) => args[key] !== undefined));
export const ok = (text: string): ToolReply => ({ ok: true, text });
export const no = (text: string): ToolReply => ({ ok: false, text });
export const hash = (...parts: string[]): string => createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 12);

export type CodeIndex = {
  id: string;
  gitExclude: string[];
  open(path: string): Promise<{ ok: boolean; text: string }>;
  sync(path: string): Promise<{ ok: boolean; text: string }>;
  close(path: string): Promise<{ ok: boolean; text: string }>;
};

/** "duplicate": dropped as a repeat of a letter already sent. */
export type Posted = "sent" | "held" | "duplicate";

export type Mailer = { post(letter: { to: string; key: string; text: string; guard?: DeliveryGuard }): Promise<Posted>; acknowledge?(id: string, actor: string): void };

export type DeskDeps = {
  kit: Kit;
  outbox: Mailer;
  log: (project: Project, line: string) => void;
  teamFor: (project?: Project) => Team;
  indexesFor: (project: Project) => CodeIndex[];
  sent?: (watcher: string, ref: string) => Sent | undefined;
  supervision?: Supervision;
};

export class DeskContext {
  readonly kit: Kit;
  readonly projects = new Map<string, Project>();
  readonly seating = new Set<string>();
  private readonly deps: DeskDeps;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(deps: DeskDeps) {
    this.deps = deps;
    this.kit = deps.kit;
  }

  team(project?: Project): Team {
    return this.deps.teamFor(project);
  }

  sent(watcher: string, ref: string): Sent | undefined {
    return this.deps.sent?.(watcher, ref);
  }

  acknowledge(id: string, actor: string): void {
    if (!this.deps.outbox.acknowledge) throw new Error("Delivery receipts are unavailable.");
    this.deps.outbox.acknowledge(id, actor);
  }

  indexes(project: Project): CodeIndex[] {
    return this.deps.indexesFor(project);
  }

  log(project: Project, line: string): void {
    this.deps.log(project, line);
  }

  /** The one place project work queues behind running work: two writers stay off one ledger only by naming the same key here. */
  private under<T>(key: string, run: () => T | Promise<T>): Promise<T> {
    const waiting = this.locks.get(key) ?? Promise.resolve();
    const next = waiting.then(() => run());
    this.locks.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  ledger<T>(project: Project, change: (ledger: Ledger) => T | Promise<T>): Promise<T> {
    this.projects.set(project.slug, project);
    return this.under(project.slug, async () => {
      const fault = ledgerFault(project.state);
      if (fault) throw new Error(`${fault}. Nothing was written over it. Only the Human can repair it or move it aside — no seat may write the desk's own files — and what the desk has on record is in that file.`);
      const ledger = loadLedger(project.state);
      const result = await change(ledger);
      saveLedger(project.state, ledger);
      return result;
    });
  }

  /** Read the ledger in turn with its writers, writing nothing back. An unreadable ledger still refuses: read as empty, every copy would look stray. */
  read<T>(project: Project, look: (ledger: Ledger) => T): Promise<T> {
    return this.under(project.slug, () => {
      const fault = ledgerFault(project.state);
      if (fault) throw new Error(`${fault}. Nothing was read from it as if it were empty.`);
      return look(loadLedger(project.state));
    });
  }

  incidents<T>(project: Project, change: (incidents: Incidents) => T): Promise<T> {
    this.projects.set(project.slug, project);
    return this.under(`${project.slug}:incidents`, () => {
      const fault = incidentsFault(project.state);
      if (fault) throw new Error(`${fault}. Nothing was written over it. Only the Human can repair it or move it aside.`);
      const incidents = loadIncidents(project.state);
      const result = change(incidents);
      saveIncidents(project.state, incidents);
      return result;
    });
  }

  event(project: Project, data: Record<string, unknown>): void {
    try {
      appendRecord(project.state, "events", `${JSON.stringify({ at: new Date().toISOString(), ...data })}\n`);
    } catch (error) {
      console.error("seatworks-v2: events.log write failed:", error);
    }
  }

  async post(to: string | undefined, key: string, text: string, project?: Project, authority?: DeliveryGuard): Promise<Posted | "nobody"> {
    if (!to) return "nobody";
    const binding = this.deps.supervision?.read();
    const scope = project && binding?.projects.find((p) => p.root === project.root);
    const guard: DeliveryGuard | undefined = authority ?? (scope && binding?.supervisor?.agent === to
      ? { actor: to, revision: binding.revision, project: scope.id, workspace: binding.supervisor.workspace, operation: "observe", recipient: "supervisor" } : undefined);
    return this.deps.outbox.post({ to, key: project ? `${project.slug}:${key}` : key, text: project ? `[Project ${scope?.id ?? project.slug}]\n${text}` : text, ...(guard ? { guard } : {}) });
  }

  setTask(project: Project, taskId: string, change: (task: Task) => void): Promise<Task | undefined> {
    return this.ledger(project, (ledger) => {
      const task = ledger.tasks[taskId];
      if (!task) return undefined;
      change(task);
      task.updatedAt = Date.now();
      return { ...task };
    });
  }
}
