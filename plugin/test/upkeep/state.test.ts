import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MachineLayerSchema, ProjectLayerSchema, readLayer } from "../../server/catalog/settings.ts";
import { STATE_VERSION } from "../../server/core/state.ts";
import { readJson, writeJson } from "../../server/core/store.ts";
import { ledgerFault, loadLedger } from "../../server/desk/ledger.ts";
import { loadIncidents } from "../../server/desk/incidents.ts";
import { loadConfig } from "../../server/desk/project.ts";
import { Outbox } from "../../server/runtime/outbox.ts";
import { STATE_BACKUP, upgradeState } from "../../server/upkeep/state.ts";
import { tempDir } from "../tempdir.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "state");
const NOW = Date.parse("2026-09-22T07:12:30Z");

function machineAt(version: string): { root: string; shop: string } {
  const root = tempDir("sw2-state-");
  cpSync(join(FIXTURES, version), root, { recursive: true });
  return { root, shop: join(root, "projects", "shop-abc123") };
}

/** A fixture read as this version reads it, since an older one is refused until carried. */
function carriedTo(version: string) {
  const { root, shop } = machineAt(version);
  upgradeState(root, undefined, undefined, NOW);
  return loadLedger(shop);
}

test("the fixture of the current format exists, so the next change to a kept file has one to be carried from", () => {
  assert.ok(existsSync(join(FIXTURES, `v${STATE_VERSION}`)), `test/fixtures/state/v${STATE_VERSION} is missing`);
});

for (const version of readdirSync(FIXTURES).filter((name) => /^v\d+$/.test(name))) {
  test(`what was kept in state format ${version.slice(1)} is carried to this version and read in full`, () => {
    const { root, shop } = machineAt(version);
    const from = Number(version.slice(1));
    const report = upgradeState(root, undefined, undefined, NOW);
    assert.deepEqual(report.failed, []);
    assert.deepEqual(report.upgraded, from === STATE_VERSION ? [] : [`machine: ${from} → ${STATE_VERSION}`, `shop-abc123: ${from} → ${STATE_VERSION}`]);
    assert.equal(readJson<{ version?: number }>(join(root, "state.json"), {}).version, STATE_VERSION, "the machine now carries this version's number");
    assert.equal(readJson<{ version?: number }>(join(shop, "ledger.json"), {}).version, STATE_VERSION, "and so does the ledger");
    assert.deepEqual(readdirSync(shop).filter((name) => STATE_BACKUP.test(name)), from === STATE_VERSION ? [] : [`backup-state-${from}-20260922-071230`], "a copy of what was there is kept before anything moves");
    assert.deepEqual(upgradeState(root, undefined, undefined, NOW), { upgraded: [], failed: [] }, "and a second start carries nothing again");

    assert.equal(ledgerFault(shop), undefined);
    const ledger = loadLedger(shop);
    assert.deepEqual([Object.keys(ledger.lanes), Object.keys(ledger.asks)], [["L1"], ["A1"]]);
    assert.equal(ledger.tasks["L1-T1"]!.status, "merged", "the task every format has, whatever later formats add beside it");
    assert.equal(ledger.tasks["L1-T1"]!.handback?.summary, "Tax added");
    assert.equal(ledger.asks.A1!.answer, "Round half up.");
    assert.deepEqual(Object.keys(loadIncidents(shop).items), ["I1"]);
    assert.equal(loadConfig(shop).gate, "npm test");
    assert.deepEqual(new Outbox(join(root, "outbox.json"), () => "", {} as never).letters().map((letter) => letter.key), ["handback:L1-T1"]);
    assert.equal(readLayer(join(root, "settings.json"), MachineLayerSchema).status, "ready");
    assert.equal(readLayer(join(shop, "settings.json"), ProjectLayerSchema).status, "ready");
  });
}

// Format 4 takes in upstream's formats 2 to 4 at once; 2 and 3 here are this fork's machine-file steps.
test("a lane carried on the Human's branch, its landing and what it was asked before an amendment read back from format 4, and a lane from before has none of them", () => {
  const lane = carriedTo("v4").lanes.L1!;
  assert.deepEqual([lane.onBranch, lane.branch, lane.base], [true, "fix/totals", "fix/totals"]);
  assert.equal(lane.landed, true);
  assert.deepEqual(lane.amended?.map((entry) => [entry.by, entry.was]), [["agent-sup-1", { acceptance: ["tax shown"] }]]);
  const before = carriedTo("v3").lanes.L1!;
  assert.deepEqual([before.onBranch, before.landed, before.amended], [undefined, undefined, undefined], "a lane from format 3 is the lane branch it always was");
});

test("a task that waited, and why it was held, read back from format 4, and a task from before has neither", () => {
  const waited = carriedTo("v4").tasks["L1-T2"]!;
  assert.deepEqual([waited.after, waited.opening?.role, waited.held?.tried], [["L1-T1"], "peer", true]);
  const before = carriedTo("v3").tasks["L1-T1"]!;
  assert.deepEqual([before.after, before.opening, before.held], [undefined, undefined, undefined]);
});

test("a project's plan check and a lane's count of plans read back from format 5, and a project from before chose neither", () => {
  const { root, shop } = machineAt("v5");
  upgradeState(root, undefined, undefined, NOW);
  assert.equal(loadLedger(shop).lanes.L1!.plans, 1);
  assert.deepEqual(readLayer(join(shop, "settings.json"), ProjectLayerSchema), { status: "ready", values: { rules: "Answer in English.", checkpoints: { plan: "on" } }, revision: readLayer(join(shop, "settings.json"), ProjectLayerSchema).revision });
  assert.equal(carriedTo("v4").lanes.L1!.plans, undefined);
});

