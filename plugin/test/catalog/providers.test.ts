import assert from "node:assert/strict";
import { test } from "node:test";
import { desiredProfile, desiredProvider, reconcile, seatPairs } from "../../server/catalog/providers.ts";
import { resolveTeam } from "../../server/catalog/team.ts";
import { makeKit } from "../kit.ts";

const kit = makeKit();
const team = resolveTeam(kit);
const role = (name: string) => kit.roles.find((entry) => entry.role === name)!;

test("every role gets a provider on each harness that has settings for it", () => {
  assert.deepEqual(
    seatPairs(kit).map((pair) => `${pair.role.role}-${pair.harness.id}`).sort(),
    ["lead-claude", "lead-devin", "peer-devin", "scribe-claude", "scribe-devin", "supervisor-claude"],
  );
});

test("a role provider carries its harness base, launcher, env, the model it starts on, and tool limits", () => {
  const entry = desiredProvider(kit, team, role("lead"), kit.harnesses.claude!);
  assert.equal(entry.extends, "claude");
  assert.equal(entry.label, "Lead · Claude Code (sw2)");
  assert.deepEqual(entry.command, [`${kit.dir}/bin/seat-room`]);
  assert.equal(entry.env.SEATWORKS_ROLE, "lead");
  assert.equal(entry.env.SEATWORKS_KIT, kit.dir);
  // Paseo lists the agent's own models; replacing that list hid every model but the chosen one.
  assert.equal(entry.models, undefined);
  assert.deepEqual(entry.additionalModels, [{ id: "opus", label: "Opus", isDefault: true }]);
  const chosen = desiredProvider(kit, resolveTeam(kit, { roles: { lead: { model: "haiku" } } }), role("lead"), kit.harnesses.claude!);
  assert.deepEqual(chosen.additionalModels, [{ id: "haiku", label: "Haiku", isDefault: true }]);
  assert.deepEqual(desiredProvider(kit, team, role("peer"), kit.harnesses.devin!).paseoTools, { enabled: false });
  assert.deepEqual(desiredProfile(kit, team, role("peer"), kit.harnesses.devin!), { id: "sw2-peer-devin", name: "Peer · Devin CLI (sw2)", provider: "sw2-peer-devin", model: "swe", modeId: "bypass" });
});

test("reconcile adds the role providers and profiles and is idempotent", () => {
  const config = { agents: { providers: { claude: { env: { TOKEN: "keep" } } } }, daemon: { agentProfiles: [{ id: "mine", provider: "claude" }] } };
  const first = reconcile(config, kit, team);
  assert.deepEqual(first.changed.sort(), [
    "profile sw2-lead-claude",
    "profile sw2-lead-devin",
    "profile sw2-peer-devin",
    "profile sw2-scribe-claude",
    "profile sw2-scribe-devin",
    "profile sw2-supervisor-claude",
    "provider sw2-lead-claude",
    "provider sw2-lead-devin",
    "provider sw2-peer-devin",
    "provider sw2-scribe-claude",
    "provider sw2-scribe-devin",
    "provider sw2-supervisor-claude",
  ]);
  assert.equal(first.config.agents.providers.claude.env.TOKEN, "keep");
  assert.equal(first.config.daemon.agentProfiles[0].id, "mine");
  assert.deepEqual(reconcile(first.config, kit, team).changed, []);
});

test("reconcile removes providers the kit no longer defines and keeps a user's own env keys", () => {
  const config = {
    agents: {
      providers: {
        "sw2-peer": { extends: "acp" },
        "sw2-peer-devin": { extends: "claude", env: { MY_KEY: "x", CLAUDE_CODE_DISABLE_CRON: "1", CLAUDE_CONFIG_DIR: "/old", SEATWORKS_SLUG: "old" }, description: "stale", models: [{ id: "swe", label: "SWE" }] },
        peer: { extends: "acp" },
      },
    },
    daemon: { agentProfiles: [{ id: "sw2-peer", provider: "sw2-peer" }] },
  };
  const { config: next, changed } = reconcile(config, kit, team);
  assert.ok(changed.includes("provider sw2-peer removed"));
  assert.ok(changed.includes("profile sw2-peer removed"));
  assert.equal("sw2-peer" in next.agents.providers, false);
  assert.ok("peer" in next.agents.providers);
  const peer = next.agents.providers["sw2-peer-devin"];
  assert.equal(peer.extends, "acp");
  assert.deepEqual(Object.keys(peer.env).sort(), ["MY_KEY", "SEATWORKS_AGENT_BIN", "SEATWORKS_HARNESS", "SEATWORKS_KIT", "SEATWORKS_ROLE"]);
  assert.equal("description" in peer, false);
  // A list written over Paseo's own hid every model the agent has but the one chosen.
  assert.equal("models" in peer, false);
  assert.deepEqual(peer.additionalModels, [{ id: "swe", label: "SWE", isDefault: true }]);
});

test("disabling a launch profile preserves provider config, role routing and unmanaged profiles", () => {
  const config = reconcile({ daemon: { agentProfiles: [{ id: "my-own", provider: "claude", model: "custom" }] } }, kit, team).config;
  const hidden = resolveTeam(kit, { profiles: { disabled: ["sw2-lead-claude"] } });
  assert.deepEqual(hidden.roles, team.roles);
  const after = reconcile(config, kit, hidden);
  assert.deepEqual(after.config.agents.providers, config.agents.providers);
  assert.equal(after.config.daemon.agentProfiles.some((p: { id: string }) => p.id === "sw2-lead-claude"), false);
  assert.deepEqual(after.config.daemon.agentProfiles.find((p: { id: string }) => p.id === "my-own"), config.daemon.agentProfiles[0]);
  assert.deepEqual(reconcile(after.config, kit, hidden).changed, []);
  const restored = reconcile(after.config, kit, team);
  assert.deepEqual(restored.config.daemon.agentProfiles.find((p: { id: string }) => p.id === "sw2-lead-claude"), desiredProfile(kit, team, role("lead"), kit.harnesses.claude!));
});
