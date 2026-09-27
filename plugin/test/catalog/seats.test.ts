import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { type Kit, loadKit } from "../../server/catalog/kit/kit.ts";
import { seatPairs } from "../../server/catalog/paseo/providers.ts";
import { materialize, seatDir } from "../../server/catalog/seat/seats.ts";
import { sweepSnapshots } from "../../server/catalog/seat/snapshots.ts";
import { serversFor } from "../../server/catalog/seat/servers.ts";
import { resolveTeam, withHarness } from "../../server/catalog/team/team.ts";
import { readConfig } from "../../server/core/config-file.ts";
import { contentRoot } from "../../server/core/paths.ts";
import { reported } from "../console.ts";
import { makeKit } from "../kit.ts";
import { tempDir } from "../tempdir.ts";

const project = { root: "/work/shop", slug: "shop-abc123", state: "/state/shop" };
const context = { node: "/bin/node", socket: "/desk.sock" };
type Server = { args?: string[]; url?: string; env?: unknown };

function put(kit: Kit, path: string, text: string): void {
  mkdirSync(dirname(join(kit.dir, path)), { recursive: true });
  writeFileSync(join(kit.dir, path), text);
}

/** The fixture kit with one more agent, laid down from `files` under its harness folder and loaded as the kit loads it. */
function withAgent(id: string, files: Record<string, string>): Kit {
  const kit = makeKit();
  for (const [path, text] of Object.entries(files)) put(kit, join("harness", id, path), text);
  kit.harnesses[id] = loadKit(kit.dir).harnesses[id]!;
  return kit;
}

test("a Claude seat per project writes shared plus role settings, links skills and clears MCP files", () => {
  const kit = makeKit();
  const team = resolveTeam(kit);
  const home = tempDir("sw3-home-");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const lead = team.roles.lead!;
  const dir = seatDir(kit, lead.role, lead.harness, home, project);
  assert.equal(basename(dir), "sw3-lead-claude-shop-abc123");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      userID: "u",
      mcpServers: { old: {} },
      enableAllProjectMcpServers: true,
      projects: { "/x": { mcpServers: { rogue: {} }, trust: true } },
    }),
  );
  symlinkSync(join(kit.dir, "harness/claude/settings/lead.settings.json"), join(dir, "settings.json"));

  const changes = materialize(kit, team, "lead", home, project, serversFor(kit, team, "lead", context));
  assert.ok(changes.length > 0);
  assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf-8"), "## Seatworks\n\nWork through the team tools.\n");
  assert.equal(lstatSync(join(dir, "settings.json")).isSymbolicLink(), false);
  assert.deepEqual(readConfig(join(dir, "settings.json"), {}), {
    autoMemoryEnabled: false,
    permissions: { deny: ["WebSearch", "Agent"] },
  });
  assert.equal(readlinkSync(join(dir, "projects")), join(home, ".claude", "projects"));
  const skill = readlinkSync(join(dir, "skills", "ide-guide"));
  assert.equal(dirname(skill), contentRoot(home), "a skill links to a copy under the state, not into the kit");
  assert.equal(
    readFileSync(join(skill, "SKILL.md"), "utf-8"),
    readFileSync(join(kit.dir, "catalog/mcp/ide/skills/ide-guide/SKILL.md"), "utf-8"),
  );
  const state = readConfig<{ mcpServers?: unknown; userID?: string; projects?: Record<string, unknown> }>(
    join(dir, ".claude.json"),
    {},
  );
  assert.deepEqual(state.mcpServers, {});
  assert.equal(state.userID, "u");
  assert.equal("enableAllProjectMcpServers" in state, false);
  assert.deepEqual(state.projects?.["/x"], { mcpServers: {}, trust: true });
  assert.deepEqual(materialize(kit, team, "lead", home, project, serversFor(kit, team, "lead", context)), []);

  const off = resolveTeam(kit, { mcp: { ide: { enabled: false } } });
  const removed = materialize(kit, off, "lead", home, project, serversFor(kit, off, "lead", context));
  assert.ok(removed.includes("skill ide-guide removed"));
});

