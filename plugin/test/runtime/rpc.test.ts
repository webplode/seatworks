// First, so this file has a HOME of its own even run alone: what it writes under HOME would otherwise land in the owner's.
import "../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import contribute from "../../index.server.ts";
import { pluginDir, stateRoot } from "../../server/core/paths.ts";
import { contracts } from "../../shared/rpc.ts";
import { KEPT } from "../../shared/settings.ts";
import { reported } from "../console.ts";
import { tempDir } from "../tempdir.ts";
import { fakeConfig } from "./fake-paseo.ts";
import { daemon, served, which } from "./served.ts";

/** A project on record as the desk keeps one, so its own settings layer can be read and saved. */
function onRecord(slug: string, root: string): void {
  const state = join(stateRoot(), "projects", slug);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "meta.json"), JSON.stringify({ root, slug }));
}

test("every contract the panel calls is served, the first call brings the daemon handle, and the catalog and team read as the panel shows them", async () => {
  const { call, host, handlers } = served({ handle: "the daemon" });
  assert.equal(host.connected(), false, "nothing has called in yet");
  const catalog = await call(contracts.catalog, {});
  assert.equal(host.connected(), true, "a settings save reloads the daemon, so a panel call must bring its handle");
  assert.deepEqual(
    Object.values(contracts)
      .map((contract) => contract.name)
      .filter((name) => !handlers.has(name)),
    [],
    "every contract the panel calls has a handler",
  );
  const harnesses = (id: string) => catalog.roles.find((role) => role.id === id)!.harnesses;
  assert.deepEqual(
    [harnesses("lead"), harnesses("scribe")],
    [
      ["claude", "omp"],
      ["claude", "omp"],
    ],
  );
  assert.deepEqual(
    catalog.mcp.map((entry) => entry.id),
    ["ide", "docs"],
    "in the order the kit gives them",
  );
  const nowhere = await call(contracts.team, { project: "nowhere-000000" });
  assert.match(
    which(nowhere, "error").error,
    /No project named nowhere-000000/,
    "a refusal, not a team missing its roles",
  );
});

