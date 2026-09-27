import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { KEEP_CLOSED_LANES } from "../../server/desk/store/archive.ts";
import { projectOf } from "../../server/desk/project/project.ts";
import { contracts } from "../../shared/rpc.ts";
import { harness, repo } from "./harness.ts";

const scope = { acceptance: ["a"], outOfScope: ["anything else in the repository"] };

test("two projects on one daemon keep their own settings, task ids and letters", async () => {
  const h = harness();
  const second = repo().root;
  const other = projectOf(second);
  const open = async (where: string, name: string) => {
    const sup = h.add("sw3-supervisor-claude/claude-opus-5", where, name);
    const lane = { title: "Numbers", outcome: "a.txt gains words", ...scope };
    await h.call(sup, "supervisor", "open_lane", lane, where);
    return h.ledger(where === h.root ? undefined : other).lanes.L1!;
  };
  const add = (lane: { lead?: string }, where: string, extra: Record<string, unknown>) =>
    h.call(
      lane.lead!,
      "lead",
      "add_tasks",
      { tasks: [{ key: "t", title: "Add", goal: "g", ...scope, ...extra }] },
      where,
    );
  const provider = (task: { peer?: string }) => h.agents.get(task.peer!)!.provider;
  const here = await open(h.root, "sup-a");
  await add(here, h.root, { hints: ["a.txt"] });
  assert.equal(provider(h.ledger().tasks["L1-T1"]!), "sw3-peer-claude/claude-opus-5");
  assert.equal(h.agents.get(here.lead!)!.provider, "sw3-lead-claude/claude-opus-5");
  const shown = await h.rpc(contracts.settingsRead, { project: h.project.slug });
  const values = { roles: { peer: { harness: "pi", model: "glm-5" } } };
  const saved = await h.rpc(contracts.settingsWrite, { project: h.project.slug, revision: shown.revision, values });
  assert.equal(saved.status, "saved", JSON.stringify(saved));
  await add(here, h.root, { holds: ["b.txt"], parallel: true });
  assert.equal(provider(h.ledger().tasks["L1-T2"]!), "sw3-peer-pi/glm-5");
  assert.equal(h.agents.get(here.lead!)!.provider, "sw3-lead-claude/claude-opus-5");

  const there = await open(second, "sup-b");
  await add(there, second, { hints: ["a.txt"] });
  const [mine, theirs] = [h.ledger().tasks["L1-T1"]!, h.ledger(other).tasks["L1-T1"]!];
  assert.equal(provider(theirs), "sw3-peer-claude/claude-opus-5");
  for (const task of [mine, theirs]) h.agents.get(task.peer!)!.archivedAt = new Date().toISOString();
  await h.tick(Date.now());
  await h.idle(here.lead!);
  await h.idle(there.lead!);
  for (const lane of [here, there]) assert.match(h.agents.get(lane.lead!)!.sent.join("\n"), /the Peer on L1-T1/);
  assert.equal(h.ledger(other).tasks["L1-T1"]!.status, "stalled");
});

test("attaching a project again with a new Seatworks block tells whoever supervises it to have AGENTS.md committed", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const agents = join(h.root, "AGENTS.md");
  const older = readFileSync(agents, "utf-8").replace(
    /(seatworks:begin[^\n]*\n)[^]*?(<!-- seatworks:end)/,
    "$1An older block.\n$2",
  );
  writeFileSync(agents, older);
  h.git(h.root, "commit", "-qam", "an older kit's block");
  const added = await h.rpc(contracts.projectsAdd, { root: h.root });
  assert.ok("slug" in added);
  assert.equal(added.note, "The Seatworks block changed in AGENTS.md; commit it.");
  assert.ok(
    h.heard(sup).some((text) => text.startsWith(`BLOCK CHANGED in ${join(added.root, "AGENTS.md")}: the desk wrote`)),
    "uncommitted, it stops a lane working in the Human's own copy from landing, which is whoever supervises' to see to",
  );
  await h.rpc(contracts.projectsAdd, { root: h.root });
  assert.equal(h.heard(sup).join("\n").split("BLOCK CHANGED").length, 2, "attached again unchanged, nobody is told");
});