test("a seat whose harness reads its servers from a file gets that file and its whole layered settings, in JSON or TOML, and the Seatworks block in its own instructions file", () => {
  const kit = withAgent("toml", {
    "harness.json": JSON.stringify({
      id: "toml",
      label: "Toml CLI",
      baseProvider: "codex",
      configDirEnv: "TOML_HOME",
      profileRoot: "HOME/.toml",
      contextFile: "AGENTS.md",
      skillsDir: "skills",
      settings: { file: "config.toml", source: "settings.toml", roleSource: "settings/ROLE.settings.toml" },
      mcp: { file: "mcp.toml", delivery: "file", key: "mcp_servers", transports: ["stdio", "http"] },
      provider: {},
    }),
    "settings.toml": 'sandbox = "workspace-write"\n',
    "settings/peer.settings.toml": 'approval = "never"\n',
    "settings/scribe.settings.toml": "",
  });
  const home = tempDir("sw3-home-");
  const rows: [string, string, object][] = [
    [
      "omp",
      JSON.stringify({ written: "by the agent", ask: { enabled: true } }),
      { ask: { enabled: false }, bash: { patterns: [{ match: "git push*", approval: "deny" }] } },
    ],
    ["toml", 'written = "by the agent"\n', { sandbox: "workspace-write", approval: "never" }],
  ];
  for (const [id, own, settings] of rows) {
    const team = resolveTeam(kit, { roles: { peer: { harness: id, model: "glm" } }, mcp: { docs: { enabled: true } } });
    assert.deepEqual(team.errors, [], id);
    const { role, harness } = team.roles.peer!;
    const dir = seatDir(kit, role, harness, home, project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, harness.settings.file), own);
    const outside = join(tempDir("sw3-outside-"), "AGENTS.md");
    writeFileSync(outside, "project rules that must not change");
    symlinkSync(outside, join(dir, "AGENTS.md"));

    const servers = serversFor(kit, team, "peer", context);
    assert.ok(materialize(kit, team, "peer", home, project, servers).length > 0, id);
    assert.deepEqual(
      readConfig(join(dir, harness.settings.file), {}),
      settings,
      `${id}: the kit's settings are the whole file`,
    );
    assert.equal(
      readFileSync(join(dir, "AGENTS.md"), "utf-8"),
      "## Seatworks\n\nWork through the team tools.\n",
      `${id}: the block reaches a seat whatever copy it works in, even one made before the block was committed`,
    );
    assert.equal(readFileSync(outside, "utf-8"), "project rules that must not change", id);
    const listed = readConfig<Record<string, Record<string, Server>>>(join(dir, harness.mcp.file), {})[
      harness.mcp.key!
    ];
    assert.deepEqual(Object.keys(listed ?? {}).sort(), ["docs", "ide", "team"], id);
    assert.deepEqual(
      listed?.team?.args,
      [join(kit.dir, "mcp", "team.mjs"), "peer", "peer", "/desk.sock"],
      `${id}: the seat is told which role it is and which tool set it holds, so two roles can share one set`,
    );
    assert.equal(listed?.team?.env, undefined, `${id}: a file every seat of its kind reads holds no seat's key`);
    assert.equal(listed?.docs?.url, "https://docs.example/mcp", id);
    for (const name of ["test-first", "plan-check", "ide-guide"])
      assert.ok(existsSync(join(dir, "skills", name, "SKILL.md")), `${id}: ${name}`);
    assert.equal(existsSync(join(dir, "git")), false, `${id}: an optional link to nothing is not made`);
    assert.deepEqual(
      materialize(kit, team, "peer", home, project, servers),
      [],
      `${id}: a second build changes nothing`,
    );
  }
});

