import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyModels } from "../../server/catalog/paseo/models.ts";
import { serversFor } from "../../server/catalog/seat/servers.ts";
import { resolveTeam, rulesFor, servingProject, skillDirsFor, withHarness } from "../../server/catalog/team/team.ts";
import type { Layer } from "../../shared/settings.ts";
import { makeKit } from "../kit.ts";
import { tempDir } from "../tempdir.ts";

const kit = makeKit();
const context = { node: "/bin/node", socket: "/desk.sock" };
type Proxied = { backend: { urls: string[] }; open: { args: { path: string } }; tools: string[]; instructions: string };
type Served = Record<string, { args?: string[]; url?: string; type?: string } | undefined>;
const served = (team: ReturnType<typeof resolveTeam>, role: string) => serversFor(kit, team, role, context) as Served;
const proxied = (servers: Served, id: string) => JSON.parse(servers[id]?.args?.[1] ?? "{}") as Proxied;

const onClaude: Layer = { roles: { peer: { harness: "claude", model: "opus", thinking: "medium" } } };
const IN_FORCE: [string, Layer, Layer, [string, string?, string?]][] = [
  ["supervisor", {}, {}, ["claude", "opus", "high"]],
  ["peer", {}, {}, ["omp", "glm", undefined]],
  ["lead", {}, { roles: { lead: { harness: "omp" } } }, ["omp", "glm", undefined]],
  ["lead", { roles: { lead: { model: "gpt-5.6-sol" } } }, {}, ["claude", "gpt-5.6-sol", "medium"]],
  [
    "supervisor",
    { roles: { supervisor: { model: "opus-next", thinking: "max" } } },
    {},
    ["claude", "opus-next", "max"],
  ],
  [
    "supervisor",
    { roles: { supervisor: { harness: "omp" } } },
    { roles: { supervisor: { harness: "claude" } } },
    ["claude", "opus", "high"],
  ],
  [
    "lead",
    { roles: { lead: { harness: "omp", model: "glm" } } },
    { roles: { lead: { harness: "claude" } } },
    ["claude", "opus", "medium"],
  ],
  ["lead", { roles: { lead: { harness: "omp", model: "glm" } } }, {}, ["omp", "glm", undefined]],
  [
    "peer",
    { roles: { peer: { harness: "omp", model: "glm" } } },
    { roles: { peer: { harness: "claude" } } },
    ["claude", "opus", "medium"],
  ],
  ["peer", { roles: { peer: { harness: "claude" } } }, {}, ["claude", "opus", "medium"]],
  ["scribe", {}, {}, ["omp", "glm", undefined]],
  ["scribe", onClaude, {}, ["claude", "opus", "medium"]],
  ["scribe", onClaude, { roles: { scribe: { model: "haiku" } } }, ["claude", "haiku", undefined]],
  ["scribe", onClaude, { roles: { scribe: { harness: "omp" } } }, ["omp", "glm", undefined]],
  [
    "scribe",
    { roles: { ...onClaude.roles, scribe: { harness: "omp" } } },
    { roles: { scribe: { harness: "claude" } } },
    ["claude", "opus", "medium"],
  ],
];

