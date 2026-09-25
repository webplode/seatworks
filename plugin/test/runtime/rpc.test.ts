import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "sw2-rpc-home-"));
process.env.HOME = HOME;

const { Runtime } = await import("../../server/runtime/runtime.ts");
const { registerRpc } = await import("../../server/runtime/rpc.ts");
const { makeKit } = await import("../kit.ts");
const { KEPT } = await import("../../shared/rpc.ts");
const { STATE_VERSION } = await import("../../server/core/state.ts");

function served(paseo?: unknown, folders?: (query: string) => Promise<string[]>) {
  const kit = makeKit();
  const runtime = new Runtime(kit, { outboxFile: join(HOME, "outbox.json"), reloadDaemon: async () => true, folders });
  const handlers = new Map<string, (input: any) => any>();
  const bound: unknown[] = [];
  // The host hands every handler the live daemon handle beside the input.
  const names = registerRpc(
    {
      handle: (contract: { name: string; input: { parse(value: unknown): unknown } }, handler: (input: unknown, context: { paseo: unknown }) => unknown) =>
        handlers.set(contract.name, (input) => handler(contract.input.parse(input), { paseo })),
    },
    runtime.control,
    (api) => bound.push(api),
  );
  const call = async (name: string, input: unknown = {}) => {
    const handler = handlers.get(name);
    assert.ok(handler, `no handler for ${name}`);
    return JSON.parse(JSON.stringify(await handler(input)));
  };
  return { kit, runtime, names, call, bound };
}

/** A daemon with no seats at all, so detaching a project can see that nothing works in it. */
function noSeats(runtime: unknown): void {
  (runtime as { api: unknown }).api = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
}

test("explicit model discovery registers and reloads role providers before querying a fresh daemon", async () => {
  mkdirSync(join(HOME, ".paseo"), { recursive: true });
  writeFileSync(join(HOME, ".paseo", "config.json"), "{}");
  let loaded = false;
  const runtime = new Runtime(makeKit(), { reloadDaemon: async () => {
    const config = JSON.parse(readFileSync(join(HOME, ".paseo", "config.json"), "utf8"));
    assert.ok(config.agents.providers["sw2-supervisor-claude"]);
    await Promise.resolve(); loaded = true; return true;
  }, paseo: { providers: {
    async refresh() { assert.equal(loaded, true, "provider discovery must wait for configuration reload"); },
    async listModels() { return { models: [{ id: "opus", label: "Opus" }] }; },
  } } as never });
  try { assert.ok((await runtime.refreshModels()).claude!.models.length); }
  finally { runtime.dispose(); }
});

test("the plugin serves the catalog, settings, projects, team and status over RPC", async () => {
  const { names, call } = served();
  assert.deepEqual(names.sort(), [
    "seatworks.catalog.read",
    "seatworks.doctor.run",
    "seatworks.flow.read",
    "seatworks.git.identity",
    "seatworks.land.decide",
    "seatworks.mcp.parse",
    "seatworks.models.refresh",
    "seatworks.paths.find",
    "seatworks.paths.list",
    "seatworks.plan.decide",
    "seatworks.projects.add",
    "seatworks.projects.candidates",
    "seatworks.projects.list",
    "seatworks.projects.remove",
    "seatworks.settings.read",
    "seatworks.settings.write",
    "seatworks.status.read",
    "seatworks.team.read",
    "seatworks.upkeep.clean",
    "seatworks.upkeep.decide",
    "seatworks.upkeep.migrate",
    "seatworks.upkeep.update",
  ]);
  const catalog = await call("seatworks.catalog.read");
  assert.deepEqual(catalog.roles.find((role: any) => role.id === "lead").harnesses, ["claude", "devin"]);
  assert.deepEqual(catalog.roles.find((role: any) => role.id === "scribe").harnesses, ["claude", "devin"]);
  assert.deepEqual(catalog.mcp.map((entry: any) => [entry.id, entry.transport]), [["ide", "stdio"], ["docs", "http"]]);
});

test("the daemon handle a panel call arrives with is kept, not thrown away", async () => {
  // Only its identity is read, so it is a marker, not a shaped daemon.
  const paseo = { handle: "the daemon" };
  const { call, bound } = served(paseo);
  assert.deepEqual(bound, [], "nothing has called in yet");

  // A settings save reloads the daemon; bound only from lifecycle hooks, the desk had no handle until the next seat.
  await call("seatworks.catalog.read");
  assert.deepEqual(bound, [paseo], "the one handle the runtime was missing came in with the call");
});

