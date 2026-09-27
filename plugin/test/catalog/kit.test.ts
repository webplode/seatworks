import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { renderPrompt, skillSources } from "../../server/catalog/kit/content.ts";
import { can, roleNamed, roleThatCan, rolesThatCan, toolsOf } from "../../server/catalog/kit/roles.ts";
import { supportsRole } from "../../server/catalog/kit/harness-files.ts";
import { loadKit } from "../../server/catalog/kit/kit.ts";
import { resolveTeam } from "../../server/catalog/team/team.ts";
import { tempDir } from "../tempdir.ts";

const shipped = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../catalog/${name}`, import.meta.url), "utf-8"));

function put(dir: string, path: string, value: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), JSON.stringify(value));
}

/** A kit of the test's own over the shipped ecosystem, Paseo's tools, the watch's thresholds and questions and refused commands, and no patterns. */
function kitDir(files: Record<string, unknown>): string {
  const dir = tempDir("sw3-kit-");
  mkdirSync(join(dir, "catalog"), { recursive: true });
  for (const name of ["ecosystem.json", "paseo.json", "attention.json", "checks.json", "refused.json"])
    copyFileSync(new URL(`../../catalog/${name}`, import.meta.url), join(dir, "catalog", name));
  put(dir, "catalog/patterns.json", {});
  for (const [path, value] of Object.entries(files)) put(dir, path, value);
  return dir;
}

const harness = {
  id: "acme",
  label: "Acme CLI",
  baseProvider: "omp",
  configDirEnv: "ACME_CONFIG_DIR",
  profileRoot: "HOME/.acme/seats",
  skillsDir: "skills",
  projectContextOption: "additionalDirectories",
  mcpCall: "mcp__{server}__",
  settings: { file: "config.json", source: "settings.json", roleSource: "settings/ROLE.settings.json" },
  mcp: { file: "mcp.json", delivery: "file", transports: ["stdio"], key: "mcpServers" },
  provider: { profileModeId: "full", env: { SEATWORKS_AGENT_BIN: "acme" } },
};
const { label: _label, ...unlabelled } = harness;
const peer = {
  role: "peer",
  label: "Peer",
  defaults: { harness: "acme", model: "m" },
  prompt: "prompts/PEER.md",
  skills: null,
};
const archivist = {
  role: "archivist",
  label: "Archivist",
  follows: "peer",
  prompt: "prompts/ARCHIVIST.md",
  skills: null,
};
const sensor = {
  id: "judge",
  label: "Judge",
  key: "Judge key",
  url: "https://judge.example/api",
  model: "judge-1",
  terms: "Asked as its vendor's terms say.",
  timeoutSeconds: 5,
  retries: 1,
};
const checks = shipped("checks.json") as Record<string, Record<string, unknown>>;
const struggling = (shipped("patterns.json") as Record<string, Record<string, unknown>>).struggling!;
const good = {
  "harness/acme/harness.json": harness,
  "roles.json": { roles: [peer, archivist] },
  "catalog/sensor/judge.json": sensor,
};

const HARNESS = "harness/acme/harness.json";
const REFUSED: [string, unknown, RegExp][] = [
  [HARNESS, { ...harness, skillDir: "skills" }, /^harness acme is not as the kit reads it:\n✖ .*"skillDir"$/],
  [HARNESS, unlabelled, /^harness acme is not as the kit reads it:\n✖ .*\n {2}→ at label$/],
  [
    HARNESS,
    { ...harness, mcp: { file: "mcp.json", delivery: "file", transports: ["stdio"] } },
    /^harness acme is not as the kit reads it:\n✖ delivers MCP servers in a file but names no key\n {2}→ at mcp\.key$/,
  ],
  [
    HARNESS,
    { ...harness, settings: { file: "config.json", source: "settings.json" } },
    /^harness acme is not as the kit reads it:\n✖ .*\n {2}→ at settings\.roleSource$/,
  ],
  [
    HARNESS,
    { ...harness, projectContextOption: ["additionalDirectories"] },
    /^harness acme is not as the kit reads it:\n✖ .*\n {2}→ at projectContextOption$/,
  ],
  [
    HARNESS,
    { ...harness, projectContextOption: "" },
    /^harness acme is not as the kit reads it:\n✖ .*\n {2}→ at projectContextOption$/,
  ],
  [
    HARNESS,
    { ...harness, mcpCall: "mcp__team__{tool}" },
    /^harness acme is not as the kit reads it:\n✖ does not say where the server's name goes\n {2}→ at mcpCall$/,
  ],
  [HARNESS, { ...harness, id: "other" }, /^harness acme calls itself other but sits in harness\/acme$/],
  [
    "roles.json",
    { roles: [peer, { ...archivist, defaults: { harness: "acme" } }] },
    /^role archivist follows peer and names defaults of its own; it takes one or the other$/,
  ],
  [
    "roles.json",
    { roles: [peer, { ...archivist, follows: "nobody" }] },
    /^role archivist follows nobody, which is no other role in roles\.json$/,
  ],
  [
    "roles.json",
    { roles: [peer, { ...archivist, follows: "archivist" }] },
    /^role archivist follows archivist, which is no other role in roles\.json$/,
  ],
  [
    "roles.json",
    { roles: [peer, archivist, { ...archivist, role: "echo", follows: "archivist" }] },
    /^role echo follows archivist, which follows peer in turn; a role follows one that chooses for itself$/,
  ],
  [
    "roles.json",
    { roles: [peer, { role: "twin", label: "Twin", like: "nobody", defaults: { harness: "acme" } }] },
    /^role twin is like nobody, which is no other role in roles\.json that is its own$/,
  ],
  [
    "roles.json",
    {
      roles: [
        peer,
        { role: "twin", label: "Twin", like: "peer", defaults: { harness: "acme" } },
        { role: "triplet", label: "Triplet", like: "twin", defaults: { harness: "acme" } },
      ],
    },
    /^role triplet is like twin, which is no other role in roles\.json that is its own$/,
  ],
  [
    "roles.json",
    { roles: [{ ...peer, extraSkills: ["council"] }] },
    /^roles\.json is not as the kit reads it:\n✖ is not written set:name\n {2}→ at roles\[0\]\.extraSkills\[0\]$/,
  ],
  [
    "roles.json",
    { roles: [{ ...peer, writes: ["gates/"] }] },
    /^role peer writes gates, which is the desk's own record$/,
  ],
  [
    "roles.json",
    { roles: [{ ...peer, writes: ["../outside"] }] },
    /^roles\.json is not as the kit reads it:\n✖ is not one file, or one folder ending in \/, under the project's state\n {2}→ at roles\[0\]\.writes\[0\]$/,
  ],
  [
    "catalog/refused.json",
    { acme: "agents start through the desk" },
    /^refused\.json refuses acme, which every acme seat is started with, through the same PATH$/,
  ],
  [
    "catalog/refused.json",
    { git: "the desk's" },
    /^refused\.json refuses git, which the kit's git shim runs, through the same PATH$/,
  ],
  [
    "catalog/refused.json",
    { "hub cli": "the forge's" },
    /^refused\.json is not as the kit reads it:\n✖ names what is not a command's name$/,
  ],
  [
    "catalog/sensor/judge.json",
    { ...sensor, url: "http://judge.example/api" },
    /^catalog\/sensor\/judge\.json is not as the kit reads it:\n✖ is not an https address\n {2}→ at url$/,
  ],
  ["catalog/sensor/judge.json", { ...sensor, id: "other" }, /^catalog\/sensor\/judge\.json names itself other$/],
  [
    "catalog/checks.json",
    { ...checks, review_ran_invariant: { ...checks.review_ran_invariant, no: 0.9 } },
    /^checks\.json is not as the kit reads it:\n✖ no must sit below yes\n {2}→ at review_ran_invariant$/,
  ],
  [
    "catalog/checks.json",
    { ...checks, review_ran_invariant: { ...checks.review_ran_invariant, instructions: { invariant: null } } },
    /^checks\.json is not as the kit reads it:\n✖ names no question\n {2}→ at review_ran_invariant\.instructions$/,
  ],
  [
    "catalog/checks.json",
    { ...checks, instruction_kind: { ...checks.instruction_kind, criteria: { other: "Anything." } } },
    /^checks\.json is not as the kit reads it:\n✖ a pick needs two criteria or more\n {2}→ at instruction_kind$/,
  ],
  [
    "catalog/checks.json",
    { ...checks, asked_for: { ...checks.asked_for, acts: { destructive: "run a command" } } },
    /^checks\.json is not as the kit reads it:\n✖ .*\{quote\}.*\n {2}→ at asked_for\.acts\.destructive$/,
  ],
  [
    "catalog/patterns.json",
    { drift: { ...struggling, no: 0.9 } },
    /^patterns\.json is not as the kit reads it:\n✖ has no that is not below yes\n {2}→ at drift$/,
  ],
  [
    "catalog/patterns.json",
    { drift: { ...struggling, instructions: "Does the agent drift?" } },
    /^patterns\.json is not as the kit reads it:\n✖ .*`text`.*\n {2}→ at drift\.instructions$/,
  ],
  [
    "catalog/patterns.json",
    // The sensor's question is the first stage: a pattern only the seat could judge would be judged unflagged.
    { drift: Object.fromEntries(Object.entries(struggling).filter(([field]) => field !== "instructions")) },
    /^patterns\.json is not as the kit reads it:\n✖ .*\n {2}→ at drift\.instructions$/,
  ],
];

test("a kit file that breaks its contract is refused as the kit loads, naming the file and what is wrong, and one that keeps it loads", () => {
  const kit = loadKit(kitDir(good));
  assert.deepEqual(Object.keys(kit.harnesses), ["acme"]);
  assert.deepEqual(
    roleNamed(kit, "archivist")!.defaults,
    { harness: "acme", model: "m" },
    "a follower takes its defaults",
  );
  assert.deepEqual(Object.keys(kit.sensors), ["judge"]);

  for (const [file, value, refusal] of REFUSED) {
    const dir = kitDir({ ...good, [file]: value });
    assert.throws(() => loadKit(dir), { message: refusal }, `${file}: ${String(refusal)}`);
  }
});

test("a roles or refused file in the state root replaces the shipped one, and a roles file may name its prompts anywhere", () => {
  const lead = {
    role: "lead",
    label: "Lead",
    can: ["lead"],
    tools: "lead",
    defaults: { harness: "acme" },
    prompt: "prompts/LEAD.md",
    skills: null,
  };
  const bare = { ...harness, provider: { profileModeId: "full" } };
  const dir = kitDir({ [HARNESS]: bare, "roles.json": { providerPrefix: "sw3-", roles: [lead] } });
  const kit = loadKit(dir);
  assert.deepEqual(
    [kit.roles.map((role) => role.role), kit.refused],
    [["lead"], shipped("refused.json")],
    "with nothing of the owner's, the kit runs what it ships",
  );

  const mine = tempDir("sw3-preset-mine-");
  const prompt = join(mine, "DRIVER.md");
  writeFileSync(prompt, "# Driver\n\nYou drive.\n");
  put(mine, "roles.json", {
    providerPrefix: "sw3-",
    roles: [
      { ...lead, role: "driver", label: "Driver", prompt, skills: "driving" },
      { ...lead, role: "navigator", label: "Navigator", prompt, skills: "routes" },
    ],
  });
  put(mine, "refused.json", { hub: "the forge's" });
  const [first] = Object.keys(checks);
  put(mine, "checks.json", { [first!]: checks[first!] });
  put(mine, "patterns.json", {
    drift: { ...struggling, watches: ["lead"] },
    wander: { ...struggling, watches: ["lead", "write"] },
  });
  put(mine, "sensor/judge.json", { ...sensor, model: "judge-2" });
  const own = loadKit(dir, mine);
  assert.deepEqual(
    own.roles.map((role) => role.role),
    ["driver", "navigator"],
    "and that arrangement is the one that runs",
  );
  assert.deepEqual(
    [own.refused, Object.keys(own.checks), own.sensors.judge?.model],
    [{ hub: "the forge's" }, [first], "judge-2"],
    "and so do the watch's questions and sensors",
  );
  assert.deepEqual(
    Object.keys(own.patterns),
    [],
    "a pattern that watches nobody this arrangement watches reads nothing, and it does not stop the kit loading",
  );
  assert.deepEqual(
    resolveTeam(own).errors.filter((error) => /^The pattern/.test(error)),
    [
      "The pattern drift watches what can lead, and no watched role in this kit can, so it is left out",
      "The pattern wander watches what can lead, and no watched role in this kit can, so it is left out",
      "The pattern wander watches what can write, and no watched role in this kit can, so it is left out",
    ],
    "and whoever reads the team's errors is told",
  );
  assert.match(
    renderPrompt(own, own.roles[0]!, "claude", { guides: "/g", state: "/s" }),
    /You drive\./,
    "its prompt is read from where it says, not from inside the package",
  );
  const skill = (root: string, set: string, name: string) =>
    put(root, `${set}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${name}\n---\n`);
  skill(join(dir, "content", "skills"), "routes", "plan-route");
  skill(join(mine, "own", "skills"), "routes", "avoid-tolls");
  skill(join(mine, "own", "skills"), "driving", "park");
  assert.deepEqual(
    own.roles.map((role) => [...skillSources(own, role).keys()].sort()),
    [["park"], ["avoid-tolls", "plan-route"]],
    "a skill set of its own, and a skill of its own in a shipped set, are found where the owner keeps them",
  );
  const acme = own.harnesses.acme!;
  assert.equal(supportsRole(own, acme, own.roles[0]!), false, "a role of its own needs its sandbox on each harness");
  put(mine, "own/harness/acme/settings/driver.settings.json", { sandbox: "read-only" });
  mkdirSync(join(mine, "own/harness/acme/delta"));
  writeFileSync(join(mine, "own/harness/acme/delta/driver.md"), "On Acme, keep to the left lane.\n");
  assert.equal(supportsRole(own, acme, own.roles[0]!), true, "found in the state root's own harness folder");
  assert.match(
    renderPrompt(own, own.roles[0]!, "acme", { guides: "/g", state: "/s" }),
    /You drive\.\n\nOn Acme, keep to the left lane\./,
    "and so is what that harness adds to its prompt",
  );
});

test("a capability several roles hold can name which of them, and a stored name is asked what it can do", () => {
  const role = (name: string, can: string[], tools: string, concern?: string) => ({
    role: name,
    label: name,
    can,
    tools,
    ...(concern ? { concern } : {}),
    defaults: { harness: "acme" },
    prompt: `prompts/${name}.md`,
    skills: null,
  });
  const kit = loadKit(
    kitDir({
      [HARNESS]: harness,
      "mcp/tools.json": {
        supervisor: [{ name: "open_lane" }, { name: "answer" }],
        lead: [{ name: "report" }],
        reviewer: [{ name: "done" }],
      },
      "roles.json": {
        providerPrefix: "sw3-",
        roles: [
          role("architecture", ["supervise"], "supervisor", "architecture"),
          role("safety", ["supervise"], "supervisor", "safety"),
          role("careful", ["review"], "reviewer"),
          role("adversary", ["review"], "reviewer"),
          role("lead", ["lead"], "lead"),
          role("arch-lead", ["lead"], "lead"),
        ],
      },
    }),
  );

  const supervising = rolesThatCan(kit, "supervise");
  assert.deepEqual(
    supervising.map((entry) => [entry.role, entry.concern, toolsOf(kit, entry), can(entry, "lead")]),
    [
      ["architecture", "architecture", ["open_lane", "answer"], false],
      ["safety", "safety", ["open_lane", "answer"], false],
    ],
    "a project is not limited to one supervising seat, and each carries what it specialises in",
  );
  assert.deepEqual(toolsOf(kit, roleThatCan(kit, "lead")), ["report"]);
  assert.equal(roleThatCan(kit, "review")?.role, "careful", "unnamed, the preset's first");
  assert.equal(roleThatCan(kit, "review", "adversary")?.role, "adversary", "named, the one asked for");
  assert.equal(
    roleThatCan(kit, "review", "lead"),
    undefined,
    "a role that cannot do it is not a stand-in for one that can",
  );
  assert.equal(roleThatCan(kit, "review", "nobody"), undefined);
  assert.equal(
    can(roleNamed(kit, "arch-lead"), "lead"),
    true,
    "a lead need not be named lead to have its asks answered",
  );
  assert.equal(can(roleNamed(kit, "careful"), "lead"), false, "and a reviewer still has someone above it");
  assert.equal(
    can(roleNamed(kit, "a role this kit lost"), "lead"),
    false,
    "a name the kit no longer has can do nothing, so its ask still escalates",
  );
});