test("a ledger the desk cannot read is not written over, and the seat is told why", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Real work", outcome: "x", ...scope });
  assert.ok(h.ledger().lanes.L1);
  const file = join(h.project.state, "ledger.json");
  const { seq: _seq, ...unnumbered } = h.ledger();
  const kept = '{ "lanes": ';
  writeFileSync(file, kept);
  const refused = await h.call(sup, "supervisor", "open_lane", { title: "After", outcome: "y", ...scope });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /could not be read/);
  assert.equal(readFileSync(file, "utf-8"), kept);
  const status = await h.call(sup, "supervisor", "status", {});
  assert.equal(status.ok, false);
  assert.match(status.text, /could not be read/);
  assert.doesNotMatch(status.text, /No open lanes/);

  const half = JSON.stringify(unnumbered);
  writeFileSync(file, half);
  assert.equal(
    (await h.call(sup, "supervisor", "open_lane", { title: "Over", outcome: "z", isolate: true, ...scope })).ok,
    false,
    "one that parses but lacks its numbering is refused too, never read as counting from nothing and L1 written over",
  );
  assert.equal(readFileSync(file, "utf-8"), half);
});

test("the round keeps only what the desk still holds: an orphan copy goes, the project's workspace goes once quiet, a project removed stays removed, and none is detached while a seat works in it", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Quiet", outcome: "a.txt changes", ...scope });
  const lane = h.ledger().lanes.L1!;
  const paseo = h.paseo as {
    workspaces: {
      create: (options: { title: string; source: { kind: string; path: string } }) => Promise<{ id: string }>;
    };
  };
  const orphan = await paseo.workspaces.create({
    title: `${h.project.slug} S9`,
    source: { kind: "directory", path: h.root },
  });
  const own = [...h.workspaceNames.entries()].find(([, name]) => name === h.project.slug)![0];
  assert.equal(h.archivedWorkspaces.has(orphan.id), false);
  await h.tick(Date.now());
  assert.equal(h.archivedWorkspaces.has(orphan.id), true);
  assert.equal(h.archivedWorkspaces.has(own), false);
  assert.ok(existsSync(join(h.project.state, "status.md")));

  await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "done" });
  h.agents.get(lane.lead!)!.archivedAt = new Date().toISOString();
  assert.deepEqual(await h.rpc(contracts.projectsRemove, { project: h.project.slug }), {
    error: `${h.project.slug} stays: 1 seat is still working in it (${sup}): archive it first, since a working seat puts the project back on record.`,
  });
  h.agents.get(sup)!.archivedAt = new Date().toISOString();
  await h.tick(Date.now());
  assert.equal(h.archivedWorkspaces.has(own), true);
  rmSync(h.project.state, { recursive: true, force: true });
  await h.tick(Date.now());
  assert.equal(existsSync(h.project.state), false);
});

test("a round files the finished lanes past the newest few into the archive, with their records", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const open = (title: string, extra: Record<string, unknown>) =>
    h.call(sup, "supervisor", "open_lane", { title, outcome: "x", ...scope, ...extra });
  await h.call(sup, "supervisor", "set_project", { gate: "echo gate ran", gateOn: "lane" });
  await open("Oldest", { isolate: true });
  const oldest = h.ledger().lanes.L1!;
  await h.call(oldest.lead!, "lead", "report", { summary: "done", ready: true });
  const gates = join(h.project.state, "gates");
  const logs = () => readdirSync(gates).filter((name) => name.startsWith("L1-"));
  assert.equal(logs().length, 1);
  Object.assign(h.agents.get(oldest.lead!)!, { archivedAt: new Date().toISOString(), status: "closed" });
  await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "no longer wanted" });
  await open("Anchor", { isolate: true });
  for (let n = 1; n <= KEEP_CLOSED_LANES; n++) {
    await open(`Waited ${n}`, { after: ["L2"] });
    await h.call(sup, "supervisor", "drop_lane", { lane: `L${n + 2}`, reason: "no longer wanted" });
  }
  await h.tick(Date.now());
  const lanes = h.ledger().lanes;
  assert.equal(lanes.L1, undefined);
  assert.equal(Object.values(lanes).filter((entry) => entry.status === "closed").length, KEEP_CLOSED_LANES);
  const filed = gunzipSync(readFileSync(join(h.project.state, "archive", "L1.json.gz"))).toString("utf-8");
  assert.match(filed, /"id":"L1"/);
  assert.match(filed, /gate ran/);
  assert.deepEqual(logs(), []);
});