test("a web app turns a server on for the machine and switches a role's harness for one project", async () => {
  const { call } = served();
  const read = await call("seatworks.settings.read");
  assert.equal(read.status, "ready");
  const saved = await call("seatworks.settings.write", { revision: read.revision, values: { mcp: { docs: { enabled: true } } } });
  assert.equal(saved.status, "saved");
  let team = await call("seatworks.team.read");
  assert.deepEqual(team.roles.lead.mcp, ["ide", "docs"]);
  assert.match(team.roles.lead.rules, /Look library APIs up in the docs\./);
  assert.equal(team.roles.lead.provider, "sw2-lead-claude");

  const state = join(HOME, ".local/share/seatworks-v2/projects/shop-abc123");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "meta.json"), JSON.stringify({ root: "/work/shop", slug: "shop-abc123" }));
  assert.deepEqual(await call("seatworks.projects.list"), [{ slug: "shop-abc123", root: "/work/shop" }]);
  const projectRead = await call("seatworks.settings.read", { project: "shop-abc123" });
  assert.deepEqual(projectRead.machine, { mcp: { docs: { enabled: true } } });
  const projectSaved = await call("seatworks.settings.write", { project: "shop-abc123", revision: projectRead.revision, values: { roles: { lead: { harness: "devin" } }, mcp: { ide: { enabled: false } } } });
  assert.equal(projectSaved.status, "saved");
  team = await call("seatworks.team.read", { project: "shop-abc123" });
  assert.equal(team.roles.lead.harness, "devin");
  assert.equal(team.roles.lead.provider, "sw2-lead-devin");
  assert.deepEqual(team.roles.lead.mcp, ["docs"]);
  assert.match(team.roles.lead.rules, /List a server's tools once/);
  assert.equal((await call("seatworks.team.read")).roles.lead.harness, "claude");
  await assert.rejects(call("seatworks.status.read", { project: "shop-abc123" }), /coverage is unknown/);
});

test("settings a team can't run on are refused with the reason, and stale writes conflict", async () => {
  const { call } = served();
  const read = await call("seatworks.settings.read");
  const refused = await call("seatworks.settings.write", { revision: read.revision, values: { roles: { supervisor: { harness: "devin" } } } });
  assert.equal(refused.status, "invalid");
  assert.match(refused.error, /Devin CLI has no supervisor settings/);
  assert.equal((await call("seatworks.settings.write", { revision: read.revision, values: { rules: "one" } })).status, "saved");
  assert.equal((await call("seatworks.settings.write", { revision: read.revision, values: { rules: "two" } })).status, "conflict");
  const unknown = await call("seatworks.settings.read", { project: "nowhere" });
  assert.equal(unknown.status, "invalid");
});

test("a project can be registered by its path before any agent has run in it", async () => {
  const { call } = served();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sw2-rpc-project-")));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"), { recursive: true });
  const added = await call("seatworks.projects.add", { root: join(root, "src") });
  assert.equal(added.root, root, "a path inside the project registers the project root");
  assert.ok(added.slug.length > 0);
  const listed = await call("seatworks.projects.list");
  assert.ok(listed.some((entry: { slug: string; root: string }) => entry.slug === added.slug && entry.root === root), JSON.stringify(listed));

  const read = await call("seatworks.settings.read", { project: added.slug });
  assert.equal(read.status, "ready");
  const saved = await call("seatworks.settings.write", { project: added.slug, revision: read.revision, values: { roles: { peer: { harness: "devin" } } } });
  assert.equal(saved.status, "saved");
  assert.equal((await call("seatworks.team.read", { project: added.slug })).roles.peer.harness, "devin");
  const signed = await call("seatworks.git.identity", { project: added.slug, name: " Ana ", email: "ana@example.com" });
  assert.deepEqual([signed.id, signed.ok], ["git:identity", true], "the name and email the team's commits are signed with are set from the screen");
  assert.equal(execFileSync("git", ["-C", root, "config", "--local", "user.name"], { encoding: "utf-8" }).trim(), "Ana", "in this project alone");
  await assert.rejects(call("seatworks.git.identity", { project: added.slug, name: "Ana", email: "not an email" }));

  const missing = await call("seatworks.projects.add", { root: join(root, "nowhere") });
  assert.match(missing.error, /is not a directory/);
});

