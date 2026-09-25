import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = mkdtempSync(join(tmpdir(), "sw2-flow-home-"));
process.env.HOME = HOME;
globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;

const { loadKit } = await import("../../server/catalog/kit.ts");
const { applyModels } = await import("../../server/catalog/models.ts");
const { loadLedger } = await import("../../server/desk/ledger.ts");
const { projectOf } = await import("../../server/desk/project.ts");
type Project = ReturnType<typeof projectOf>;
const { Runtime } = await import("../../server/runtime/runtime.ts");
const { FakeTimeline } = await import("./fake-timeline.ts");

export type Pending = { id: string; kind: string; name: string; title?: string; input?: Record<string, unknown> };
type Fake = {
  id: string;
  provider: string;
  workspaceId: string;
  cwd: string;
  title: string;
  status: string;
  archivedAt: string | null;
  updatedAt: string;
  sent: string[];
  sentIds: string[];
  steered: string[];
  pending: Pending[];
  answered: { requestId: string; response: { behavior: string; updatedInput?: { answers?: Record<string, string> } } }[];
  prompt?: string;
  promptId?: string;
  labels: Record<string, string>;
};

function fakePaseo() {
  const agents = new Map<string, Fake>();
  const workspaces = new Map<string, string>();
  const workspaceNames = new Map<string, string>();
  const workspaceProjects = new Map<string, string>();
  const archivedWorkspaces = new Set<string>();
  const timelines = new Map<string, InstanceType<typeof FakeTimeline>>();
  const timelineOf = (id: string) => {
    const found = timelines.get(id) ?? new FakeTimeline();
    timelines.set(id, found);
    return found;
  };
  let count = 0;
  const ref = (id: string) => {
    const agent = agents.get(id);
    return {
      id,
      timeline: timelineOf(id),
      get status() { return agent?.status ?? null; },
      get cwd() { return agent?.cwd ?? null; },
      get archivedAt() { return agent?.archivedAt ?? null; },
      get pendingPermissions() { return agent?.pending ?? []; },
      async refresh() {},
      current() { return agent ? { id: agent.id, provider: agent.provider, cwd: agent.cwd, title: agent.title, workspaceId: agent.workspaceId } : null; },
      async send(text: string, options?: { activeTurnBehavior?: string; messageId?: string }) {
        agent?.sent.push(text);
        if (options?.messageId) agent?.sentIds.push(options.messageId);
        if (options?.activeTurnBehavior === "steer") agent?.steered.push(text);
      },
      async respondToPermission({ requestId, response }: Fake["answered"][number]) {
        const at = agent?.pending.findIndex((request) => request.id === requestId) ?? -1;
        if (!agent || at < 0) throw new Error(`No pending permission request with id '${requestId}'`);
        agent.pending.splice(at, 1);
        agent.answered.push({ requestId, response });
      },
      async archive() { if (agent) Object.assign(agent, { archivedAt: new Date().toISOString(), status: "closed" }); },
    };
  };
  const add = (provider: string, cwd: string, title: string, status = "idle", prompt?: string, labels: Record<string, string> = {}) => {
    const id = `agent-${++count}`;
    agents.set(id, { id, provider, workspaceId: `workspace:${cwd}`, cwd, title, status, archivedAt: null, updatedAt: new Date().toISOString(), sent: [], sentIds: [], steered: [], pending: [], answered: [], prompt, labels });
    return id;
  };
  const workspace = (id: string) => ({
    id,
    projectId: workspaceProjects.get(id) ?? null,
    async refresh() {
      const path = id.startsWith("workspace:") ? id.slice("workspace:".length) : workspaces.get(id);
      return path ? { id, projectId: projectOf(path).slug, workspaceDirectory: path, archivingAt: archivedWorkspaces.has(id) ? new Date().toISOString() : null } : null;
    },
    agents: {
      async create(options: { config: { provider: string }; title: string; prompt: string; clientMessageId?: string; labels?: Record<string, string> }) {
        const made = add(options.config.provider, workspaces.get(id)!, options.title, "running", options.prompt, options.labels);
        agents.get(made)!.promptId = options.clientMessageId;
        return ref(made);
      },
    },
  });
  const paseo = {
    projects: {
      async list() {
        const roots = [...new Set([...agents.values()].map((a) => projectOf(a.cwd).root))];
        return { projects: roots.map((root) => ({ projectId: projectOf(root).slug, projectRootPath: root, projectDisplayName: root })) };
      },
    },
    agents: {
      ref,
      // The daemon caps a page at 200 rows and reports the rest through pageInfo, so the fake does too.
      async list(options?: { page?: { limit?: number; cursor?: string } }) {
        const all = [...agents.values()].map((agent) => ({ agent: { ...agent, pendingPermissions: agent.pending } }));
        const from = Number(options?.page?.cursor ?? 0);
        const limit = options?.page?.limit ?? 200;
        const next = from + limit;
        return {
          entries: all.slice(from, next),
          pageInfo: { hasMore: next < all.length, nextCursor: next < all.length ? String(next) : null, prevCursor: null },
        };
      },
    },
    workspaces: {
      // The daemon files a directory under the given project, or makes one of the directory when given none.
      async create({ title, source }: { title?: string; source: { path: string; projectId?: string } }) {
        const id = `ws-${workspaces.size + 1}`;
        workspaces.set(id, source.path);
        workspaceProjects.set(id, source.projectId ?? `prj:${source.path}`);
        if (title) workspaceNames.set(id, title);
        return workspace(id);
      },
      async list() {
        return {
          entries: [...workspaces.keys()].map((id) => ({ id, projectId: workspaceProjects.get(id)!, name: workspaceNames.get(id) ?? "", archivingAt: archivedWorkspaces.has(id) ? new Date().toISOString() : null })),
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        };
      },
      async archive(id: string) {
        archivedWorkspaces.add(typeof id === "string" ? id : (id as { id: string }).id);
        return { archivedAt: new Date().toISOString() };
      },
      ref: workspace,
    },
  };
  return { paseo: paseo as never, agents, add, workspaces, workspaceNames, workspaceProjects, archivedWorkspaces, timelineOf };
}

