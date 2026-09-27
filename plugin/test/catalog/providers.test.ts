import assert from "node:assert/strict";
import { test } from "node:test";
import type { Kit } from "../../server/catalog/kit/kit.ts";
import { applyModels } from "../../server/catalog/paseo/models.ts";
import { providerPatches } from "../../server/catalog/paseo/providers.ts";
import { type Team, resolveTeam } from "../../server/catalog/team/team.ts";
import { nodeBin } from "../../server/core/paths.ts";
import { fakeConfig } from "../runtime/fake-paseo.ts";
import { makeKit } from "../kit.ts";

type Provider = {
  extends?: string;
  label?: string;
  command?: string[];
  env?: Record<string, string>;
  description?: string;
  models?: unknown;
  additionalModels?: unknown;
  paseoTools?: unknown;
};

/** Paseo's config as a machine that ran an older plugin leaves it: the owner's entries beside providers and profiles of the kit's. */
const owners = () =>
  fakeConfig({
    providers: {
      claude: { env: { TOKEN: "keep" } },
      peer: { extends: "acp", command: ["peer"] },
      "sw3-peer": { extends: "acp", command: ["x"] },
      "sw3-peer-omp": {
        extends: "claude",
        env: { MY_KEY: "x", CLAUDE_CODE_DISABLE_CRON: "1", CLAUDE_CONFIG_DIR: "/old", SEATWORKS_SLUG: "old" },
        description: "stale",
        models: [{ id: "glm", label: "GLM" }],
      },
    },
    agentProfiles: [{ id: "mine" }, { id: "sw3-peer" }, { id: "sw3-lead-claude", provider: "sw3-lead-claude" }],
  });

/** One pass as the plugin makes it: Paseo's config read, and each change patched in through Paseo's API. */
async function pass(config: ReturnType<typeof fakeConfig>, kit: Kit, teams: Team[], keep?: Set<string>) {
  const plan = providerPatches((await config.api.get()).config, kit, teams, keep);
  for (const patch of plan.patches) await config.api.patch(patch);
  return plan;
}

const providers = (config: ReturnType<typeof fakeConfig>) => config.held().providers as Record<string, Provider>;
const ours = (config: ReturnType<typeof fakeConfig>) =>
  Object.keys(providers(config))
    .filter((id) => id.startsWith("sw3-"))
    .sort();

test("with no project attached, a load writes no provider of the kit's and takes off every one it wrote before, leaving the owner's own alone", async () => {
  const kit = makeKit();
  const config = owners();
  const before = structuredClone(config.held());
  const { changed } = await pass(config, kit, []);
  assert.deepEqual(changed.sort(), [
    "profile sw3-lead-claude removed",
    "profile sw3-peer removed",
    "provider sw3-peer removed",
    "provider sw3-peer-omp removed",
  ]);
  assert.deepEqual(ours(config), [], "nothing is wanted until a project is attached");
  assert.deepEqual(
    [providers(config).claude, providers(config).peer],
    [before.providers.claude, before.providers.peer],
  );
  assert.deepEqual(config.held().agentProfiles, [{ id: "mine" }]);
  assert.deepEqual((await pass(config, kit, [])).patches, [], "a second load changes nothing");
  assert.deepEqual(
    (await pass(owners(), kit, [], new Set(["sw3-peer-omp"]))).changed.filter((line) => line.includes("peer-omp")),
    [],
    "a provider a live seat still runs on stays as it is",
  );
});

test("an attached project's team gets one provider per role, on the agent that role has there, and no profile; the owner's keys on one it keeps stay, what the kit dropped goes though Paseo merges a patch, and a second pass changes nothing", async () => {
  const kit = makeKit();
  const config = owners();
  const { changed } = await pass(config, kit, [resolveTeam(kit)]);
  assert.deepEqual(changed.sort(), [
    "profile sw3-lead-claude removed",
    "profile sw3-peer removed",
    "provider sw3-lead-claude",
    "provider sw3-peer removed",
    "provider sw3-peer-omp",
    "provider sw3-scribe-omp",
    "provider sw3-supervisor-claude",
  ]);
  assert.deepEqual(
    ours(config),
    ["sw3-lead-claude", "sw3-peer-omp", "sw3-scribe-omp", "sw3-supervisor-claude"],
    "exactly the pairs the default team seats, the Scribe on the agent of the Peer it follows",
  );
  const lead = providers(config)["sw3-lead-claude"]!;
  assert.deepEqual(
    [lead.extends, lead.label, lead.command, lead.env?.SEATWORKS_ROLE, lead.env?.SEATWORKS_KIT],
    ["claude", "Lead · Claude Code (sw3)", [nodeBin(), `${kit.dir}/bin/seat-room.mjs`], "lead", kit.dir],
  );
  assert.equal(
    lead.models,
    undefined,
    "Paseo lists the agent's own models: replacing that list hid every model but the chosen one",
  );
  assert.deepEqual(lead.additionalModels, [{ id: "opus", label: "Opus", isDefault: true }]);
  const peer = providers(config)["sw3-peer-omp"]!;
  assert.equal(peer.extends, "omp");
  assert.deepEqual(
    Object.keys(peer.env ?? {}).sort(),
    ["MY_KEY", "SEATWORKS_AGENT_BIN", "SEATWORKS_HARNESS", "SEATWORKS_KIT", "SEATWORKS_ROLE"],
    "what the kit manages is its own to drop, and the owner's keys stay",
  );
  assert.deepEqual(
    [peer.description, peer.models, peer.additionalModels],
    [undefined, undefined, [{ id: "glm", label: "GLM", isDefault: true }]],
  );
  assert.deepEqual(peer.paseoTools, { enabled: false });
  assert.deepEqual(
    config.held().agentProfiles,
    [{ id: "mine" }],
    "nothing reads a profile, so only the owner's own stay",
  );
  assert.deepEqual((await pass(config, kit, [resolveTeam(kit)])).patches, [], "a second pass changes nothing");

  const haiku = await pass(config, kit, [resolveTeam(kit, { roles: { lead: { model: "haiku" } } })]);
  assert.deepEqual(haiku.changed, ["provider sw3-lead-claude"]);
  assert.deepEqual(
    haiku.patches.map((patch) => Object.keys(patch)),
    [["providers"]],
    "a change that drops no key is one patch, the provider never gone meanwhile",
  );
  assert.deepEqual(
    providers(config)["sw3-lead-claude"]!.additionalModels,
    [{ id: "haiku", label: "Haiku", isDefault: true }],
    "the model it starts on is the one chosen",
  );
  const onOmp = resolveTeam(kit, {}, { roles: { lead: { harness: "omp" } } });
  await pass(config, kit, [resolveTeam(kit), onOmp]);
  assert.deepEqual(
    ours(config),
    ["sw3-lead-claude", "sw3-lead-omp", "sw3-peer-omp", "sw3-scribe-omp", "sw3-supervisor-claude"],
    "two projects seat what either team uses",
  );
  await pass(config, kit, [onOmp]);
  assert.deepEqual(
    ours(config),
    ["sw3-lead-omp", "sw3-peer-omp", "sw3-scribe-omp", "sw3-supervisor-claude"],
    "and what no team uses any more is taken off",
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
  const fresh = fakeConfig();
  await pass(fresh, listed, [resolveTeam(listed, { roles: { lead: { harness: "omp" } } })]);
  assert.deepEqual(
    providers(fresh)["sw3-lead-omp"]!.additionalModels,
    [{ id: "glm", label: "GLM", isDefault: true }],
    "a role on an agent its preset does not name starts on another role's preset there, not the first listed",
  );
});