test("the plugin finds its own directory where Paseo's home is, and one that cannot find it still answers every panel call, with why", async (t) => {
  const given = process.env.PASEO_HOME;
  t.after(() => {
    if (given === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = given;
  });
  const moved = tempDir("sw3-paseo-home-");
  process.env.PASEO_HOME = moved;
  writeFileSync(
    join(moved, "config.json"),
    JSON.stringify({ plugins: { "seatworks-v3": { source: "directory", path: "/kit" } } }),
  );
  assert.equal(pluginDir(), "/kit", "Paseo's home is where PASEO_HOME says, when the daemon was given one");

  writeFileSync(join(moved, "config.json"), "{}\n");
  const said = reported(t);
  const handlers = new Map<string, () => unknown>();
  const server = {
    handle: (contract: { name: string }, handler: () => unknown) => void handlers.set(contract.name, handler),
  };
  const cleanup = contribute(server as never);
  assert.equal(typeof cleanup, "function");
  assert.deepEqual(
    Object.values(contracts)
      .map((contract) => contract.name)
      .filter((name) => !handlers.has(name)),
    [],
    "every panel call is still served, rather than none and the panel left guessing",
  );
  const why = (text: string) => text.includes(join(moved, "config.json")) && text.includes("plugins.seatworks-v3");
  await assert.rejects(
    async () => handlers.get(contracts.projects.name)!(),
    (error: Error) => why(error.message),
    "each answers with where the plugin looked for its directory",
  );
  assert.ok(why(said()), "and the daemon log says the same");
});

test("settings: machine and project layers saved by revision, checked before saving, keys never read back, a broken file never quoted", async () => {
  const { call } = served();
  const team = async (project?: string) => which(await call(contracts.team, { project }), "roles");
  const read = which(await call(contracts.settingsRead, {}), "values");
  const saved = await call(contracts.settingsWrite, {
    revision: read.revision,
    values: { mcp: { docs: { enabled: true } } },
  });
  assert.equal(saved.status, "saved", JSON.stringify(saved));
  const machine = await team();
  assert.deepEqual(machine.roles.lead!.mcp, ["ide", "docs"], "a server turned on for the machine");
  assert.match(machine.roles.lead!.rules, /Look library APIs up in the docs\./);
  assert.equal(machine.roles.lead!.provider, "sw3-lead-claude");
  onRecord("shop-abc123", "/work/shop");
  assert.deepEqual(await call(contracts.projects, {}), [{ slug: "shop-abc123", root: "/work/shop" }]);
  const projectRead = which(await call(contracts.settingsRead, { project: "shop-abc123" }), "values");
  assert.deepEqual(
    projectRead.machine,
    { mcp: { docs: { enabled: true } } },
    "a project's screen shows the layer under it",
  );
  const layer = { roles: { lead: { harness: "omp" } }, mcp: { ide: { enabled: false } } };
  const projectSaved = await call(contracts.settingsWrite, {
    project: "shop-abc123",
    revision: projectRead.revision,
    values: layer,
  });
  assert.equal(projectSaved.status, "saved");
  const shop = await team("shop-abc123");
  assert.deepEqual(
    [shop.roles.lead!.harness, shop.roles.lead!.provider, shop.roles.lead!.mcp],
    ["omp", "sw3-lead-omp", ["docs"]],
  );
  assert.match(shop.roles.lead!.rules, /Look library APIs up in the docs\./);
  assert.equal((await team()).roles.lead!.harness, "claude", "a role's harness switched for one project only");
  assert.match((await call(contracts.status, { project: "shop-abc123" })).text, /No open lanes\./);

  const current = which(await call(contracts.settingsRead, {}), "values");
  const refused = await call(contracts.settingsWrite, {
    revision: current.revision,
    values: { roles: { supervisor: { harness: "omp" } } },
  });
  assert.match(which(refused, "error").error, /Oh My Pi has no supervisor settings/, "settings a team can't run on");
  assert.equal(refused.status, "invalid");
  assert.equal(
    (await call(contracts.settingsWrite, { revision: current.revision, values: { rules: "one" } })).status,
    "saved",
  );
  const stale = await call(contracts.settingsWrite, { revision: current.revision, values: { rules: "two" } });
  assert.equal(stale.status, "conflict", "a stale write conflicts");
  assert.equal((await call(contracts.settingsRead, { project: "nowhere" })).status, "invalid");

  const file = join(stateRoot(), "settings.json");
  const before = which(await call(contracts.settingsRead, {}), "values");
  const secret = "a-key-kept-on-this-machine";
  const keyed = await call(contracts.settingsWrite, {
    revision: before.revision,
    values: { sensor: { jev: { key: secret } } },
  });
  assert.deepEqual(
    which(keyed, "values").values.sensor,
    { jev: { key: KEPT } },
    "a sensor's key is saved but never read back",
  );
  const shown = which(await call(contracts.settingsRead, {}), "values");
  assert.equal(shown.values.sensor!.jev!.key, KEPT);
  const project = which(await call(contracts.settingsRead, { project: "shop-abc123" }), "values");
  assert.equal(project.machine.sensor!.jev!.key, KEPT, "a project's screen shows the machine layer's key as KEPT");
  assert.doesNotMatch(JSON.stringify([shown, project, await call(contracts.team, {})]), /kept-on-this-machine/);
  const again = await call(contracts.settingsWrite, {
    revision: shown.revision,
    values: { ...shown.values, rules: "keep it small" },
  });
  assert.match(readFileSync(file, "utf-8"), /kept-on-this-machine/, "KEPT saved back keeps the key");
  await call(contracts.settingsWrite, {
    revision: which(again, "revision").revision,
    values: { rules: "keep it small" },
  });
  assert.doesNotMatch(readFileSync(file, "utf-8"), /kept-on-this-machine/, "a save without it removes it");

  const judged = which(await call(contracts.settingsRead, {}), "values");
  const oracle = await call(contracts.settingsWrite, {
    revision: judged.revision,
    values: { attention: { brain: "sensor", sensor: "oracle" } },
  });
  assert.match(which(oracle, "error").error, /The watch's sensor is oracle, which is no sensor the kit knows \(none\)/);
  const off = await call(contracts.settingsWrite, {
    revision: judged.revision,
    values: { attention: { brain: "off" } },
  });
  assert.equal(off.status, "saved");

  const notes = { type: "stdio" as const, command: ["npx", "notes-mcp"] };
  const pasted = {
    mcp: {
      notes: { enabled: true, label: "Notes", connect: notes, roles: ["lead"], rule: "Look things up in the notes." },
      ide: { removed: true },
    },
  };
  const withNotes = await call(contracts.settingsWrite, { revision: which(off, "revision").revision, values: pasted });
  assert.equal(withNotes.status, "saved", JSON.stringify(withNotes));
  const noted = await team();
  assert.equal(noted.mcp.ide, undefined, "a shipped server can be removed");
  assert.deepEqual(
    [noted.mcp.notes!.template, noted.mcp.notes!.connect],
    [false, notes],
    "a pasted server reaches the seats",
  );
  assert.deepEqual(noted.roles.lead!.mcp, ["notes"]);
  assert.match(noted.roles.lead!.rules, /Look things up in the notes\./);

  // A pasted server's token in a common hand typo, whose parse error quotes the line: short enough to fall inside V8's quoted window.
  writeFileSync(file, '{ "rules": "keep it small", "headers": { "Authorization": \'SEKRIT\' } }');
  const unread = which(await call(contracts.team, {}), "roles");
  const checks = await call(contracts.doctor, {});
  const screens = [
    await call(contracts.settingsRead, {}),
    await call(contracts.settingsWrite, { revision: judged.revision, values: { rules: "x" } }),
    unread,
    checks,
  ];
  for (const answer of screens) {
    assert.match(
      JSON.stringify(answer),
      /is not JSON|could not be read|not being used/,
      "each screen says it cannot be read",
    );
    assert.doesNotMatch(JSON.stringify(answer), /SEKRIT/, "and none of them quotes the file back");
  }
  assert.ok(
    unread.errors.some((line) => line.includes("machine settings are not being used")),
    JSON.stringify(unread.errors),
  );
  assert.equal(
    unread.rules,
    "",
    "a file nobody could read is not a team its owner wrote: none of its rules are in force",
  );
  assert.equal(checks.find((check) => check.id === "settings")!.ok, false, "the doctor reports an unreadable layer");
});

test("the panel's Refresh lists each agent's models through its built-in provider, in the state root alone, no other panel call asks Paseo for any, and a changed list reaches the providers", async () => {
  const listed = (provider: string) =>
    provider === "claude" ? { models: [{ id: "opus", label: "Opus 5" }] } : { models: [{ id: "glm", label: "GLM" }] };
  const paseo = daemon(fakeConfig(), [], listed);
  const { call, providers } = served(paseo);
  const root = realpathSync(tempDir("sw3-rpc-models-"));
  which(await call(contracts.projectsAdd, { root }), "slug");
  await call(contracts.catalog, {});
  assert.equal(paseo.asked.length, 0, "only the Human's Refresh sends Paseo to its agents: each ask probes them");
  const refreshed = await call(contracts.models, {});
  assert.deepEqual(
    Object.entries(refreshed).map(([id, entry]) => [id, entry.count, entry.error]),
    [
      ["claude", 1, null],
      ["omp", 1, null],
    ],
  );
  assert.deepEqual(
    [...new Set(paseo.asked.map((ask) => `${ask.kind} ${ask.provider} ${ask.cwd}`))].sort(),
    ["list", "refresh"].flatMap((kind) => [`${kind} claude ${stateRoot()}`, `${kind} omp ${stateRoot()}`]),
    "an agent's own provider answers for it, so listing needs no provider of the kit's",
  );
  assert.deepEqual(
    (await providers())["sw3-lead-claude"]?.additionalModels,
    [{ id: "opus", label: "Opus 5", isDefault: true }],
    "a changed list reaches the providers of the attached projects' seats",
  );
});

test("a pasted server is understood whatever dialect it is written in", async () => {
  const { call } = served();
  const parse = async (value: unknown) =>
    call(contracts.mcpParse, { text: typeof value === "string" ? value : JSON.stringify(value) });
  const context7 = ["npx", "-y", "@upstash/context7-mcp", "--api-key", "KEY"];
  const nested = which(
    await parse({ mcp: { context7: { type: "local", command: context7, enabled: true } } }),
    "connect",
  );
  assert.deepEqual([nested.id, nested.connect], ["context7", { type: "stdio", command: context7 }]);
  const claude = which(
    await parse({ mcpServers: { docs: { command: "npx", args: ["docs-mcp"], env: { TOKEN: "x" } } } }),
    "connect",
  );
  assert.deepEqual(
    [claude.id, claude.connect],
    ["docs", { type: "stdio", command: ["npx", "docs-mcp"], env: { TOKEN: "x" } }],
  );
  const headers = { Authorization: "Bearer x" };
  const remote = which(await parse({ type: "remote", url: "https://mcp.example/mcp", headers }), "connect");
  assert.deepEqual(remote.connect, { type: "http", url: "https://mcp.example/mcp", headers });
  // A README writes a port as a number; dropping its table also lost the token beside it.
  const readme = {
    mcpServers: { db: { command: "npx", args: ["db-mcp", 8080], env: { PORT: 5432, DEBUG: false, TOKEN: "keep me" } } },
  };
  assert.deepEqual(which(await parse(readme), "connect").connect, {
    type: "stdio",
    command: ["npx", "db-mcp", "8080"],
    env: { PORT: "5432", DEBUG: "false", TOKEN: "keep me" },
  });
  assert.match(which(await parse("not json"), "error").error, /not JSON/);
  assert.match(which(await parse({ type: "local" }), "error").error, /needs a command/);
  assert.match(
    which(await parse({ command: "npx", env: { KEY: { from: "keychain" } } }), "error").error,
    /env gives KEY/,
    "what has no text form is named, not dropped",
  );
});
