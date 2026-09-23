import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Binding, type DeliveryGuard, type Operation, type ScopeProject } from "../../shared/supervision.ts";
import { writeJson } from "../core/store.ts";
import type { SeatLook } from "../core/ports.ts";
import { gitRoot, projectOf, type Project } from "../desk/project.ts";

export const emptyBinding = (): Binding => ({ version: 2, revision: 0, active: false, supervisor: null, projects: [] });
export const canonicalRoot = (path: string): string => realpathSync(gitRoot(realpathSync(path)));

export class Supervision {
  readonly root: string;
  readonly file: string;

  constructor(root: string) {
    this.root = root;
    this.file = join(root, "supervision.json");
  }

  read(): Binding {
    if (!existsSync(this.file)) return emptyBinding();
    return Binding.parse(JSON.parse(readFileSync(this.file, "utf8")));
  }

  change(revision: number, edit: (binding: Binding) => void): Binding {
    const next = this.read();
    if (next.revision !== revision) throw new Error("Supervision changed. Refresh before saving.");
    edit(next);
    next.revision++;
    Binding.parse(next);
    if (new Set(next.projects.map((p) => p.id)).size !== next.projects.length || new Set(next.projects.map((p) => p.root)).size !== next.projects.length) throw new Error("Each repository can be enrolled only once.");
    if (next.active && !next.supervisor) throw new Error("Select a Supervisor before activating supervision.");
    writeJson(this.file, next);
    return next;
  }

  authorize(actor: string, id: string, operation: Operation): { project: Project; scope: ScopeProject; revision: number } {
    const binding = this.read();
    if (!binding.active || binding.supervisor?.agent !== actor) throw new Error("This agent is not the active overall Supervisor.");
    const scope = binding.projects.find((p) => p.id === id);
    if (!scope || !scope.grants.includes(operation)) throw new Error(`Project ${id} does not grant ${operation}.`);
    if (canonicalRoot(scope.root) !== scope.root) throw new Error("The project's path changed; reconcile its binding first.");
    return { project: projectOf(scope.root, this.root), scope, revision: binding.revision };
  }

  recipient(project: Project): string | undefined {
    const binding = this.read();
    return binding.active && binding.projects.some((p) => p.root === project.root && p.grants.includes("observe")) ? binding.supervisor?.agent : undefined;
  }

  validate(guard: DeliveryGuard, seat: SeatLook): string | undefined {
    try {
      const { scope, revision } = this.authorize(guard.actor, guard.project, guard.operation);
      if (revision !== guard.revision) return "The supervision grant changed after this command was queued.";
      if (seat.archivedAt) return "The addressed agent was archived.";
      if (guard.recipient === "supervisor") return seat.id === guard.actor && seat.workspaceId === guard.workspace ? undefined : "The selected Supervisor changed.";
      if (seat.projectId !== scope.id || seat.workspaceId !== guard.workspace || !seat.cwd || canonicalRoot(seat.cwd) !== scope.root) return "The addressed agent's workspace or project changed.";
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