test("every seat's own rules refuse starting any agent the kit ships and any command it refuses, and keep its file tools off the desk's files, so one agent more needs no edit to another's", () => {
  const kit = withAgent("acme", {
    "harness.json": JSON.stringify({
      id: "acme",
      label: "Acme",
      baseProvider: "omp",
      configDirEnv: "ACME_DIR",
      profileRoot: "HOME/.acme",
      skillsDir: "skills",
      settings: { file: "settings.json", source: "settings.json", roleSource: "settings/ROLE.settings.json" },
      mcp: { file: "mcp.json", delivery: "file", key: "mcpServers", transports: ["stdio", "http"] },
      provider: { env: { SEATWORKS_AGENT_BIN: "acme" } },
      refuses: {
        commands: { at: "permissions.deny", as: ["Bash({command})", "Bash({command} *)"] },
        edits: { at: "permissions.deny", as: ["Edit({path})"] },
        reads: { at: "permissions.deny", as: ["Read({path})"] },
      },
    }),
    "settings.json": JSON.stringify({ permissions: { deny: ["Agent"] } }),
    "settings/lead.settings.json": "{}",
    "settings/peer.settings.json": "{}",
  });
  const home = tempDir("sw3-home-");
  const deniedTo = (role: string) => {
    const team = withHarness(resolveTeam(kit), role, kit.harnesses.acme!);
    materialize(kit, team, role, home, project);
    const dir = seatDir(kit, team.roles[role]!.role, kit.harnesses.acme!, home, project);
    return readConfig<{ permissions: { deny: string[] } }>(join(dir, "settings.json"), { permissions: { deny: [] } })
      .permissions.deny;
  };
  const peer = deniedTo("peer");
  const state = "~/.local/share/seatworks-v3";
  for (const rule of [
    "Agent",
    "Bash(acme)",
    "Bash(claude *)",
    "Bash(npx omp *)",
    "Bash(bunx claude)",
    "Bash(gh *)",
    "Bash(paseo)",
    `Edit(${state}/roles.json)`,
    `Edit(${state}/refused.json)`,
    `Edit(${state}/attention.json)`,
    `Edit(${state}/own/**)`,
    `Edit(${state}/sensor/**)`,
    `Edit(${state}/keys.json)`,
    `Edit(${state}/projects/*/ledger.json)`,
    `Edit(${state}/projects/*/gates/**)`,
    `Edit(${state}/projects/*/events.*.log*)`,
    `Edit(${state}/projects/*/plans/**)`,
    `Read(${state}/keys.json*)`,
    `Read(${state}/projects/*/settings.json*)`,
  ])
    assert.ok(peer.includes(rule), `the Peer on Acme: ${rule}`);
  assert.equal(
    peer.some((rule) => rule.includes("worktrees")),
    false,
    "the copies seats work in are theirs to change",
  );
  assert.deepEqual(
    deniedTo("lead").filter((rule) => rule.includes("/plans")),
    [],
    "a role's own pages are its to write",
  );
});

test("an unreadable MCP file is written again when the plugin owns it, and left alone when the harness does", (t) => {
  const said = reported(t);
  const kit = makeKit();
  const home = tempDir("sw3-home-");
  const team = resolveTeam(kit);
  const peer = team.roles.peer!;
  assert.equal(peer.harness.mcp.delivery, "file", "the Peer's harness takes its servers from this file alone");
  const servers = { team: { type: "stdio", command: ["node", "team.mjs"] } };
  materialize(kit, team, "peer", home, project, servers);
  const owned = join(seatDir(kit, peer.role, peer.harness, home, project), peer.harness.mcp.file);
  writeFileSync(owned, '{ "mcpServers": {');
  materialize(kit, team, "peer", home, project, servers);
  assert.ok(
    readConfig<{ mcpServers?: { team?: unknown } }>(owned, {}).mcpServers?.team,
    "written again, or the Peer would boot with no done or ask",
  );
  assert.match(
    said(),
    /mcp\.json is there but could not be read: .*, and the plugin owns that file, so it was written again/,
  );

  const lead = team.roles.lead!;
  materialize(kit, team, "lead", home, project);
  const kept = join(seatDir(kit, lead.role, lead.harness, home, project), lead.harness.mcp.file);
  const held = `{ "userID": "u-1", "oauthAccount": { "emailAddress": "owner@example.test" }, "projects": { "/work": {} },`;
  writeFileSync(kept, held);
  const changes = materialize(kit, team, "lead", home, project);
  assert.equal(
    readFileSync(kept, "utf-8"),
    held,
    "left exactly as it was: the seed would wipe the account and history",
  );
  assert.equal(
    changes.some((change) => change.includes(lead.harness.mcp.file)),
    false,
    "and not reported as a routine update",
  );
  assert.match(
    said(),
    /\.claude\.json is there but could not be read: .*, so its MCP servers were left alone/,
    "but as trouble",
  );
});

test("a real directory where a skill link should go is left alone, not turned into a seat that cannot start", (t) => {
  const said = reported(t);
  const kit = makeKit();
  const home = tempDir("sw3-home-");
  const team = resolveTeam(kit);
  const dir = seatDir(kit, team.roles.peer!.role, team.roles.peer!.harness, home, project);
  mkdirSync(join(dir, "skills", "test-first"), { recursive: true });
  writeFileSync(join(dir, "skills", "test-first", "NOTES.md"), "something the harness made for itself\n");

  const changes = materialize(kit, team, "peer", home, project);
  assert.ok(changes.length > 0, "the rest of the seat is still built, where a throw refused its launch for ever");
  assert.equal(
    readFileSync(join(dir, "skills", "test-first", "NOTES.md"), "utf-8").trim(),
    "something the harness made for itself",
  );
  assert.match(
    said(),
    /skill test-first for the peer: .* exists and is not a link, so it was left alone/,
    "and the owner is told why",
  );
});