export function repo(): { root: string; git: (cwd: string, ...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "sw2-flow-repo-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { encoding: "utf-8" });
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "b.txt"), "bee\n");
  // A real one, because the desk now reads the serial-only rules against the files that exist.
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  // An IntelliJ project, which is what the index these tests fake serves.
  mkdirSync(join(root, ".idea"));
  writeFileSync(join(root, ".idea", "misc.xml"), "<project/>\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "seed");
  return { root, git };
}

export const kit = loadKit(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const thinking = ["low", "medium", "high"].map((id) => ({ id, label: id }));
applyModels(kit, {
  claude: { at: "", error: null, models: [{ id: "claude-opus-5", label: "Opus 5", thinkingOptions: thinking }] },
  codex: { at: "", error: null, models: [{ id: "gpt-5.6-luna", label: "GPT-5.6-Luna" }] },
});

export const ideCalls: { kind: "open" | "sync" | "close"; path: string }[] = [];
const ide = {
  async open(path: string) {
    ideCalls.push({ kind: "open" as const, path });
    return { ok: true, text: "opened" };
  },
  async sync(path: string) {
    ideCalls.push({ kind: "sync" as const, path });
    return { ok: true, text: "synced" };
  },
  async close(path: string) {
    ideCalls.push({ kind: "close" as const, path });
    return { ok: true, text: "closed" };
  },
};

export function harness(outbox: string) {
  const { root, git } = repo();
  const state = join(HOME, ".local", "share", "seatworks-v2");
  mkdirSync(state, { recursive: true });
  // By Jev with a key and an unreachable endpoint: the watch on, the sensor silent unless a test asks.
  writeFileSync(join(state, "settings.json"), JSON.stringify({ sensor: { key: "sk-or-harness" }, attention: { by: "jev" }, mcp: { "intellij-index": { enabled: true }, "code-search": { enabled: true }, context7: { enabled: true } } }));
  const { paseo, agents, add: nativeAdd, workspaces, workspaceNames, workspaceProjects, archivedWorkspaces, timelineOf } = fakePaseo();
  const runtime = new Runtime(kit, { outboxFile: join(HOME, outbox), paseo, codeIndex: (proxy: { id: string; gitExclude?: string[] }) => ({ ...ide, id: proxy.id, gitExclude: proxy.gitExclude ?? [] }), reloadDaemon: async () => true });
  const project = projectOf(root);
  // Paseo seats a project's agents through the create hook, which records the project; the seats added here skip it.
  (runtime as unknown as { remember(project: Project): void }).remember(project);
  runtime.supervision.store.change(runtime.supervision.store.read().revision, (binding) => { binding.active = false; binding.supervisor = null; binding.projects = []; });
  const add: typeof nativeAdd = (...args) => {
    const id = nativeAdd(...args);
    if (args[0].includes("supervisor") && (!runtime.supervision.store.read().supervisor || agents.get(runtime.supervision.store.read().supervisor!.agent)?.archivedAt)) {
      const selected = projectOf(args[1]);
      runtime.supervision.store.change(runtime.supervision.store.read().revision, (binding) => {
        binding.active = true;
        binding.supervisor = { agent: id, workspace: `workspace:${args[1]}` };
        if (!binding.projects.some((p) => p.id === selected.slug)) binding.projects.push({ id: selected.slug, slug: selected.slug, root: selected.root, name: selected.slug, grants: ["observe", "message", "answer", "open_lane", "set_project", "close_lane", "land", "ack", "coordinate"], leads: [] });
      });
    }
    return id;
  };
  let n = 0;
  // `where` is the calling working copy, since several desk keys turned out shared between projects.
  const call = async (agent: string, role: string, tool: string, args: Record<string, unknown>, where = root) =>
    runtime.desk.handle({ id: `${outbox}-${++n}`, agent, role, tool, args: role === "supervisor" ? { ...args, project: projectOf(where).slug } : args, cwd: where, at: Date.now() });
  const idle = async (id: string) => {
    agents.get(id)!.status = "idle";
    runtime.outbox.turnEnded(id);
    await runtime.outbox.pump(id);
  };
  const commit = (cwd: string, file: string, text: string) => {
    writeFileSync(join(cwd, file), text);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", `edit ${file}`);
  };
  const ledger = (of: Project = project) => loadLedger(of.state);
  const tick = (now?: number) => (runtime as unknown as { patrol: { tick(now?: number): Promise<void> } }).patrol.tick(now);
  // Paseo fires a turn start before a turn end; without one, a turn is measured from half an hour ago.
  const beginTurn = (id: string) => (runtime as unknown as { turnStarted(agentId: string): void }).turnStarted(id);
  // Paseo hands this hook the seat's whole append-only timeline, not the turn that ended.
  const told = new Map<string, unknown[]>();
  const endTurn = (id: string, text: string, ...calls: unknown[]) => {
    const timeline = told.get(id) ?? [];
    timeline.push({ type: "user_message", text: "go" }, ...calls, { type: "assistant_message", text });
    told.set(id, timeline);
    return (runtime as unknown as { turnEnded: (event: unknown) => Promise<void> }).turnEnded({
      agent: { id, provider: agents.get(id)!.provider, cwd: agents.get(id)!.cwd, title: agents.get(id)!.title, parentAgentId: null, workspaceId: null },
      turnId: `t-${id}-${Date.now()}`,
      outcome: { kind: "completed" },
      timeline: [...timeline],
    });
  };
  const permission = (id: string, request: Pending) =>
    (runtime as unknown as { permissionRequested: (event: unknown) => Promise<void> }).permissionRequested({
      agent: { id, provider: agents.get(id)!.provider, cwd: agents.get(id)!.cwd, title: agents.get(id)!.title, parentAgentId: null, workspaceId: null },
      request,
    });
  return { root, git, paseo, agents, add, workspaces, workspaceNames, workspaceProjects, archivedWorkspaces, runtime, project, call, idle, commit, ledger, endTurn, tick, beginTurn, permission, timelineOf };
}

export async function laneWithPeer(outbox: string, settings?: Record<string, unknown>) {
  const h = harness(outbox);
  if (settings) {
    mkdirSync(h.project.state, { recursive: true });
    writeFileSync(join(h.project.state, "settings.json"), JSON.stringify(settings));
  }
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Build", outcome: "a.txt changes", acceptance: ["a"], outOfScope: ["anything else in the repository"] });
  const lane = h.ledger().lanes.L1!;
  await h.call(lane.lead!, "lead", "start_task", { title: "Clean build", goal: "g", acceptance: ["a"], owned: ["a.txt"], outOfScope: ["the rest of the repository"] });
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  await h.tick();
  return { h, sup, lane, peer, timeline: h.timelineOf(peer) };
}