test("each seat runs the agent, model and thinking its layers choose", () => {
  const kit = makeKit();
  writeFileSync(join(kit.dir, "harness", "claude", "settings", "peer.settings.json"), "{}");
  for (const [role, machine, project, seat] of IN_FORCE) {
    const what = `${role} over ${JSON.stringify([machine, project])}`;
    const team = resolveTeam(kit, machine, project);
    assert.deepEqual(team.errors, [], what);
    const { harness, model, thinking } = team.roles[role]!;
    assert.deepEqual([harness.id, model?.id, thinking], seat, what);
  }

  const opened = withHarness(resolveTeam(kit), "lead", kit.harnesses.omp!).roles.lead!;
  assert.deepEqual(
    [opened.harness.id, opened.model?.id, opened.thinking],
    ["omp", "glm", undefined],
    "a seat opened on another agent than the settings choose gets that agent's default",
  );
  const back = withHarness(
    resolveTeam(kit, { roles: { supervisor: { harness: "omp" } } }),
    "supervisor",
    kit.harnesses.claude!,
  );
  assert.deepEqual(
    [back.roles.supervisor!.model?.id, back.roles.supervisor!.thinking],
    ["opus", "high"],
    "and one opened back on its own agent the kit's choice there",
  );
  const listed = makeKit();
  applyModels(listed, {
    omp: {
      at: "",
      error: null,
      models: [
        { id: "claude-in-omp", label: "Claude in omp" },
        { id: "glm", label: "GLM" },
      ],
    },
  });
  assert.equal(
    resolveTeam(listed, { roles: { lead: { harness: "omp" } } }).roles.lead!.model?.id,
    "glm",
    "a role moved to an agent its preset does not name starts on the model another role's preset names there, not the first listed",
  );
});

const bare = {
  ...kit,
  harnesses: { ...kit.harnesses, omp: { ...kit.harnesses.omp!, models: undefined } },
  roles: kit.roles.map((role) => (role.role === "peer" ? { ...role, defaults: { harness: "omp" } } : role)),
};
const withRole = (name: string, change: object) => ({
  ...kit,
  roles: kit.roles.map((role) => (role.role === name ? { ...role, ...change } : role)),
});
const connect = { type: "http", url: "http://example.invalid/mcp" } as const;
const ERRORS: [typeof kit, Layer, Layer, RegExp[]][] = [
  [
    kit,
    { roles: { scout: {}, lead: { model: "gpt" } }, mcp: { nope: {}, ide: { settings: { port: "x", host: "h" } } } },
    { roles: { supervisor: { harness: "omp" }, peer: { thinking: "high" } }, mcp: { ide: { roles: ["scribe"] } } },
    [
      /^The machine settings name an unknown role scout$/,
      /^The MCP server nope has nothing to connect to/,
      /^IDE setting port must be a list of numbers$/,
      /^IDE has no setting named host$/,
      /^IDE can't be given to the scribe role/,
      /^Oh My Pi has no supervisor settings/,
    ],
  ],
  [
    kit,
    { hitl: { questionsPerDay: 5 } },
    { hitl: { on: true, questionsPerDay: 10 } },
    [/^The project settings set hitl\.questionsPerDay, which only the machine's can: it counts every project's$/],
  ],
  [
    withRole("lead", { paseoTools: { allow: ["get_agent_activty"] } }),
    {},
    {},
    [
      /allowed Paseo tools this kit does not know: get_agent_activty\. .* denies the Lead every Paseo tool rather than granting it one/,
    ],
  ],
  [withRole("lead", { paseoTools: { allow: ["get_agent_activity"] } }), {}, {}, []],
  [
    withRole("peer", { tools: "worker" }),
    {},
    {},
    [/^The Peer is given the tool set worker, which this kit does not have/],
  ],
  [
    bare,
    {},
    {},
    [
      /^Paseo has listed no models for Oh My Pi yet and none is chosen for the Peer/,
      /^Paseo has listed no models for Oh My Pi yet and none is chosen for the Scribe/,
    ],
  ],
  [bare, { roles: { peer: { model: "glm-6" } } }, {}, []],
  [
    kit,
    {},
    { mcp: { team: { connect }, paseo: { connect }, team_x: { connect } } },
    [
      /^The MCP server team has the name of a server every seat already has/,
      /^The MCP server paseo has the name of a server every seat already has/,
    ],
  ],
];