const cx = (catalog: string[]) =>
  JSON.stringify({
    id: "cx",
    label: "Cx",
    baseProvider: "codex",
    configDirEnv: "CODEX_HOME",
    profileRoot: "HOME/.cx",
    contextFile: "AGENTS.md",
    skillsDir: "skills",
    settings: { file: "config.toml", source: "settings.toml", roleSource: "settings/ROLE.settings.toml" },
    stateWrites: { path: "sandbox_workspace_write.writable_roots", delivery: "file" },
    files: { "rules/seat.rules": ["rules/all.rules", "rules/ROLE.rules"] },
    modelCatalog: {
      command: catalog,
      list: "models",
      clear: ["multi_agent_version"],
      file: "catalog.json",
      setting: "model_catalog_json",
    },
    mcp: { file: "config.toml", delivery: "launch", transports: ["stdio", "http"] },
    provider: {},
  });

test("an agent configured in its own file format gets its catalog trimmed, its state grant and its role's files, and one whose catalog cannot be read seats no one", () => {
  const offering =
    "process.stdout.write(JSON.stringify({models:[{slug:'a',multi_agent_version:'v2'},{slug:'b',multi_agent_version:'v1'}]}))";
  const kit = withAgent("cx", {
    "harness.json": cx(["node", "-e", offering]),
    "settings.toml": 'approval_policy = "never"\n[sandbox_workspace_write]\nnetwork_access = true\n',
    "settings/lead.settings.toml": 'sandbox_mode = "workspace-write"\n',
    "settings/peer.settings.toml": "",
    "rules/all.rules": 'prefix_rule(pattern = ["git", "push"], decision = "forbidden")\n',
    "rules/lead.rules": 'prefix_rule(pattern = ["git", "commit"], decision = "forbidden")\n',
  });
  put(kit, "content/prompts/LEAD.md", "# Lead\n\nWrite a plan in {{state}}/plans/ first.\n");
  const team = withHarness(resolveTeam(kit), "lead", kit.harnesses.cx!);
  const home = tempDir("sw3-cx-home-");
  materialize(kit, team, "lead", home, project, serversFor(kit, team, "lead", context));
  const dir = seatDir(kit, team.roles.lead!.role, kit.harnesses.cx!, home, project);
  type Seat = {
    approval_policy?: string;
    sandbox_mode?: string;
    sandbox_workspace_write?: { network_access?: boolean; writable_roots?: string[] };
    model_catalog_json?: string;
  };
  const config = readConfig<Seat>(join(dir, "config.toml"), {});
  assert.equal(config.approval_policy, "never");
  assert.equal(config.sandbox_mode, "workspace-write");
  assert.equal(
    config.sandbox_workspace_write?.network_access,
    true,
    "the grant is added to the table, not put in its place",
  );
  assert.deepEqual(
    config.sandbox_workspace_write?.writable_roots,
    [join(project.state, "plans")],
    "named, not computed: comparing against stateWrites itself passed for any answer, even none",
  );
  assert.equal(config.model_catalog_json, join(dir, "catalog.json"));
  assert.deepEqual(readConfig(config.model_catalog_json, {}), {
    models: [
      { slug: "a", multi_agent_version: null },
      { slug: "b", multi_agent_version: null },
    ],
  });
  assert.equal(
    readFileSync(join(dir, "rules", "seat.rules"), "utf-8"),
    'prefix_rule(pattern = ["git", "push"], decision = "forbidden")\n\nprefix_rule(pattern = ["git", "commit"], decision = "forbidden")\n',
  );
  const pairs = seatPairs(kit).map((pair) => `${pair.role.role}-${pair.harness.id}`);
  assert.ok(pairs.includes("lead-cx"));
  assert.ok(
    !pairs.includes("peer-cx"),
    "a role missing its rules file cannot sit there, rather than sitting without its rules",
  );

  const blind = withAgent("cx", {
    "harness.json": cx(["node", "-e", "process.exit(3)"]),
    "settings.toml": "",
    "settings/lead.settings.toml": "",
    "rules/all.rules": "",
    "rules/lead.rules": "",
  });
  const refused = withHarness(resolveTeam(blind), "lead", blind.harnesses.cx!);
  const elsewhere = tempDir("sw3-cx-home-");
  assert.throws(() => materialize(blind, refused, "lead", elsewhere, project, {}), {
    message: /^Cx's model list could not be read from `node -e process\.exit\(3\)`/,
  });
  const nothing = seatDir(blind, refused.roles.lead!.role, blind.harnesses.cx!, elsewhere, project);
  assert.equal(existsSync(join(nothing, "config.toml")), false, "and nothing of the seat is written");

  const garbled = withAgent("cx", {
    "harness.json": cx(["node", "-e", offering]),
    "settings.toml": "",
    "settings/lead.settings.toml": 'sandbox_mode = "workspace-write\n',
    "rules/all.rules": "",
    "rules/lead.rules": "",
  });
  const unread = withHarness(resolveTeam(garbled), "lead", garbled.harnesses.cx!);
  assert.throws(
    () => materialize(garbled, unread, "lead", tempDir("sw3-cx-home-"), project, {}),
    { message: /lead\.settings\.toml could not be read/ },
    "a role's settings that cannot be read seat no one, rather than a seat without its sandbox",
  );
});

