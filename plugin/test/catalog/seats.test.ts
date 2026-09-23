import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import { loadKit } from "../../server/catalog/kit.ts";
import { applyModels } from "../../server/catalog/models.ts";
import { composeSettings, materialize, seatDir, sweepSnapshots } from "../../server/catalog/seats.ts";
import { contentRoot } from "../../server/core/paths.ts";
import { seatPairs } from "../../server/catalog/providers.ts";
import { resolveTeam, serversFor, withHarness } from "../../server/catalog/team.ts";
import { makeKit } from "../kit.ts";
import { tempDir } from "../tempdir.ts";

const project = { slug: "shop-abc123", state: "/state/shop" };
const context = { node: "/bin/node", spool: "/spool" };

test("a Claude seat per project writes shared plus role settings, links skills, clears MCP files and writes the rules to CLAUDE.md", () => {
  const kit = makeKit();
  const team = resolveTeam(kit);
  const home = tempDir("sw2-home-");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const lead = team.roles.lead!;
  const dir = seatDir(kit, lead.role, lead.harness, home, project);
  assert.equal(basename(dir), "sw2-lead-claude-shop-abc123");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ userID: "u", mcpServers: { old: {} }, enableAllProjectMcpServers: true, projects: { "/x": { mcpServers: { rogue: {} }, trust: true } } }));
  symlinkSync(join(kit.dir, "harness/claude/settings/lead.settings.json"), join(dir, "settings.json"));

  const changes = materialize(kit, team, "lead", home, project, serversFor(kit, team, "lead", context));
  assert.ok(changes.length > 0);
  assert.equal(lstatSync(join(dir, "settings.json")).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")), { autoMemoryEnabled: false, permissions: { deny: ["WebSearch", "Agent"] } });
  assert.equal(readlinkSync(join(dir, "projects")), join(home, ".claude", "projects"));
  const skill = readlinkSync(join(dir, "skills", "ide-guide"));
  assert.equal(dirname(skill), contentRoot(home), "a skill links to a copy under the state, not into the kit");
  assert.equal(readFileSync(join(skill, "SKILL.md"), "utf-8"), readFileSync(join(kit.dir, "catalog/mcp/ide/skills/ide-guide/SKILL.md"), "utf-8"));
  const state = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf-8"));
  assert.deepEqual(state.mcpServers, {});
  assert.equal(state.userID, "u");
  assert.equal("enableAllProjectMcpServers" in state, false);
  assert.deepEqual(state.projects["/x"], { mcpServers: {}, trust: true });
  const rules = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
  assert.match(rules, /Prefer the IDE for navigation\./);
  assert.match(rules, /Your IDE tools: `ide_find_references`\./);
  assert.deepEqual(materialize(kit, team, "lead", home, project, serversFor(kit, team, "lead", context)), []);

  const off = resolveTeam(kit, { mcp: { ide: { enabled: false } } });
  const removed = materialize(kit, off, "lead", home, project, serversFor(kit, off, "lead", context));
  assert.ok(removed.includes("CLAUDE.md removed"));
  assert.ok(removed.includes("skill ide-guide removed"));
  assert.equal(existsSync(join(dir, "CLAUDE.md")), false);
});

