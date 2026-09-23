import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Kit } from "../catalog/kit.ts";
import { type Layer, MachineLayerSchema, ProjectLayerSchema, layerValues, readLayer } from "../catalog/settings.ts";
import { type Team, resolveTeam, servingProject } from "../catalog/team.ts";
import { stateRoot } from "../core/paths.ts";
import { readJson, writeJson } from "../core/store.ts";
import type { Project } from "../desk/project.ts";

export class TeamSource {
  private readonly kit: Kit;
  private readonly recorded = new Set<string>();

  constructor(kit: Kit) {
    this.kit = kit;
  }

  machineFile(): string {
    return join(stateRoot(), "settings.json");
  }

  projectFile(project: Project): string {
    return join(project.state, "settings.json");
  }

  machineLayer(): Layer {
    return layerValues(this.machineFile(), MachineLayerSchema);
  }

  teamFor(project?: Project): Team {
    const machine = readLayer(this.machineFile(), MachineLayerSchema);
    const local = project ? readLayer(this.projectFile(project), ProjectLayerSchema) : { status: "ready" as const, values: {}, revision: "" };
    const unread = [
      ...(machine.status === "ready" ? [] : [`The machine settings are not being used: ${machine.error}`]),
      ...(local.status === "ready" ? [] : [`The project settings are not being used: ${"error" in local ? local.error : "they could not be read"}`]),
    ];
    const team = resolveTeam(this.kit, machine.status === "ready" ? machine.values : {}, local.status === "ready" ? local.values : {}, unread);
    return project ? servingProject(team, project.root) : team;
  }

  revision(project?: Project): string {
    const machine = readLayer(this.machineFile(), MachineLayerSchema).revision;
    const local = project ? readLayer(this.projectFile(project), ProjectLayerSchema).revision : "";
    return `${machine}:${local}`;
  }

  record(project: Project): void {
    // The Set only skips rewrites: a project detached this session leaves it set with no file on disk.
    if (this.recorded.has(project.slug) && existsSync(join(project.state, "meta.json"))) return;
    try {
      mkdirSync(project.state, { recursive: true });
      writeJson(join(project.state, "meta.json"), { root: project.root, slug: project.slug });
      this.recorded.add(project.slug);
    } catch (error) {
      console.error("seatworks-v2: could not record the project:", error);
    }
  }

  /** Whether the project is still on record: detached, or its state removed by hand, it is not. */
  onRecord(project: Project): boolean {
    return existsSync(join(project.state, "meta.json"));
  }

  /** A project that is no longer on record: the next attach has to write it again. */
  forget(slug: string): void {
    this.recorded.delete(slug);
  }

  known(): Project[] {
    const root = join(stateRoot(), "projects");
    if (!existsSync(root)) return [];
    const found: Project[] = [];
    for (const slug of readdirSync(root)) {
      const meta = readJson<{ root?: string; slug?: string }>(join(root, slug, "meta.json"), {});
      if (typeof meta.root === "string" && meta.slug === slug) found.push({ root: meta.root, slug, state: join(root, slug) });
    }
    return found.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  named(slug: string): Project | undefined {
    return this.known().find((project) => project.slug === slug);
  }
}