test("settings that can't describe a working team are reported, not guessed around", () => {
  for (const [variant, machine, project, reported] of ERRORS) {
    const errors = resolveTeam(variant, machine, project).errors;
    assert.equal(errors.length, reported.length, errors.join("\n"));
    for (const error of reported)
      assert.ok(
        errors.some((said) => error.test(said)),
        `${String(error)} among ${errors.join("\n")}`,
      );
  }
  const pasted = resolveTeam(kit, {}, { mcp: { team: { connect }, paseo: { connect }, team_x: { connect } } });
  assert.deepEqual(
    Object.keys(pasted.mcp).filter((id) => id.startsWith("team") || id === "paseo"),
    ["team_x"],
    "left out, since it would replace that server for every seat",
  );
  assert.notEqual(served(pasted, "peer").team?.url, connect.url, "the Peer keeps the team's own server");
});

test("each seat is told and given what its servers, its role and the Human say, the project's word over the machine's", () => {
  const plain = resolveTeam(kit);
  assert.deepEqual(
    [plain.roles.lead!.mcp, plain.roles.supervisor!.mcp, plain.roles.scribe!.mcp, plain.mcp.docs!.enabled],
    [["ide"], [], [], false],
    "a server on by default reaches the roles it serves, and one off by default none",
  );
  assert.deepEqual([...skillDirsFor(plain, "lead").keys()], ["ide-guide"], "its skills follow it");
  assert.equal(rulesFor(plain, "supervisor"), "", "a seat with nothing to be told has no rules");
  assert.deepEqual(
    [plain.attention.leadIdleMinutes, plain.attention.recoverWithin, plain.attention.lookMinutes],
    [15, 10, 5],
    "the kit's attention",
  );
  assert.deepEqual(
    [...skillDirsFor(resolveTeam(kit, { mcp: { ide: { enabled: false } } }), "lead").keys()],
    [],
    "and a server switched off takes its skills",
  );

  const machine: Layer = {
    mcp: { docs: { enabled: true }, ide: { settings: { port: [1234, 1235] }, roles: ["lead", "peer"] } },
    rules: "Keep diffs small.",
    attention: { longTurnMinutes: 45, lookMinutes: 8 },
  };
  const project: Layer = {
    roles: { lead: { harness: "omp" }, peer: { rules: "Never touch the generated client." } },
    mcp: { ide: { roles: ["peer"] } },
    rules: "Use pnpm.",
    attention: { lookMinutes: 2 },
  };
  const team = resolveTeam(kit, machine, project);
  assert.deepEqual(team.errors, []);
  assert.deepEqual(
    [team.roles.lead!.mcp, team.roles.peer!.mcp],
    [["docs"], ["ide", "docs"]],
    "a project narrows a server to the roles it names, over those the machine names",
  );
  assert.equal(team.rules, "Keep diffs small.\n\nUse pnpm.");
  assert.deepEqual(
    [team.attention.longTurnMinutes, team.attention.lookMinutes],
    [45, 2],
    "what the project leaves alone comes from the machine",
  );
  const lead = served(team, "lead");
  assert.deepEqual(
    [Object.keys(lead).sort(), lead.docs],
    [["docs", "team"], { type: "http", url: "https://docs.example/mcp" }],
  );
  const ide = proxied(served(team, "peer"), "ide");
  assert.deepEqual(
    [ide.backend.urls, ide.open.args.path, ide.tools, ide.instructions],
    [
      ["http://127.0.0.1:1234/mcp", "http://127.0.0.1:1235/mcp"],
      "{root}",
      ["ide_find_references", "ide_refactor_rename"],
      "Prefer the IDE tools.",
    ],
    "a proxy is configured from its settings, an address for each port in order, with the tools its catalog gives the role",
  );
  assert.equal(
    rulesFor(team, "peer"),
    "# Working rules\n\nPrefer the IDE for navigation.\n\nYour IDE tools: `ide_find_references`, `ide_refactor_rename`.\n\nCheck diagnostics before handing back.\n\nLook library APIs up in the docs.\n\n## Rules from the Human\n\nKeep diffs small.\n\nUse pnpm.\n\n## Rules from the Human, for the Peer\n\nNever touch the generated client.\n",
    "each enabled server's rule, the role's tools and notes, then the Human's rules and the ones for this seat alone",
  );
  assert.equal(
    rulesFor(team, "scribe"),
    "# Working rules\n\n## Rules from the Human\n\nKeep diffs small.\n\nUse pnpm.\n",
    "what every seat is told reaches a seat with no server, and nothing meant for another",
  );

  const peer = kit.roles.find((role) => role.role === "peer")!;
  const twinned = resolveTeam({
    ...kit,
    roles: [...kit.roles, { ...peer, role: "twin", label: "Twin", like: "peer" }],
  });
  assert.match(rulesFor(twinned, "peer"), /Your IDE tools: .*\n\nCheck diagnostics before handing back\./);
  assert.equal(
    rulesFor(twinned, "twin"),
    rulesFor(twinned, "peer"),
    "a role like another is given that role's servers, and told of their tools and notes as that role is",
  );

  const widened = resolveTeam(kit, {}, { mcp: { docs: { enabled: true, roles: ["peer", "scribe"] } } });
  assert.deepEqual(
    [widened.errors, widened.roles.scribe!.mcp, widened.roles.lead!.mcp],
    [[], ["docs"], ["ide"]],
    "a plain server offers every role the same, so the settings give it to a role its catalog entry does not name",
  );

  const retooled = resolveTeam(kit, { mcp: { ide: { tools: { lead: ["ide_refactor_rename"] } } } });
  assert.deepEqual(
    proxied(served(retooled, "lead"), "ide").tools,
    ["ide_refactor_rename"],
    "which of a proxy's tools a role gets is a setting",
  );
  assert.match(rulesFor(retooled, "lead"), /Your IDE tools: `ide_refactor_rename`\./);
});