test("a Devin seat merges settings, writes its MCP file and a real prompt with the rules appended", () => {
  const kit = makeKit();
  const team = resolveTeam(kit, { mcp: { docs: { enabled: true } } });
  const home = tempDir("sw2-home-");
  const peer = team.roles.peer!;
  const dir = seatDir(kit, peer.role, peer.harness, home, project);
  mkdirSync(join(dir, "devin"), { recursive: true });
  writeFileSync(join(dir, "devin", "config.json"), JSON.stringify({ version: 3, permissions: { allow: ["Exec(rm)"] } }));
  const outside = join(tempDir("sw2-outside-"), "PEER.md");
  writeFileSync(outside, "project prompt that must not change");
  symlinkSync(outside, join(dir, "devin", "AGENTS.md"));

  materialize(kit, team, "peer", home, project, serversFor(kit, team, "peer", context));
  const config = JSON.parse(readFileSync(join(dir, "devin", "config.json"), "utf-8"));
  assert.equal(config.version, 3);
  assert.equal(config.notify, "never");
  assert.deepEqual(config.permissions, { deny: ["Exec(git push)"] });
  const prompt = join(dir, "devin", "AGENTS.md");
  assert.equal(lstatSync(prompt).isSymbolicLink(), false);
  const text = readFileSync(prompt, "utf-8");
  assert.match(text, /^# Peer/);
  assert.match(text, /# Working rules/);
  assert.match(text, /Look library APIs up in the docs\./);
  assert.equal(readFileSync(outside, "utf-8"), "project prompt that must not change");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "devin", "mcp_config.json"), "utf-8")).mcpServers).sort(), ["docs", "ide", "team"]);
  for (const skill of ["test-first", "plan-check", "ide-guide"]) assert.ok(existsSync(join(dir, "devin", "skills", skill, "SKILL.md")), skill);
  assert.equal(existsSync(join(dir, "git")), false);
});

test("a prompt carrying a word its role must not see is refused", () => {
  const kit = makeKit();
  const home = tempDir("sw2-home-");
  writeFileSync(join(kit.dir, "content/prompts/PEER.md"), "# Peer\n\nAsk the seat above you.\n");
  assert.throws(() => materialize(kit, resolveTeam(kit), "peer", home, project), /must not see: seat/);
});

test("a seat that cannot be built writes nothing, rather than a config with no instructions beside it", () => {
  const kit = makeKit();
  const home = tempDir("sw2-home-");

  // Owner rules are folded into every seat's instructions; a refusal there must come before anything is written.
  const owned = resolveTeam(kit, { rules: "Leave the Paseo config alone." });
  assert.deepEqual(owned.errors, [], "nothing the schema or the team resolution objects to");
  assert.throws(() => materialize(kit, owned, "peer", home, project), /must not see: paseo/);

  const dir = seatDir(kit, owned.roles.peer!.role, owned.roles.peer!.harness, home, project);
  const left = existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((entry) => String(entry).includes(".")) : [];
  assert.deepEqual(left, [], "nothing at all, because half a seat is worse than none");

  const fine = resolveTeam(kit, { rules: "Leave the daemon config alone." });
  assert.equal(materialize(kit, fine, "peer", home, project).length > 0, true);
  assert.match(readFileSync(join(dir, "devin/AGENTS.md"), "utf-8"), /Leave the daemon config alone/);
});

test("a skill carrying a word its role must not see, or a placeholder nothing fills in, is refused", () => {
  const kit = makeKit();
  const home = tempDir("sw2-home-");
  const skill = join(kit.dir, "content/skills/peer/test-first/SKILL.md");
  writeFileSync(skill, "---\nname: test-first\ndescription: tests\n---\n\nAsk the seat above you.\n");
  assert.throws(() => materialize(kit, resolveTeam(kit), "peer", home, project), /skill test-first shows the peer words it must not see in SKILL.md: seat/);
  writeFileSync(skill, "---\nname: test-first\ndescription: tests\n---\n\nRead {{guides}}/BRIEF.md.\n");
  assert.throws(() => materialize(kit, resolveTeam(kit), "peer", home, project), /skill test-first holds \{\{guides\}\}/);
});

test("a real directory where a skill link should go is left alone, not turned into a seat that cannot start", () => {
  const kit = makeKit();
  const home = tempDir("sw2-home-");
  const team = resolveTeam(kit);
  const dir = seatDir(kit, kit.roles.find((role) => role.role === "peer")!, kit.harnesses.devin!, home, project);
  mkdirSync(join(dir, "devin", "skills", "test-first"), { recursive: true });
  writeFileSync(join(dir, "devin", "skills", "test-first", "NOTES.md"), "something the harness made for itself\n");

  // Thrown from the skills loop, this became a permanent launch refusal, since nothing removes that directory.
  const changes = materialize(kit, team, "peer", home, project);
  assert.ok(changes.length > 0, "the rest of the seat is still built");
  assert.equal(readFileSync(join(dir, "devin", "skills", "test-first", "NOTES.md"), "utf-8").trim(), "something the harness made for itself");
});