test("a plan held for the Human, who approves plans, and which plan a task came from read back from format 6", () => {
  const { root, shop } = machineAt("v6");
  upgradeState(root, undefined, undefined, NOW);
  const ledger = loadLedger(shop);
  assert.deepEqual([ledger.lanes.L1!.approval?.plan, ledger.lanes.L1!.approval?.by, ledger.tasks["L1-T2"]!.plan], [2, "human", 1]);
  const layer = readLayer(join(shop, "settings.json"), ProjectLayerSchema);
  assert.deepEqual(layer.status === "ready" ? layer.values.checkpoints : undefined, { plan: "on", approve: "risky", approver: "human" });
  assert.equal(carriedTo("v5").lanes.L1!.approval, undefined);
});

test("how a project's lanes land reads back from format 7, and a project from before lands squashed", () => {
  const { root, shop } = machineAt("v7");
  upgradeState(root, undefined, undefined, NOW);
  assert.equal(loadConfig(shop).landAs, "merge");
  const before = machineAt("v6");
  upgradeState(before.root, undefined, undefined, NOW);
  assert.equal(loadConfig(before.shop).landAs, "squash");
});

test("a landing held for the Human and a project's land check read back from format 8", () => {
  const { root, shop } = machineAt("v8");
  upgradeState(root, undefined, undefined, NOW);
  assert.deepEqual(loadLedger(shop).lanes.L1!.landApproval?.signals, ["db/migrations/002_cart.sql is a path this project counts as risky."]);
  const layer = readLayer(join(shop, "settings.json"), ProjectLayerSchema);
  const checks = layer.status === "ready" ? layer.values.checkpoints : undefined;
  assert.deepEqual([checks?.land, checks?.landApprove, checks?.landLines], ["on", "risky", 800]);
  assert.equal(carriedTo("v7").lanes.L1!.landApproval, undefined);
});

test("a project's Critic setting reads back from format 9", () => {
  const { root, shop } = machineAt("v9");
  upgradeState(root, undefined, undefined, NOW);
  const layer = readLayer(join(shop, "settings.json"), ProjectLayerSchema);
  assert.deepEqual(layer.status === "ready" ? layer.values.critic : undefined, { by: "off" });
});

test("when a lane was last reported ready reads back from format 10", () => {
  const { root, shop } = machineAt("v10");
  upgradeState(root, undefined, undefined, NOW);
  assert.deepEqual(loadLedger(shop).lanes.L1!.ready, { at: 1790000000000 });
  assert.equal(carriedTo("v9").lanes.L1!.ready, undefined);
});

test("a step carries every project and the machine, keeps a copy of the files first, and runs once", () => {
  const { root, shop } = machineAt("v1");
  const steps = [
    {
      to: 2,
      project: (state: string) => {
        const ledger = readJson<{ lanes: Record<string, { title: string }> }>(join(state, "ledger.json"), { lanes: {} });
        for (const lane of Object.values(ledger.lanes)) Object.assign(lane, { name: lane.title });
        writeJson(join(state, "ledger.json"), ledger);
      },
    },
  ];
  const report = upgradeState(root, steps, 2, NOW);
  assert.deepEqual(report, { upgraded: ["machine: 1 → 2", "shop-abc123: 1 → 2"], failed: [] });
  const ledger = readJson<{ version: number; lanes: Record<string, { name?: string }> }>(join(shop, "ledger.json"), { version: 0, lanes: {} });
  assert.deepEqual([ledger.version, ledger.lanes.L1?.name], [2, "Checkout totals"]);
  assert.equal(readJson<{ version: number }>(join(root, "state.json"), { version: 0 }).version, 2);
  const backup = readdirSync(shop).filter((name) => STATE_BACKUP.test(name));
  assert.deepEqual(backup, ["backup-state-1-20260922-071230"]);
  assert.equal(JSON.parse(readFileSync(join(shop, backup[0]!, "ledger.json"), "utf-8")).version, 1);
  assert.deepEqual(upgradeState(root, steps, 2, NOW), { upgraded: [], failed: [] });
});

test("a step that fails puts the project's files back as they were, and says why", () => {
  const { root, shop } = machineAt("v1");
  const before = readFileSync(join(shop, "ledger.json"), "utf-8");
  const steps = [
    {
      to: 2,
      project: (state: string) => {
        writeJson(join(state, "ledger.json"), { half: "written" });
        throw new Error("lane L1 has no title");
      },
    },
  ];
  const report = upgradeState(root, steps, 2, NOW);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0]!.error, /could not go from state 1 to 2: lane L1 has no title/);
  assert.equal(readFileSync(join(shop, "ledger.json"), "utf-8"), before);
});

test("state a newer version made is refused, not read", () => {
  const { root, shop } = machineAt("v1");
  writeJson(join(shop, "ledger.json"), { ...readJson<object>(join(shop, "ledger.json"), {}), version: STATE_VERSION + 1 });
  assert.match(upgradeState(root, undefined, undefined, NOW).failed[0]!.error, /made by a newer Seatworks/);
  assert.match(ledgerFault(shop) ?? "", /made by a newer Seatworks/);
});

test("profile visibility migration preserves existing model choices and defaults to all profiles enabled", () => {
  const { root } = machineAt("v2");
  const before = readJson<Record<string, unknown>>(join(root, "settings.json"), {});
  assert.deepEqual(upgradeState(root, undefined, undefined, NOW).failed, []);
  const after = readJson<Record<string, unknown>>(join(root, "settings.json"), {});
  assert.deepEqual(after, { ...before, profiles: { disabled: [] } });
  assert.deepEqual(readJson(join(root, "backup-state-2-20260922-071230", "settings.json"), {}), before);
  assert.equal(ProjectLayerSchema.safeParse({ profiles: { disabled: [] } }).success, false, "a project cannot control machine-wide launch profiles");
});