test("attaching a project is undone by detaching it, unless work is still running in it", async () => {
  const { call, runtime } = served();
  noSeats(runtime);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sw2-rpc-attach-")));
  execFileSync("git", ["init", "-q", root]);
  const added = await call("seatworks.projects.add", { root });
  const read = await call("seatworks.settings.read", { project: added.slug });
  await call("seatworks.settings.write", { project: added.slug, revision: read.revision, values: { roles: { peer: { harness: "devin" } } } });

  const state = join(HOME, ".local/share/seatworks-v2/projects", added.slug);
  writeFileSync(join(state, "ledger.json"), JSON.stringify({ version: STATE_VERSION, lanes: { L1: { id: "L1", status: "open" } }, tasks: {} }));
  const refused = await call("seatworks.projects.remove", { project: added.slug });
  assert.match(refused.error, /1 unfinished piece of work/);
  writeFileSync(join(state, "ledger.json"), JSON.stringify({ version: STATE_VERSION, lanes: { L1: { id: "L1", status: "waiting", after: ["L0"] } }, tasks: {} }));
  assert.match((await call("seatworks.projects.remove", { project: added.slug })).error, /1 unfinished piece of work/, "a lane waiting to open is work still to come");

  // Closed lanes and their cut tasks are provenance that nothing deletes, so they must not count as work.
  writeFileSync(
    join(state, "ledger.json"),
    JSON.stringify({ version: STATE_VERSION, lanes: { L1: { id: "L1", status: "closed" } }, tasks: { "L1-T1": { id: "L1-T1", lane: "L1", status: "cut" } } }),
  );
  assert.deepEqual(await call("seatworks.projects.remove", { project: added.slug }), { removed: added.slug });
  const listed = await call("seatworks.projects.list");
  assert.equal(listed.some((entry: { slug: string }) => entry.slug === added.slug), false);
  assert.match((await call("seatworks.projects.remove", { project: added.slug })).error, /has been seen/);
});

test("the projects a setup screen may offer leave out worktrees, gone directories and the ones already set up", async () => {
  const { call } = served();
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "sw2-rpc-live-")));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const linked = join(realpathSync(mkdtempSync(join(tmpdir(), "sw2-rpc-linked-"))), "wt");
  execFileSync("git", ["worktree", "add", "-q", "-b", "side", linked], { cwd: repo });
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "sw2-rpc-plain-")));
  const ours = join(HOME, ".local/share/seatworks-v2/worktrees/shop-ef484b/S0");
  mkdirSync(ours, { recursive: true });
  const taken = realpathSync(mkdtempSync(join(tmpdir(), "sw2-rpc-taken-")));
  execFileSync("git", ["init", "-q", taken]);
  await call("seatworks.projects.add", { root: taken });

  const roots = [repo, linked, plain, ours, join(repo, "nowhere"), taken];
  assert.deepEqual(await call("seatworks.projects.candidates", { roots }), [repo]);
});

