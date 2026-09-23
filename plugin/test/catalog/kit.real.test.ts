import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderPrompt } from "../../server/catalog/content.ts";
import { PASEO_TOOLS, loadKit, providerId, toolsOf } from "../../server/catalog/kit.ts";
import { type AgentConfig, applyRole, stateWrites } from "../../server/catalog/launch.ts";
import { desiredProvider, seatPairs } from "../../server/catalog/providers.ts";
import { materialize, placeGuides, seatDir, seedRecords } from "../../server/catalog/seats.ts";
import { git } from "../../server/core/git.ts";
import { guidesDir } from "../../server/core/paths.ts";
import { resolveTeam, serversFor, withHarness } from "../../server/catalog/team.ts";
import { readConfig } from "../../server/core/config-file.ts";
import { realProbes } from "../../server/runtime/doctor.ts";
import { tempDir } from "../tempdir.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the shipped kit resolves to a complete team, and every role's seat builds with no hidden word in it", () => {
  const kit = loadKit(pluginRoot);
  const off = resolveTeam(kit);
  assert.deepEqual(off.errors, []);
  assert.deepEqual(Object.values(off.mcp).filter((state) => state.enabled), [], "the kit ships no server switched on");
  const team = resolveTeam(kit, { mcp: Object.fromEntries(Object.keys(kit.mcp).map((id) => [id, { enabled: true }])) });
  assert.deepEqual(team.errors, []);
  assert.deepEqual(kit.roles.map((role) => role.role).sort(), ["lead", "peer", "reviewer", "supervisor", "watcher"]);
  assert.deepEqual(Object.keys(kit.mcp).sort(), ["code-search", "context7", "intellij-index"]);
  const every = kit.roles.flatMap((role) => ["claude", "codex", "devin", "pi"].map((harness) => `${role.role}-${harness}`)).sort();
  assert.deepEqual(seatPairs(kit).map((pair) => `${pair.role.role}-${pair.harness.id}`).sort(), every, "every role can sit on every agent the kit ships");
  const home = tempDir("sw2-real-home-");
  const project = { slug: "demo-000000", state: "/state/demo" };
  for (const [name, seat] of Object.entries(team.roles)) {
    const { role, harness } = seat;
    const where = project;
    materialize(kit, team, name, home, where, serversFor(kit, team, name, { node: "/bin/node", spool: "/spool" }));
    const dir = seatDir(kit, role, harness, home, where);
    assert.ok(existsSync(join(dir, harness.skillsDir)), `${name} skills dir`);
    let context: string;
    if (harness.systemPrompt === "file" && harness.promptFile) {
      const file = join(dir, harness.promptFile);
      assert.equal(lstatSync(file).isSymbolicLink(), false, `${name} prompt is a real file`);
      context = readFileSync(file, "utf-8");
    } else {
      assert.doesNotMatch(renderPrompt(kit, role, { guides: "/guides", state: "/state" }), /\{\{/, `${name} prompt has no placeholder left`);
      context = readFileSync(join(dir, harness.contextFile!), "utf-8");
    }
    assert.doesNotMatch(context, /\{\{/, `${name} seat has no placeholder left`);
    if (seat.mcp.length === 0) {
      assert.doesNotMatch(context, /intellij-index MCP tools/, `${name} takes no server, so it carries no server rule`);
      assert.equal(existsSync(join(dir, harness.skillsDir, "ide-index-mcp", "SKILL.md")), false, `${name} takes no server, so it has no IDE skill`);
      continue;
    }
    assert.match(context, /intellij-index MCP tools/, `${name} seat carries the IntelliJ rule`);
    assert.match(context, /context7/, `${name} seat carries the docs rule`);
    assert.ok(existsSync(join(dir, harness.skillsDir, "ide-index-mcp", "SKILL.md")), `${name} has the IDE skill`);
  }
});

test("every role builds on every agent the kit ships, each in that agent's own terms", (t) => {
  const kit = loadKit(pluginRoot);
  const base = resolveTeam(kit, { mcp: Object.fromEntries(Object.keys(kit.mcp).map((id) => [id, { enabled: true }])) });
  const home = tempDir("sw2-every-home-");
  const project = { slug: "demo-000000", state: "/state/demo" };
  for (const { role, harness } of seatPairs(kit)) {
    if (harness.modelCatalog && !realProbes.has(harness.modelCatalog.command[0]!)) {
      t.diagnostic(`${harness.id} is not installed here, so its ${role.role} seat was not built`);
      continue;
    }
    const team = withHarness(base, role.role, harness);
    materialize(kit, team, role.role, home, project, serversFor(kit, team, role.role, { node: "/bin/node", spool: "/spool" }));
    const dir = seatDir(kit, role, harness, home, project);
    const settings = readConfig<Record<string, any>>(join(dir, harness.settings.file), {});
    const where = `${role.role} on ${harness.id}`;
    if (harness.id === "codex") {
      assert.deepEqual(settings.features, { multi_agent: false, multi_agent_v2: false }, `${where}: Paseo is the only control plane`);
      assert.equal(settings.approval_policy, "never", `${where}: nobody is there to approve`);
      assert.equal(settings.skills.bundled.enabled, false, `${where}: only the role's skills, as on every other agent`);
      assert.equal(settings.sandbox_mode, ["reviewer", "watcher"].includes(role.role) ? "read-only" : "workspace-write", where);
      const catalog = JSON.parse(readFileSync(settings.model_catalog_json, "utf-8"));
      assert.ok(catalog.models.length > 0 && catalog.models.every((model: Record<string, unknown>) => model.multi_agent_version === null), `${where}: no model offers native agents`);
      assert.ok(settings.sandbox_workspace_write.writable_roots.every((path: string) => path.startsWith("/state/demo/")), `${where}: writes into the state only where its content says`);
      const rules = readFileSync(join(dir, "rules", "seatworks.rules"), "utf-8");
      assert.match(rules, /"git", "push"/, `${where}: carries the rules every seat has`);
      assert.equal(/"git", "commit"/.test(rules), ["supervisor", "lead"].includes(role.role), `${where}: commits only where the role commits`);
    }
    if (harness.id === "pi") {
      assert.deepEqual(settings.packages, ["npm:pi-mcp-adapter"], `${where}: the desk's tools reach Pi only through the adapter`);
      assert.equal(settings.defaultProjectTrust, "never", `${where}: the repository's own .pi does not load in a seat`);
      const tools = { reviewer: ["read", "bash", "grep", "find", "ls"], watcher: [] }[role.role as "reviewer"];
      assert.deepEqual(settings.defaultTools, tools, where);
      // The adapter lists an unconnected server with no tools until first called, so a fresh Peer could not find `done`.
      const desk = readConfig<Record<string, any>>(join(dir, harness.mcp.file), {}).mcpServers?.team;
      if (!role.tools) assert.equal(desk, undefined, `${where}: a role given no desk tools is not connected to the desk`);
      else {
        assert.equal(desk?.lifecycle, "keep-alive", `${where}: the desk is connected from the start`);
        assert.equal(desk?.directTools, true, `${where}: and its verbs are tools of their own`);
      }
    }
    assert.ok(existsSync(join(dir, harness.skillsDir)), `${where}: skills`);
  }
});

// Devin loads the AGENTS.md above every file it reads by real path, so seats picked up the plugin's own developer rules.
test("nothing a seat or its guides lead it to read resolves into a git repository", async () => {
  const kit = loadKit(pluginRoot);
  const home = tempDir("sw2-outside-home-");
  const project = { slug: "demo-000000", state: "/state/demo" };
  const roots = [guidesDir(home)];
  placeGuides(kit, home);
  for (const { role, harness } of seatPairs(kit)) {
    if (harness.modelCatalog && !realProbes.has(harness.modelCatalog.command[0]!)) continue;
    const team = withHarness(resolveTeam(kit), role.role, harness);
    materialize(kit, team, role.role, home, project);
    roots.push(join(seatDir(kit, role, harness, home, project), harness.skillsDir));
  }
  const inside: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(root, { recursive: true }).map(String)) {
      const real = realpathSync(join(root, name));
      const dir = statSync(real).isDirectory() ? real : dirname(real);
      if ((await git(dir, ["rev-parse", "--show-toplevel"])).code === 0) inside.push(`${join(root, name)} -> ${real}`);
    }
  }
  assert.deepEqual(inside.slice(0, 5), [], `${inside.length} paths resolve into a repository`);
});

test("a Codex seat runs on the model provider the owner's own Codex names, and on Codex's own when it names none", (t) => {
  const kit = loadKit(pluginRoot);
  const pair = seatPairs(kit).find((entry) => entry.harness.id === "codex" && entry.role.role === "lead")!;
  if (!realProbes.has(pair.harness.modelCatalog!.command[0]!)) return t.skip("codex is not installed here");
  const team = withHarness(resolveTeam(kit), "lead", pair.harness);
  const project = { slug: "demo-000000", state: "/state/demo" };
  const home = tempDir("sw2-codex-home-");
  materialize(kit, team, "lead", home, project);
  const file = join(seatDir(kit, pair.role, pair.harness, home, project), "config.toml");
  assert.equal(readConfig<Record<string, unknown>>(file, {}).model_provider, undefined);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'model_provider = "ZAI"\nmodel = "glm-5.3"\n\n[model_providers.ZAI]\nname = "Z"\nbase_url = "https://example.invalid"\nexperimental_bearer_token = "fake"\n');
  materialize(kit, team, "lead", home, project);
  const seat = readConfig<Record<string, any>>(file, {});
  assert.equal(seat.model_provider, "ZAI");
  assert.equal(seat.model_providers.ZAI.base_url, "https://example.invalid");
  assert.equal(seat.model, undefined, "the model is the role's, set at launch, not the owner's default");
  assert.equal(seat.approval_policy, "never", "and the kit's own settings still hold");
});