test("a server that needs something the project lacks is left off its seats, with everything that tells them to use it", () => {
  const team = resolveTeam(kit, { mcp: { docs: { enabled: true } } });
  const bareRoot = tempDir("sw3-bare-");
  const lacking = servingProject(team, bareRoot);
  assert.deepEqual(
    lacking.roles.peer!.mcp,
    ["docs"],
    "the IDE index was once given to seats of a project it had never opened",
  );
  assert.equal(lacking.mcp.ide!.enabled, false, "and the desk does not open the project in it either");
  assert.doesNotMatch(rulesFor(lacking, "peer"), /IDE|diagnostics/);
  assert.equal(skillDirsFor(lacking, "peer").has("ide-guide"), false);
  assert.equal(served(lacking, "peer").ide, undefined);

  const opened = tempDir("sw3-idea-");
  mkdirSync(join(opened, ".idea"));
  assert.deepEqual(servingProject(team, opened).roles.peer!.mcp, ["ide", "docs"]);
});

test("whoever supervises speaks to the Human in the language the machine's settings name, on every agent, and nobody else is told to", () => {
  assert.doesNotMatch(rulesFor(resolveTeam(kit), "supervisor"), /language/i, "no language named, none is told");
  const team = resolveTeam(kit, { language: "Vietnamese" });
  assert.match(rulesFor(team, "supervisor"), /Speak to the Human in Vietnamese/);
  assert.doesNotMatch(
    rulesFor(team, "lead"),
    /Vietnamese/,
    "the rest of the team writes English, which the watch reads",
  );
  assert.deepEqual(resolveTeam(kit, {}, { language: "French" }).errors, [
    "The project settings set language, which only the machine's can: the Human is the same in every project",
  ]);
});

test("the Human is out of the loop unless the settings put them in: the project's word over the machine's, the machine's limit", () => {
  assert.deepEqual(resolveTeam(kit).hitl, { on: false, questionsPerDay: 3 });
  assert.deepEqual(resolveTeam(kit, { hitl: { on: true, questionsPerDay: 5 } }, { hitl: { on: false } }).hitl, {
    on: false,
    questionsPerDay: 5,
  });
  assert.equal(resolveTeam(kit, {}, { hitl: { on: true } }).hitl.on, true);
});