test("a pasted server is understood whatever dialect it is written in", async () => {
  const { call } = served();
  const nested = await call("seatworks.mcp.parse", {
    text: JSON.stringify({ mcp: { context7: { type: "local", command: ["npx", "-y", "@upstash/context7-mcp", "--api-key", "KEY"], enabled: true } } }),
  });
  assert.equal(nested.id, "context7");
  assert.deepEqual(nested.connect, { type: "stdio", command: ["npx", "-y", "@upstash/context7-mcp", "--api-key", "KEY"] });

  const claudeStyle = await call("seatworks.mcp.parse", {
    text: JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["docs-mcp"], env: { TOKEN: "x" } } } }),
  });
  assert.equal(claudeStyle.id, "docs");
  assert.deepEqual(claudeStyle.connect, { type: "stdio", command: ["npx", "docs-mcp"], env: { TOKEN: "x" } });

  const remote = await call("seatworks.mcp.parse", { text: JSON.stringify({ type: "remote", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer x" } }) });
  assert.deepEqual(remote.connect, { type: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer x" } });

  // A README writes a port as a number; dropping its table also lost the token beside it.
  const fromReadme = await call("seatworks.mcp.parse", {
    text: JSON.stringify({ mcpServers: { db: { command: "npx", args: ["db-mcp", 8080], env: { PORT: 5432, DEBUG: false, TOKEN: "keep me" } } } }),
  });
  assert.deepEqual(fromReadme.connect, { type: "stdio", command: ["npx", "db-mcp", "8080"], env: { PORT: "5432", DEBUG: "false", TOKEN: "keep me" } });

  assert.match((await call("seatworks.mcp.parse", { text: "not json" })).error, /not JSON/);
  assert.match((await call("seatworks.mcp.parse", { text: JSON.stringify({ type: "local" }) })).error, /needs a command/);
  assert.match((await call("seatworks.mcp.parse", { text: JSON.stringify({ command: "npx", env: { KEY: { from: "keychain" } } }) })).error, /env gives KEY/, "what has no text form is named, not dropped");
});

test("a server pasted into the settings reaches the seats, and a shipped one can be removed", async () => {
  const { call } = served();
  const read = await call("seatworks.settings.read");
  const saved = await call("seatworks.settings.write", {
    revision: read.revision,
    values: {
      mcp: {
        notes: { enabled: true, label: "Notes", connect: { type: "stdio", command: ["npx", "notes-mcp"] }, roles: ["lead"], rule: "Look things up in the notes." },
        ide: { removed: true },
      },
    },
  });
  assert.equal(saved.status, "saved", JSON.stringify(saved));
  const team = await call("seatworks.team.read");
  assert.equal(team.mcp.ide, undefined, "a removed server is gone from the team");
  assert.equal(team.mcp.notes.template, false);
  assert.deepEqual(team.mcp.notes.connect, { type: "stdio", command: ["npx", "notes-mcp"] });
  assert.deepEqual(team.roles.lead.mcp, ["notes"]);
  assert.match(team.roles.lead.rules, /Look things up in the notes\./);
});

test("a folder that is there and cannot be read is a refusal, not a rejected call", async () => {
  const { call } = served();
  const root = mkdtempSync(join(tmpdir(), "sw2-noread-"));
  mkdirSync(join(root, "locked"));
  chmodSync(join(root, "locked"), 0o000);
  try {
    const answer = await call("seatworks.paths.list", { path: join(root, "locked") });
    assert.match(answer.error ?? "", /could not be read/, "the screen handles a refusal and cannot handle a rejection");
  } finally {
    chmodSync(join(root, "locked"), 0o700);
  }
});

test("a project detached in this session can be attached again, and the desk's half of a second setup keeps the layer", async () => {
  const { call, runtime } = served();
  noSeats(runtime);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sw2-again-")));
  const added = await call("seatworks.projects.add", { root });
  assert.equal(typeof added.slug, "string");

  // What the owner set up: a rule every seat is told, and a pasted server with its token.
  const read = await call("seatworks.settings.read", { project: added.slug });
  const saved = await call("seatworks.settings.write", {
    project: added.slug,
    revision: read.revision,
    values: { rules: "Never touch the release branch.", mcp: { docs: { enabled: true, connect: { type: "http", url: "https://x", headers: { Authorization: "Bearer SECRET" } } } } },
  });
  assert.equal(saved.status, "saved", saved.error);

  // The folding is the screen's (test/client/data.test.ts); this asserts only that a second add leaves the layer alone.
  const again = await call("seatworks.projects.add", { root });
  assert.equal(again.slug, added.slug, "the same repository is the same project");
  const still = await call("seatworks.settings.read", { project: added.slug });
  assert.equal(still.values.rules, "Never touch the release branch.");
  assert.equal(still.values.mcp.docs.connect.headers.Authorization, "Bearer SECRET");

  // The record was once kept in memory, so a second add after Detach wrote nothing.
  assert.deepEqual(await call("seatworks.projects.remove", { project: added.slug }), { removed: added.slug });
  const back = await call("seatworks.projects.add", { root });
  assert.equal(back.slug, added.slug);
  assert.ok(
    (await call("seatworks.projects.list", {})).some((entry: { slug: string }) => entry.slug === added.slug),
    "an attach that reports a slug has to be an attach the rest of the plugin can find",
  );
  assert.equal((await call("seatworks.settings.read", { project: added.slug })).status, "ready");
  runtime.dispose();
});

test("the setup screen can walk this machine's folders to find a repository", async () => {
  const { call } = served();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sw2-rpc-browse-")));
  mkdirSync(join(root, "plain"), { recursive: true });
  execFileSync("git", ["init", "-q", join(root, "repo")]);

  const listed = await call("seatworks.paths.list", { path: root });
  assert.equal(listed.path, root);
  assert.equal(typeof listed.parent, "string", "a folder that is not the root offers the way up");
  assert.deepEqual(
    listed.folders.map((folder: { name: string; repository: boolean }) => [folder.name, folder.repository]).sort(),
    [["plain", false], ["repo", true]],
    "a repository is marked as one",
  );

  const inside = await call("seatworks.paths.list", { path: join(root, "repo") });
  assert.equal(inside.repository, true);
  assert.match((await call("seatworks.paths.list", { path: join(root, "nowhere") })).error, /is not a directory/);
});

test("the setup screen finds folders the way Paseo's Add project does, with a typed path first", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sw2-rpc-find-")));
  execFileSync("git", ["init", "-q", join(root, "repo")]);
  mkdirSync(join(root, "plain"));
  const asked: string[] = [];
  const { call } = served(undefined, async (query) => { asked.push(query); return [join(root, "plain"), join(root, "repo")]; });

  const found = await call("seatworks.paths.find", { query: "repo" });
  assert.deepEqual(asked, ["repo"]);
  assert.deepEqual(found.folders.map((folder: { path: string; repository: boolean }) => [folder.path, folder.repository]), [[join(root, "plain"), false], [join(root, "repo"), true]]);

  const typed = await call("seatworks.paths.find", { query: join(root, "repo") });
  assert.deepEqual(typed.folders.map((folder: { path: string }) => folder.path), [join(root, "repo"), join(root, "plain")], "a typed path that exists comes first, once");

  const down = served(undefined, async () => { throw new Error("daemon away"); });
  assert.match((await down.call("seatworks.paths.find", { query: "repo" })).error, /daemon away/);
  assert.deepEqual((await down.call("seatworks.paths.find", { query: root })).folders.map((folder: { path: string }) => folder.path), [root], "a typed path still answers when the search cannot");
  assert.deepEqual((await down.call("seatworks.paths.find", { query: join(root, "re") })).folders.map((folder: { path: string }) => folder.path), [join(root, "repo")], "a last part still being typed completes from its folder");
  const home = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.deepEqual((await down.call("seatworks.paths.find", { query: "repo/" })).folders.map((folder: { path: string }) => folder.path), [join(root, "repo")], "a path without ~ is read from the home folder");
    mkdirSync(join(root, "code", "my-repo"), { recursive: true });
    execFileSync("git", ["init", "-q", join(root, "code", "repo-two")]);
    const unseen = served(undefined, async () => []);
    assert.deepEqual((await unseen.call("seatworks.paths.find", { query: "REPO" })).folders.map((folder: { path: string }) => folder.path),
      [join(root, "repo"), join(root, "code", "repo-two"), join(root, "code", "my-repo")], "a bare name Paseo has not seen is looked for in the home folder and each folder in it, repositories first");
  } finally { process.env.HOME = home; }
});

test("the sensor's key is written from the panel, never read back into it, and forgotten only when asked", async () => {
  const { call } = served();
  const file = join(HOME, ".local/share/seatworks-v2/settings.json");
  const onDisk = () => JSON.parse(readFileSync(file, "utf8")) as { sensor?: { key?: string }; rules?: string };

  const read = await call("seatworks.settings.read");
  const saved = await call("seatworks.settings.write", { revision: read.revision, values: { ...read.values, sensor: { key: "sk-or-secret" } } });
  assert.equal(saved.status, "saved");
  assert.equal(onDisk().sensor?.key, "sk-or-secret", "the key itself is what is kept");
  assert.deepEqual(saved.values.sensor, { key: KEPT }, "not even the save that carried it hands it back");

  const back = await call("seatworks.settings.read");
  assert.deepEqual(back.values.sensor, { key: KEPT }, "the panel is told a key is set, and nothing more");
  assert.doesNotMatch(JSON.stringify(back), /sk-or-secret/);

  // A write is the whole layer, so a save about something else must not revoke the key.
  const else_ = await call("seatworks.settings.write", { revision: back.revision, values: { ...back.values, rules: "watch the watch" } });
  assert.equal(else_.status, "saved");
  assert.equal(onDisk().sensor?.key, "sk-or-secret");
  assert.equal(onDisk().rules, "watch the watch");

  const state = join(HOME, ".local/share/seatworks-v2/projects/sensor-abc123");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "meta.json"), JSON.stringify({ root: "/work/sensor", slug: "sensor-abc123" }));
  const project = await call("seatworks.settings.read", { project: "sensor-abc123" });
  assert.deepEqual(project.machine.sensor, { key: KEPT }, "a project screen sees that a key is set, not what it is");
  assert.doesNotMatch(JSON.stringify(project), /sk-or-secret/);
  // The desk's resolved team holds the key because the watch calls with it; what a screen gets must not.
  assert.doesNotMatch(JSON.stringify(await call("seatworks.team.read")), /sk-or-secret/);
  assert.doesNotMatch(JSON.stringify(await call("seatworks.team.read", { project: "sensor-abc123" })), /sk-or-secret/);

  const { sensor: _gone, ...without } = (await call("seatworks.settings.read")).values as { sensor?: unknown };
  const forgotten = await call("seatworks.settings.write", { revision: (await call("seatworks.settings.read")).revision, values: without });
  assert.equal(forgotten.status, "saved");
  assert.equal(onDisk().sensor, undefined, "a layer that carries no key at all is the owner forgetting it");
});