// Codex under approval_policy "never" refuses every MCP call not approved ahead.
test("a Codex seat has every desk and proxy tool it is given approved ahead, and other agents get no such list", () => {
  const kit = loadKit(pluginRoot);
  const all = resolveTeam(kit, { mcp: Object.fromEntries(Object.keys(kit.mcp).map((id) => [id, { enabled: true }])) });
  const context = { node: "/bin/node", spool: "/spool" };
  const codex = withHarness(all, "lead", kit.harnesses.codex!);
  const servers = serversFor(kit, codex, "lead", context);
  const config = { provider: providerId(kit, "lead", "codex"), cwd: "/work/repo" } as AgentConfig;
  const next = applyRole(kit, codex, config, () => "PROMPT", "/state/demo", servers) as unknown as { toolPolicy?: { preapproved: { kind: string; server: string; tool: string }[] } };
  const approved = new Set(next.toolPolicy?.preapproved.map((ref) => `${ref.server}.${ref.tool}`));
  const lead = kit.roles.find((role) => role.role === "lead")!;
  for (const tool of toolsOf(kit, lead)) assert.ok(approved.has(`team.${tool}`), `team.${tool}`);
  const proxies = Object.keys(servers).filter((id) => id !== "team" && String((servers[id] as { args?: string[] }).args?.[0]).endsWith("code.mjs"));
  assert.ok(proxies.length > 0, "the shipped kit gives the Lead at least one proxied server");
  for (const id of proxies) assert.ok([...approved].some((name) => name.startsWith(`${id}.`)), id);
  // Paseo validates request grants before attaching its native server.
  assert.ok(!approved.has("paseo.get_agent_activity"));
  for (const ref of next.toolPolicy?.preapproved ?? []) assert.ok(ref.server in servers);
  assert.ok(!approved.has("paseo.create_agent"));
  const claude = applyRole(kit, all, { provider: providerId(kit, "lead", "claude"), cwd: "/work/repo" } as AgentConfig, () => "PROMPT", "/state/demo", serversFor(kit, all, "lead", context)) as unknown as { toolPolicy?: unknown };
  assert.equal(claude.toolPolicy, undefined);
});

