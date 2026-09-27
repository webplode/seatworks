import "./setup.ts";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./tempdir.ts";
import { type Kit, type ModelSpec, loadKit } from "../server/catalog/kit/kit.ts";
import { type ModelCache, applyModels } from "../server/catalog/paseo/models.ts";

function put(root: string, path: string, value: unknown): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

export function makeKit(): Kit {
  const dir = tempDir("sw3-kit-");
  put(dir, "roles.json", {
    providerPrefix: "sw3-",
    roles: [
      {
        role: "supervisor",
        label: "Supervisor",
        can: ["supervise"],
        tools: "supervisor",
        defaults: { harness: "claude", model: "opus", thinking: "high" },
        prompt: "prompts/SUPERVISOR.md",
        skills: "supervisor",
        paseoTools: { disabledTools: ["update_agent"] },
      },
      {
        role: "lead",
        label: "Lead",
        can: ["lead"],
        tools: "lead",
        defaults: { harness: "claude", model: "opus", thinking: "medium" },
        prompt: "prompts/LEAD.md",
        skills: null,
        hidesWords: ["supervisor"],
        writes: ["plans/"],
      },
      {
        role: "peer",
        label: "Peer",
        can: ["work"],
        tools: "peer",
        defaults: { harness: "omp", model: "glm" },
        prompt: "prompts/PEER.md",
        skills: "peer",
        extraSkills: ["supervisor:plan-check"],
        paseoTools: { enabled: false },
        hidesWords: ["paseo", "seat"],
      },
      {
        role: "scribe",
        label: "Scribe",
        follows: "peer",
        prompt: "prompts/SCRIBE.md",
        skills: null,
      },
    ],
  });
  put(dir, "harness/claude/harness.json", {
    id: "claude",
    label: "Claude Code",
    baseProvider: "claude",
    configDirEnv: "CLAUDE_CONFIG_DIR",
    profileRoot: "HOME/.claude/profiles",
    contextFile: "CLAUDE.md",
    skillsDir: "skills",
    stateWrites: { path: "settings.sandbox.filesystem.allowWrite", delivery: "launch" },
    projectContextOption: "additionalDirectories",
    projectInstructions: {
      reads: ["CLAUDE.md", ".claude/CLAUDE.md"],
      imports: ["AGENTS.md", ".claude/AGENTS.md"],
      importAs: "@{path}",
    },
    settings: { file: "settings.json", source: "settings.json", roleSource: "settings/ROLE.settings.json" },
    links: [{ link: "projects", target: "HOME/.claude/projects" }],
    login: {
      run: ["auth", "status"],
      field: "loggedIn",
      help: "Log in with claude once, outside any seat; every Claude seat shares that login.",
    },
    models: [
      {
        id: "opus",
        label: "Opus",
        thinkingOptions: [
          { id: "medium", label: "M" },
          { id: "high", label: "H" },
        ],
      },
      { id: "haiku", label: "Haiku" },
    ],
    mcp: {
      file: ".claude.json",
      delivery: "launch",
      seed: { hasCompletedOnboarding: true },
      clear: {
        set: { mcpServers: {}, enabledMcpjsonServers: [] },
        remove: ["enableAllProjectMcpServers"],
        setInEach: { projects: { mcpServers: {} } },
      },
      transports: ["stdio", "http"],
    },
    provider: {
      env: {
        CLAUDE_CODE_DISABLE_CRON: "1",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
        SEATWORKS_HARNESS: "claude",
        SEATWORKS_AGENT_BIN: "claude",
      },
      profileModeId: "bypassPermissions",
      command: ["NODE", "KIT/bin/seat-room.mjs"],
    },
  });
  put(dir, "harness/claude/settings.json", { autoMemoryEnabled: false, permissions: { deny: ["WebSearch"] } });
  put(dir, "harness/claude/settings/supervisor.settings.json", { askUserQuestionTimeout: "never" });
  put(dir, "harness/claude/settings/lead.settings.json", { permissions: { deny: ["Agent"] } });
  put(dir, "harness/claude/settings/scribe.settings.json", {});
  put(dir, "harness/omp/harness.json", {
    id: "omp",
    label: "Oh My Pi",
    baseProvider: "omp",
    configDirEnv: "PI_CODING_AGENT_DIR",
    profileRoot: "HOME/.omp/seats",
    contextFile: "AGENTS.md",
    skillsDir: "skills",
    settings: { file: "config.yml", source: "settings.json", roleSource: "settings/ROLE.settings.json" },
    links: [{ link: "git", target: "HOME/.config/git", optional: true }],
    models: [{ id: "glm", label: "GLM" }],
    mcp: { file: "mcp.json", delivery: "file", key: "mcpServers", transports: ["stdio", "http"] },
    provider: { env: { SEATWORKS_HARNESS: "omp", SEATWORKS_AGENT_BIN: "omp" }, profileModeId: "full" },
    checks: [{ path: "HOME/.omp/agent/agent.db", help: "Log in with omp once, outside any seat." }],
  });
  put(dir, "harness/omp/settings.json", {
    ask: { enabled: false },
    bash: { patterns: [{ match: "git push*", approval: "deny" }] },
  });
  put(dir, "harness/omp/settings/lead.settings.json", {});
  put(dir, "harness/omp/settings/peer.settings.json", {});
  put(dir, "harness/omp/settings/scribe.settings.json", { tools: { approval: { bash: "deny" } } });
  put(dir, "catalog/mcp/ide/mcp.json", {
    id: "ide",
    label: "IDE",
    order: 10,
    kind: "proxy",
    proxy: {
      backend: { type: "http", url: "http://127.0.0.1:{port}/mcp" },
      pin: "project_path",
      gitExclude: [".idea/"],
      open: { tool: "ide_open_project", args: { path: "{root}" } },
    },
    instructions: "Prefer the IDE tools.",
    requires: [".idea"],
    settings: { port: { type: "list", of: "number", label: "Ports", default: [29170] } },
    defaults: { enabled: true },
    tools: { lead: ["ide_find_references"], peer: ["ide_find_references", "ide_refactor_rename"] },
    rule: "rule.md",
    roleNotes: { peer: "Check diagnostics before handing back." },
    skills: ["ide-guide"],
  });
  put(dir, "catalog/mcp/ide/rule.md", "Prefer the IDE for navigation.\n");
  put(dir, "catalog/mcp/ide/skills/ide-guide/SKILL.md", "---\nname: ide-guide\ndescription: using the IDE\n---\n");
  put(dir, "catalog/mcp/docs/mcp.json", {
    id: "docs",
    label: "Docs",
    order: 30,
    kind: "server",
    server: { type: "http", url: "https://docs.example/{path}" },
    settings: { path: { type: "string", label: "Path", default: "mcp" } },
    defaults: { enabled: false },
    roles: ["supervisor", "lead", "peer"],
    rule: "rule.md",
  });
  put(dir, "catalog/mcp/docs/rule.md", "Look library APIs up in the docs.\n");
  // The fixture carries tool sets like the real kit, because a role names one and the kit is asked for it.
  // The shipped ecosystem, Paseo's tools, the watch's questions and what a seat's PATH refuses are the world's, not this fixture's to make up.
  for (const name of ["ecosystem.json", "paseo.json", "checks.json", "refused.json"])
    put(dir, `catalog/${name}`, readFileSync(new URL(`../catalog/${name}`, import.meta.url), "utf-8"));
  // The shipped thresholds, with no brain, since no role of the fixture's can judge, and one threshold of its own.
  const attention = JSON.parse(readFileSync(new URL("../catalog/attention.json", import.meta.url), "utf-8")) as object;
  put(dir, "catalog/attention.json", { ...attention, brain: "off", sensor: "", leadIdleMinutes: 15 });
  // No role of the fixture's is watched, so no pattern could read one.
  put(dir, "catalog/patterns.json", {});
  put(dir, "mcp/tools.json", {
    supervisor: [{ name: "open_lane" }, { name: "answer" }, { name: "status" }],
    lead: [{ name: "add_tasks" }, { name: "report" }, { name: "ask" }, { name: "status" }],
    peer: [{ name: "done" }, { name: "ask" }],
  });
  put(dir, "content/prompts/SUPERVISOR.md", "# Supervisor\n\nGuides live in {{guides}}; state in {{state}}.\n");
  put(dir, "content/prompts/LEAD.md", "# Lead\n\nRead {{guides}}/BRIEF.md.\n");
  put(dir, "content/prompts/PEER.md", "# Peer\n\nRead {{guides}}/BRIEF.md.\n");
  put(dir, "content/prompts/SCRIBE.md", "# Scribe\n\nKeep the notes.\n");
  put(dir, "content/guides/BRIEF.md", "# Brief\n");
  put(dir, "content/project/AGENTS.md", "## Seatworks\n\nWork through the team tools.\n");
  put(dir, "content/skills/supervisor/plan-check/SKILL.md", "---\nname: plan-check\ndescription: checks a plan\n---\n");
  put(dir, "content/skills/peer/test-first/SKILL.md", "---\nname: test-first\ndescription: tests\n---\n");
  // Models are what Paseo lists, never harness.json: the ones written above become that list.
  const cache: ModelCache = {};
  for (const id of readdirSync(join(dir, "harness"))) {
    const file = join(dir, "harness", id, "harness.json");
    const { models, ...rest } = JSON.parse(readFileSync(file, "utf-8")) as { models?: ModelSpec[] } & Record<
      string,
      unknown
    >;
    if (models) cache[id] = { at: "2026-01-01T00:00:00.000Z", models, error: null };
    writeFileSync(file, JSON.stringify(rest));
  }
  const kit = loadKit(dir);
  applyModels(kit, cache);
  return kit;
}