test("composeSettings deletes an owned key the kit no longer sets", () => {
  assert.deepEqual(composeSettings({ a: 1, permissions: { deny: ["x"] } }, { b: 2 }, ["permissions"]), { a: 1, b: 2 });
});

test("a harness with TOML config files gets its layered settings and its MCP servers", () => {
  const base = makeKit();
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(base.dir, path)), { recursive: true });
    writeFileSync(join(base.dir, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  put("harness/toml/harness.json", {
    id: "toml",
    label: "Toml CLI",
    baseProvider: "acp",
    configDirEnv: "TOML_HOME",
    profileRoot: "HOME/.toml",
    promptFile: "AGENTS.md",
    skillsDir: "skills",
    systemPrompt: "file",
    settings: { file: "config.toml", source: "settings.toml", roleSource: "settings/ROLE.settings.toml", ownedPaths: ["sandbox", "approval"] },
    mcp: { file: "config.toml", delivery: "file", key: "mcp_servers", transports: ["stdio", "http"] },
    provider: {},
  });
  put("harness/toml/settings.toml", 'sandbox = "workspace-write"\n');
  put("harness/toml/settings/peer.settings.toml", 'approval = "never"\n');
  // The Scribe follows the Peer, so it goes wherever the Peer goes.
  put("harness/toml/settings/scribe.settings.toml", "");
  const kit = loadKit(base.dir);
  applyModels(kit, { toml: { at: "", error: null, models: [{ id: "m", label: "M" }] } });
  const team = resolveTeam(kit, { roles: { peer: { harness: "toml" } }, mcp: { docs: { enabled: true } } });
  assert.deepEqual(team.errors, []);
  const home = tempDir("sw2-home-");
  const servers = serversFor(kit, team, "peer", context);
  assert.ok(materialize(kit, team, "peer", home, project, servers).length > 0);
  const dir = seatDir(kit, team.roles.peer!.role, team.roles.peer!.harness, home, project);
  const config = parse(readFileSync(join(dir, "config.toml"), "utf-8")) as Record<string, any>;
  assert.equal(config.sandbox, "workspace-write");
  assert.equal(config.approval, "never");
  // The seat is told which role it is and which tool set it holds, so two roles can share one set.
  assert.equal(config.mcp_servers.team.command, "/bin/node");
  assert.deepEqual(config.mcp_servers.team.args, [join(kit.dir, "mcp", "team.mjs"), "peer", "peer", "/spool"]);
  assert.equal(config.mcp_servers.docs.url, "https://docs.example/mcp");
  assert.deepEqual(materialize(kit, team, "peer", home, project, servers), []);
});

test("an unreadable MCP file the plugin owns is written again, because it carries the seat's only tools", () => {
  const kit = makeKit();
  const home = tempDir("sw2-home-");
  const team = resolveTeam(kit);
  // The Peer's harness takes its servers from this file alone; left unreadable, the Peer boots with no `done` or `ask`.
  const peer = team.roles.peer!;
  assert.equal(peer.harness.mcp.delivery, "file", "the premise of this test");
  const dir = seatDir(kit, peer.role, peer.harness, home, project);
  const servers = { team: { type: "stdio", command: ["node", "team.mjs"] } };
  materialize(kit, team, "peer", home, project, servers);
  const file = join(dir, peer.harness.mcp.file);
  assert.ok(JSON.parse(readFileSync(file, "utf-8")).mcpServers.team, "built once, with the server that carries done and ask");

  writeFileSync(file, '{ "mcpServers": {');
  materialize(kit, team, "peer", home, project, servers);
  assert.ok(JSON.parse(readFileSync(file, "utf-8")).mcpServers.team, "and written again, because this document is the plugin's own");
});