test("a Claude seat reads the project's own CLAUDE.md, though its settings come from its seat alone", () => {
  const kit = loadKit(pluginRoot);
  const team = resolveTeam(kit);
  const pairs = seatPairs(kit).filter((pair) => pair.harness.id === "claude");
  assert.equal(pairs.length, kit.roles.length);
  for (const { role, harness } of pairs) {
    assert.equal(harness.provider.forceFlags?.["--setting-sources"], "user", "the seat reads no project settings, which is why it needs the way in below");
    const env = (desiredProvider(kit, team, role, harness) as { env: Record<string, string> }).env;
    assert.equal(env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, "1", `${role.role}: Claude reads CLAUDE.md from an added directory only with this set`);
    const config = { provider: providerId(kit, role.role, "claude"), cwd: "/work/repo" } as AgentConfig;
    const next = applyRole(kit, team, config, () => "PROMPT", "/state/demo") as unknown as { providerOptions: { additionalDirectories?: string[] } };
    assert.deepEqual(next.providerOptions.additionalDirectories, ["/work/repo"], `${role.role}: the seat's own directory is the one added`);
  }
});

test("project records are seeded once and never overwritten", () => {
  const kit = loadKit(pluginRoot);
  const state = tempDir("sw2-state-");
  const first = seedRecords(kit, state);
  assert.ok(first.includes("notebook.md"));
  assert.deepEqual(seedRecords(kit, state), []);
});

test("no shipped role is left with Paseo's own tools at their default", () => {
  const kit = loadKit(pluginRoot);
  const team = resolveTeam(kit);
  for (const { role, harness } of seatPairs(kit)) {
    const entry = desiredProvider(kit, team, role, harness);
    assert.ok(entry.paseoTools, `${role.role} on ${harness.id} carries no Paseo tool policy, so every Paseo tool stays on`);
  }
});