test("an owner's own agent config a seat takes keys from, when it cannot be read, is said in the daemon's log, and the seat takes none of it", (t) => {
  const offering = "process.stdout.write(JSON.stringify({models:[{slug:'a'}]}))";
  const agent = JSON.parse(cx(["node", "-e", offering])) as { settings: Record<string, unknown> };
  agent.settings.inherits = { from: "HOME/.cx/config.toml", keys: ["model_provider"] };
  const kit = withAgent("cx", {
    "harness.json": JSON.stringify(agent),
    "settings.toml": "",
    "settings/lead.settings.toml": "",
    "rules/all.rules": "",
    "rules/lead.rules": "",
  });
  const team = withHarness(resolveTeam(kit), "lead", kit.harnesses.cx!);
  const home = tempDir("sw3-cx-home-");
  mkdirSync(join(home, ".cx"), { recursive: true });
  writeFileSync(join(home, ".cx", "config.toml"), 'model_provider = "mine\n');
  const said = reported(t);
  materialize(kit, team, "lead", home, project, {});
  const dir = seatDir(kit, team.roles.lead!.role, kit.harnesses.cx!, home, project);
  assert.equal(readConfig<{ model_provider?: string }>(join(dir, "config.toml"), {}).model_provider, undefined);
  assert.match(
    said(),
    /config\.toml is there but could not be read: it is not TOML[^\n]*, so Cx seats take none of its model_provider/,
  );
});

test("a seat that commits may write the repository's git directory, where a working copy keeps its index, and one that does not may not", () => {
  const kit = withAgent("cx", {
    "harness.json": cx(["node", "-e", "process.stdout.write(JSON.stringify({models:[{slug:'a'}]}))"]),
    "settings.toml": "",
    "settings/lead.settings.toml": "",
    "settings/peer.settings.toml": "",
    "rules/all.rules": "",
    "rules/lead.rules": "",
    "rules/peer.rules": "",
  });
  kit.roles.find((role) => role.role === "peer")!.can = ["work", "write"];
  const repo = tempDir("sw3-cx-repo-");
  execFileSync("git", ["init", "-q", repo]);
  const here = { ...project, root: repo };
  const home = tempDir("sw3-cx-home-");
  const roots = (role: "lead" | "peer") => {
    const team = withHarness(resolveTeam(kit), role, kit.harnesses.cx!);
    materialize(kit, team, role, home, here, {});
    const dir = seatDir(kit, team.roles[role]!.role, kit.harnesses.cx!, home, here);
    return readConfig<{ sandbox_workspace_write?: { writable_roots?: string[] } }>(join(dir, "config.toml"), {})
      .sandbox_workspace_write?.writable_roots;
  };
  assert.deepEqual(roots("peer"), [join(realpathSync(repo), ".git")]);
  assert.deepEqual(roots("lead"), [join(project.state, "plans")]);
});

test("a changed skill reaches the seat as a new copy, the one read before stays as it was, and a copy nobody touches for two weeks goes", () => {
  const kit = makeKit();
  const home = tempDir("sw3-home-");
  const team = resolveTeam(kit);
  const link = join(
    seatDir(kit, team.roles.peer!.role, team.roles.peer!.harness, home, project),
    "skills",
    "test-first",
  );
  materialize(kit, team, "peer", home, project);
  const before = readlinkSync(link);
  put(kit, "content/skills/peer/test-first/SKILL.md", "---\nname: test-first\ndescription: tests, now stricter\n---\n");
  materialize(kit, team, "peer", home, project);
  const after = readlinkSync(link);
  assert.notEqual(after, before);
  assert.match(
    readFileSync(join(before, "SKILL.md"), "utf-8"),
    /description: tests\n/,
    "a seat mid-turn on the old copy still reads it whole",
  );
  const old = new Date(Date.now() - 15 * 86_400_000);
  utimesSync(before, old, old);
  sweepSnapshots(home);
  assert.equal(existsSync(before), false);
  assert.equal(existsSync(after), true, "the copy a seat started on lately stays");
});