test("an MCP file the harness owns and the plugin cannot read is left alone, not replaced by the seed", () => {
  const kit = makeKit();
  const home = tempDir("sw2-home-");
  const team = resolveTeam(kit);
  materialize(kit, team, "lead", home, project);
  const dir = seatDir(kit, team.roles.lead!.role, team.roles.lead!.harness, home, project);
  const file = join(dir, team.roles.lead!.harness.mcp.file);

  // A crash mid-write or an unparsed newer version; read as absent, the seed would wipe the account and history.
  const held = `{ "userID": "u-1", "oauthAccount": { "emailAddress": "owner@example.test" }, "projects": { "/work": {} },`;
  writeFileSync(file, held);
  const changes = materialize(kit, team, "lead", home, project);
  assert.equal(readFileSync(file, "utf-8"), held, "left exactly as it was");
  assert.equal(
    changes.some((change) => change.includes(team.roles.lead!.harness.mcp.file)),
    false,
    "and not reported as a routine update",
  );
});

function withAgent(files: Record<string, string>): ReturnType<typeof loadKit> {
  const kit = makeKit();
  for (const [path, text] of Object.entries(files)) {
    const file = join(kit.dir, "harness", "cx", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return loadKit(kit.dir);
}

const agent = (catalog: string[]) =>
  JSON.stringify({
    id: "cx",
    label: "Cx",
    baseProvider: "codex",
    configDirEnv: "CODEX_HOME",
    profileRoot: "HOME/.cx",
    contextFile: "AGENTS.md",
    skillsDir: "skills",
    systemPrompt: "config",
    settings: { file: "config.toml", source: "settings.toml", roleSource: "settings/ROLE.settings.toml" },
    stateWrites: { path: "sandbox_workspace_write.writable_roots", delivery: "file" },
    files: { "rules/seat.rules": ["rules/all.rules", "rules/ROLE.rules"] },
    modelCatalog: { command: catalog, list: "models", clear: ["multi_agent_version"], file: "catalog.json", setting: "model_catalog_json" },
    mcp: { file: "config.toml", delivery: "launch", transports: ["stdio", "http"] },
    provider: {},
  });

const offering = ["node", "-e", "process.stdout.write(JSON.stringify({models:[{slug:'a',multi_agent_version:'v2'},{slug:'b',multi_agent_version:'v1'}]}))"];

test("an agent configured in its own file format gets its catalog trimmed, its state grant and its role's files, all in the seat", () => {
  const kit = withAgent({
    "harness.json": agent(offering),
    "settings.toml": 'approval_policy = "never"\n[sandbox_workspace_write]\nnetwork_access = true\n',
    "settings/lead.settings.toml": 'sandbox_mode = "workspace-write"\n',
    "settings/peer.settings.toml": "",
    "rules/all.rules": 'prefix_rule(pattern = ["git", "push"], decision = "forbidden")\n',
    "rules/lead.rules": 'prefix_rule(pattern = ["git", "commit"], decision = "forbidden")\n',
  });
  // The grant is what the role's own content names under the project's state.
  writeFileSync(join(kit.dir, "content", "prompts", "LEAD.md"), "# Lead\n\nWrite a plan in {{state}}/plans/ first.\n");
  const base = resolveTeam(kit);
  const team = withHarness(base, "lead", kit.harnesses.cx!);
  const home = tempDir("sw2-cx-home-");
  materialize(kit, team, "lead", home, project, serversFor(kit, team, "lead", context));
  const dir = seatDir(kit, team.roles.lead!.role, kit.harnesses.cx!, home, project);
  const config = parse(readFileSync(join(dir, "config.toml"), "utf-8")) as Record<string, any>;
  assert.equal(config.approval_policy, "never");
  assert.equal(config.sandbox_mode, "workspace-write");
  assert.equal(config.sandbox_workspace_write.network_access, true, "the grant is added to the table, not put in its place");
  // Named, not computed: comparing against `stateWrites` itself passed for any answer, even none.
  assert.deepEqual(config.sandbox_workspace_write.writable_roots, [join(project.state, "plans")]);
  assert.equal(config.model_catalog_json, join(dir, "catalog.json"));
  const catalog = JSON.parse(readFileSync(config.model_catalog_json, "utf-8"));
  assert.deepEqual(catalog.models, [{ slug: "a", multi_agent_version: null }, { slug: "b", multi_agent_version: null }]);
  assert.equal(readFileSync(join(dir, "rules", "seat.rules"), "utf-8"), 'prefix_rule(pattern = ["git", "push"], decision = "forbidden")\n\nprefix_rule(pattern = ["git", "commit"], decision = "forbidden")\n');
  // The Peer has its settings but no rules file: it cannot sit on this agent, rather than sitting on it without its rules.
  assert.equal(seatPairs(kit).some((pair) => pair.role.role === "lead" && pair.harness.id === "cx"), true);
  assert.equal(seatPairs(kit).some((pair) => pair.role.role === "peer" && pair.harness.id === "cx"), false);
});

test("a catalog that cannot be read refuses the seat instead of seating it with native agents on offer", () => {
  const kit = withAgent({
    "harness.json": agent(["node", "-e", "process.exit(3)"]),
    "settings.toml": "",
    "settings/lead.settings.toml": "",
    "rules/all.rules": "",
    "rules/lead.rules": "",
  });
  const team = withHarness(resolveTeam(kit), "lead", kit.harnesses.cx!);
  const home = tempDir("sw2-cx-home-");
  assert.throws(() => materialize(kit, team, "lead", home, project, {}), /Cx's model list could not be read from `node -e process.exit\(3\)`/);
  assert.equal(existsSync(join(seatDir(kit, team.roles.lead!.role, kit.harnesses.cx!, home, project), "config.toml")), false, "and nothing of the seat is written");
});

test("a changed skill reaches the seat as a new copy, the one read before stays as it was, and a copy nobody touches for two weeks goes", () => {
  const kit = makeKit();
  const home = tempDir("sw2-home-");
  const team = resolveTeam(kit);
  const link = join(seatDir(kit, team.roles.peer!.role, team.roles.peer!.harness, home, project), "devin", "skills", "test-first");
  materialize(kit, team, "peer", home, project);
  const before = readlinkSync(link);
  writeFileSync(join(kit.dir, "content/skills/peer/test-first/SKILL.md"), "---\nname: test-first\ndescription: tests, now stricter\n---\n");
  materialize(kit, team, "peer", home, project);
  const after = readlinkSync(link);
  assert.notEqual(after, before);
  assert.match(readFileSync(join(before, "SKILL.md"), "utf-8"), /description: tests\n/, "a seat mid-turn on the old copy still reads it whole");
  const old = new Date(Date.now() - 15 * 86_400_000);
  utimesSync(before, old, old);
  sweepSnapshots(home);
  assert.equal(existsSync(before), false);
  assert.equal(existsSync(after), true, "the copy a seat started on lately stays");
});

test("a seat that commits may write the repository's git directory, where a lane's working copy keeps its index", async () => {
  const { execFileSync } = await import("node:child_process");
  const kit = withAgent({
    "harness.json": agent(offering),
    "settings.toml": '[sandbox_workspace_write]\nnetwork_access = true\n',
    "settings/lead.settings.toml": "",
    "settings/peer.settings.toml": "",
    "rules/all.rules": "",
    "rules/lead.rules": "",
    "rules/peer.rules": "",
  });
  const root = tempDir("sw2-repo-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const here = { ...project, root };
  const home = tempDir("sw2-cx-home-");
  const base = resolveTeam(kit);
  const roots = (role: string) => {
    const team = withHarness(base, role, kit.harnesses.cx!);
    materialize(kit, team, role, home, here, serversFor(kit, team, role, context));
    const config = parse(readFileSync(join(seatDir(kit, team.roles[role]!.role, kit.harnesses.cx!, home, here), "config.toml"), "utf-8")) as Record<string, any>;
    return (config.sandbox_workspace_write.writable_roots ?? []) as string[];
  };
  const git = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  assert.ok(roots("peer").includes(git), `the Peer commits its task: ${roots("peer")} vs ${git}`);
  assert.equal(roots("lead").includes(git), false, "the Lead does not commit");
});