test("a settings file that will not parse is reported without quoting what it holds", async () => {
  const { call } = served();
  const file = join(HOME, ".local/share/seatworks-v2/settings.json");
  const read = await call("seatworks.settings.read");
  assert.equal((await call("seatworks.settings.write", { revision: read.revision, values: { ...read.values, sensor: { key: "sk-or-secret" } } })).status, "saved");
  // A common hand typo whose parse error quotes the key's line, short enough to fall inside V8's quoted window.
  writeFileSync(file, '{ "rules": "keep it small", "sensor": { "key": \'SEKRIT\' } }');

  const shown = [
    await call("seatworks.settings.read"),
    await call("seatworks.settings.write", { revision: read.revision, values: { rules: "x" } }),
    await call("seatworks.team.read"),
    await call("seatworks.doctor.run"),
  ];
  for (const answer of shown) {
    assert.match(JSON.stringify(answer), /is not JSON|could not be read|not being used/, "each screen says the file cannot be read");
    assert.doesNotMatch(JSON.stringify(answer), /SEKRIT/, "and none of them quotes the file back");
  }
  writeFileSync(file, "{}");
});

test("the word that stands for the key is never itself written, and a refused or stale save leaves it where it was", async () => {
  const { call } = served();
  const file = join(HOME, ".local/share/seatworks-v2/settings.json");
  const onDisk = () => JSON.parse(readFileSync(file, "utf8")) as { sensor?: { key?: string }; rules?: string };

  const empty = await call("seatworks.settings.read");
  assert.equal((await call("seatworks.settings.write", { revision: empty.revision, values: { rules: "one", sensor: { key: KEPT } } })).status, "saved");
  assert.equal(onDisk().sensor, undefined, "carried over a layer with no key, the word leaves no block behind");

  const before = await call("seatworks.settings.read");
  assert.equal((await call("seatworks.settings.write", { revision: before.revision, values: { ...before.values, sensor: { key: "sk-or-secret" } } })).status, "saved");
  const set = await call("seatworks.settings.read");
  assert.equal((await call("seatworks.settings.write", { revision: set.revision, values: { ...set.values, roles: { supervisor: { harness: "devin" } } } })).status, "invalid", "a refused save");
  assert.equal((await call("seatworks.settings.write", { revision: empty.revision, values: { ...set.values, rules: "stale" } })).status, "conflict", "and a stale one");
  assert.equal(onDisk().sensor?.key, "sk-or-secret", "leave the key where it was");

  const last = await call("seatworks.settings.read");
  const { sensor: _gone, ...without } = last.values as { sensor?: unknown };
  assert.equal((await call("seatworks.settings.write", { revision: last.revision, values: without })).status, "saved");
});

test("detaching a project also takes it out of the Supervisor's scope", async () => {
  const { call, runtime } = served();
  noSeats(runtime);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sw2-rpc-unbind-")));
  execFileSync("git", ["init", "-q", root]);
  const added = await call("seatworks.projects.add", { root });
  const store = (runtime as unknown as { supervision: { store: { read(): any; change(r: number, e: (b: any) => void): any } } }).supervision.store;
  const before = store.read();
  store.change(before.revision, (b) => { b.projects.push({ id: "prj_unbind", root, slug: added.slug, name: "unbind", grants: ["observe"], leads: [] }); });
  assert.deepEqual(await call("seatworks.projects.remove", { project: added.slug }), { removed: added.slug });
  assert.equal(store.read().projects.some((p: { root: string }) => p.root === root), false);
});
