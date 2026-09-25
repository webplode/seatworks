import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LAND_AS, type LandAs, gitCommonDir } from "../core/git.ts";
import { stateRoot } from "../core/paths.ts";
import { SERIAL_ONLY } from "../core/scope.ts";
import { readJson, writeJson } from "../core/store.ts";

export type Project = { root: string; slug: string; state: string };

export type GateOn = "lane" | "task";

export type ProjectConfig = { base?: string; gate?: string; gateTimeoutMinutes: number; gateOn: GateOn; serialOnly: string[]; landAs: LandAs };

const cache = new Map<string, Project>();

export function gitRoot(cwd: string): string {
  const common = gitCommonDir(cwd);
  if (!common) return cwd;
  return basename(common) === ".git" ? dirname(common) : common;
}

export function slugFor(root: string): string {
  const name =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "project";
  return `${name}-${createHash("sha1").update(root).digest("hex").slice(0, 6)}`;
}

export function projectOf(cwd: string, base = stateRoot(), rootOf: (cwd: string) => string = gitRoot): Project {
  const key = `${base}\n${cwd}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const root = rootOf(cwd);
  const slug = slugFor(root);
  const project = { root, slug, state: join(base, "projects", slug) };
  cache.set(key, project);
  return project;
}

export function clearProjects(): void {
  cache.clear();
}

export function detectGate(root: string): string | undefined {
  const has = (name: string) => existsSync(join(root, name));
  if (has("package.json")) {
    try {
      const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))?.scripts ?? {};
      if (typeof scripts.test === "string" && !/no test specified/.test(scripts.test)) {
        if (has("pnpm-lock.yaml")) return "pnpm test";
        if (has("yarn.lock")) return "yarn test";
        if (has("bun.lock") || has("bun.lockb")) return "bun run test";
        return "npm test";
      }
    } catch {}
  }
  if (has("mvnw")) return "./mvnw -q test";
  if (has("pom.xml")) return "mvn -q test";
  if (has("gradlew")) return "./gradlew test";
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini")) return "pytest -q";
  return undefined;
}

/** The commands that run `gate`: the gate first, then the test runner its script starts, which is how a seat runs its own module's tests. */
export function gateCommands(root: string, gate: string | undefined): string[] {
  if (!gate?.trim()) return [];
  const script = /^(?:npm|pnpm|yarn|bun)(?: run)? ([\w:.-]+)$/.exec(gate.trim())?.[1];
  let body: unknown;
  try {
    body = script ? JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))?.scripts?.[script] : undefined;
  } catch {}
  if (typeof body !== "string") return [gate];
  // The script's last command runs the tests; its runner is the program plus at most one word, never a path.
  const words = body.split(/&&|\|\||;/).at(-1)!.trim().split(/\s+/).slice(0, 2);
  const runner = words.slice(0, words.findIndex((word) => !/^[\w@.:-]+$/.test(word)) >>> 0).join(" ");
  return runner && runner !== gate ? [gate, runner] : [gate];
}

export function configFile(state: string): string {
  return join(state, "project.json");
}

/** The Supervisor alone writes it; a Lead is pointed at it once there is one. */
export function conceptFile(state: string): string | undefined {
  const file = join(state, "CONTEXT.md");
  return existsSync(file) ? file : undefined;
}

/** An empty gate is the owner's decision and must survive a read: as `undefined`, `open_lane` would seed a detected gate over it. */
export function loadConfig(state: string): ProjectConfig {
  const stored = readJson<Partial<ProjectConfig>>(configFile(state), {});
  const minutes = Number(stored.gateTimeoutMinutes);
  return {
    base: typeof stored.base === "string" && stored.base ? stored.base : undefined,
    gate: typeof stored.gate === "string" ? stored.gate : undefined,
    gateTimeoutMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 30,
    gateOn: stored.gateOn === "task" ? "task" : "lane",
    serialOnly: Array.isArray(stored.serialOnly) ? stored.serialOnly.map(String) : SERIAL_ONLY,
    landAs: LAND_AS.find((as) => as === stored.landAs) ?? "squash",
  };
}

export function saveConfig(state: string, config: ProjectConfig): void {
  writeJson(configFile(state), config);
}