test("the Supervisor can set its own cadence for reading the work, rather than the desk fixing one", () => {
  const kit = loadKit(pluginRoot);
  const team = resolveTeam(kit);
  const supervisor = kit.roles.find((role) => role.role === "supervisor")!;
  const policy = desiredProvider(kit, team, supervisor, kit.harnesses.claude!).paseoTools as { disabledTools: string[] };
  for (const own of ["create_heartbeat", "delete_heartbeat", "list_schedules"]) {
    assert.ok(!policy.disabledTools.includes(own), `a heartbeat is how a Supervisor decides when to look, so it must reach ${own}`);
  }
  for (const acting of ["create_agent", "kill_agent", "send_agent_prompt", "archive_agent"]) {
    assert.ok(policy.disabledTools.includes(acting), `the Supervisor advises and must not ${acting} behind the desk`);
  }
});

test("only the Supervisor may write the project's concept; every other role reads it or is told it", () => {
  const kit = loadKit(pluginRoot);
  const team = resolveTeam(kit);
  const writes = (role: string) => stateWrites(kit, team, kit.roles.find((entry) => entry.role === role)!, "/state");
  assert.ok(writes("supervisor").includes(join("/state", "CONTEXT.md")), "grilling writes what the Human settled there as it is settled");
  for (const role of kit.roles.filter((entry) => entry.role !== "supervisor")) {
    assert.ok(!writes(role.role).includes(join("/state", "CONTEXT.md")), `${role.role} could rewrite the Human's word`);
  }
});

test("the arguments the desk reads back are the ones each seat's own tool set offers it", () => {
  const kit = loadKit(pluginRoot);
  const tools = JSON.parse(readFileSync(join(pluginRoot, "mcp", "tools.json"), "utf-8")) as Record<string, { name: string; inputSchema?: { properties?: Record<string, unknown> } }[]>;
  const propsOf = (set: string, tool: string) => Object.keys(tools[set]?.find((entry) => entry.name === tool)?.inputSchema?.properties ?? {});

  // worker.ts reads verdict/findings from a review and outcome/summary from work, so each seat must be offered its own words.
  const setFor = (roleName: string) => kit.roles.find((role) => role.role === roleName)!.tools!;
  for (const field of ["verdict", "findings"]) {
    assert.ok(propsOf(setFor("reviewer"), "done").includes(field), `a reviewer is never asked for its ${field}, so the desk would read an empty one`);
  }
  for (const field of ["outcome", "summary"]) {
    assert.ok(propsOf(setFor("peer"), "done").includes(field), `a peer is never asked for its ${field}`);
  }
  assert.notDeepEqual(propsOf(setFor("reviewer"), "done"), propsOf(setFor("peer"), "done"));
});

test("a prompt never tells a seat to use something that seat cannot reach", () => {
  const kit = loadKit(pluginRoot);
  const tools = JSON.parse(readFileSync(join(pluginRoot, "mcp", "tools.json"), "utf-8")) as Record<string, { name: string }[]>;
  const everySkill = new Set(
    readdirSync(join(pluginRoot, "content", "skills"))
      .flatMap((set) => readdirSync(join(pluginRoot, "content", "skills", set)).map((name) => name)),
  );

  for (const role of kit.roles) {
    const text = readFileSync(join(pluginRoot, "content", role.prompt), "utf-8");
    const ticked = new Set([...text.matchAll(/`([a-z][a-z_-]{2,})`/g)].map((hit) => hit[1]!));
    const ownTools = new Set((tools[role.tools ?? ""] ?? []).map((entry) => entry.name));
    const allowed = role.paseoTools?.allow;

    for (const name of ticked) {
      if (PASEO_TOOLS.includes(name)) {
        const reachable = allowed ? allowed.includes(name) : role.paseoTools?.enabled !== false;
        assert.ok(reachable, `${role.role}'s prompt says to use the Paseo tool ${name}, which its policy denies it`);
      }
      if (everySkill.has(name)) {
        const given = new Set([
          ...(role.skills ? readdirSync(join(pluginRoot, "content", "skills", role.skills)) : []),
          ...(role.extraSkills ?? []).map((entry) => entry.split(":")[1]!),
        ]);
        assert.ok(given.has(name), `${role.role}'s prompt says to open the skill ${name}, which it is not given`);
      }
      const deskTool = Object.values(tools).some((set) => set.some((entry) => entry.name === name));
      if (deskTool && !PASEO_TOOLS.includes(name)) {
        assert.ok(ownTools.has(name), `${role.role}'s prompt says to call ${name}, which belongs to another seat's set`);
      }
    }
  }
});

test("a pasted server that names no roles is given to every role that works with tools, and not to the Watcher", () => {
  const kit = loadKit(pluginRoot);
  const team = resolveTeam(kit, { mcp: { pasted: { enabled: true, label: "Pasted", connect: { type: "http", url: "https://mcp.example.com" } } } });
  assert.deepEqual(team.errors, []);
  assert.deepEqual(Object.entries(team.roles).filter(([, seat]) => seat.mcp.includes("pasted")).map(([name]) => name).sort(), ["lead", "peer", "reviewer", "supervisor"]);
});
