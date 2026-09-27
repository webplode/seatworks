// First, so this file has a HOME of its own even run alone: what it writes under HOME would otherwise land in the owner's.
import "../setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stateRoot } from "../../server/core/paths.ts";
import { emptyLedger } from "../../server/domain/ledger.ts";
import { contracts } from "../../shared/rpc.ts";
import type { Layer } from "../../shared/settings.ts";
import { tempDir } from "../tempdir.ts";
import { fakeConfig } from "./fake-paseo.ts";
import { daemon, served, which } from "./served.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" });

test("a project attached by path, set up, opened in Paseo's own project list, detached only when idle and attached again, and the setup screen's candidates and folders", async (t) => {
  const paseo = daemon();
  const { call } = served(paseo);
  const listed = async () => (await call(contracts.projects, {})).map((entry) => entry.slug);
  const root = realpathSync(tempDir("sw3-rpc-attach-"));
  git(root, "init", "-q");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "Use pnpm.\n");
  const added = which(await call(contracts.projectsAdd, { root: join(root, "src") }), "slug");
  const agents = () => readFileSync(join(root, "AGENTS.md"), "utf-8");
  assert.equal(
    agents(),
    "Use pnpm.\n\n<!-- seatworks:begin: Seatworks writes this block; write your own rules outside it -->\n## Seatworks\n\nWork through the team tools.\n<!-- seatworks:end -->\n",
    "setting a project up puts the Seatworks block in its AGENTS.md, which every agent there reads, after the Human's own",
  );
  assert.equal(
    added.note,
    "The Seatworks block changed in AGENTS.md; commit it.",
    "an uncommitted AGENTS.md stops a lane working in the Human's own copy from landing",
  );
  assert.equal(
    added.root,
    root,
    "a path inside the project registers the project root, before any agent has run in it",
  );
  assert.ok((await listed()).includes(added.slug));
  assert.deepEqual(
    [...paseo.opened.keys()],
    [root],
    "attaching opens the project root in Paseo, where the Human starts its Supervisor",
  );
  const read = which(await call(contracts.settingsRead, { project: added.slug }), "values");
  const values = {
    rules: "Never touch the release branch.",
    roles: { peer: { harness: "omp" } },
    mcp: {
      docs: {
        enabled: true,
        connect: { type: "http" as const, url: "https://x", headers: { Authorization: "Bearer SECRET" } },
      },
    },
  };
  const saved = await call(contracts.settingsWrite, { project: added.slug, revision: read.revision, values });
  assert.equal(saved.status, "saved", JSON.stringify(saved));
  assert.equal(
    which(await call(contracts.team, { project: added.slug }), "roles").roles.peer!.harness,
    "omp",
    "its own settings",
  );
  const missing = await call(contracts.projectsAdd, { root: join(root, "nowhere") });
  assert.match(which(missing, "error").error, /is not a directory/);

  const written = agents();
  const again = which(await call(contracts.projectsAdd, { root }), "slug");
  assert.equal(agents(), written, "and setting it up again writes it once");
  assert.equal(again.note, undefined, "and says nothing when nothing changed");
  assert.equal(again.slug, added.slug, "the same repository is the same project");
  const kept = which(await call(contracts.settingsRead, { project: added.slug }), "values").values;
  assert.deepEqual(
    [kept.rules, kept.mcp!.docs!.connect!.headers!.Authorization],
    ["Never touch the release branch.", "Bearer SECRET"],
    "a second setup leaves the desk's layer alone",
  );

  // The setup screen's agents for a project, previewed and then attached in one call, over what the project holds.
  const onOmp = { roles: { lead: { harness: "omp" } } };
  const preview = which(await call(contracts.teamPreview, { root, values: onOmp }), "roles");
  assert.deepEqual(
    [preview.roles.lead!.harness, preview.roles.lead!.model, preview.roles.peer!.harness],
    ["omp", "glm", "omp"],
    "the draft over the project's own layer, as the seats would run on it",
  );
  const fresh = realpathSync(tempDir("sw3-rpc-fresh-"));
  git(fresh, "init", "-q");
  assert.equal(
    which(await call(contracts.teamPreview, { root: fresh, values: {} }), "roles").roles.peer!.harness,
    "omp",
    "a repository not set up yet runs on the machine's defaults",
  );
  const setUp = async (values: Layer) => which(await call(contracts.projectsAdd, { root, values }), "slug");
  const lead = async () => which(await call(contracts.settingsRead, { project: added.slug }), "values").values;
  assert.equal((await setUp({ roles: { lead: { model: "haiku", thinking: "high" } } })).refused, undefined);
  assert.deepEqual((await lead()).roles?.lead, { model: "haiku", thinking: "high" }, "a draft that moves no role");
  await setUp(onOmp);
  const folded = await lead();
  assert.deepEqual(
    [folded.rules, folded.roles?.lead, folded.roles?.peer, folded.mcp?.docs?.connect?.headers?.Authorization],
    ["Never touch the release branch.", { harness: "omp" }, { harness: "omp" }, "Bearer SECRET"],
    "the rules and the pasted token stay, and the old agent's choices do not follow the role to the new one",
  );
  const ghost = await setUp({ roles: { ghost: { harness: "claude" } } });
  assert.match(ghost.refused ?? "", /unknown role ghost/, "attached, and why its setup was not saved");

  const ledger = join(stateRoot(), "projects", added.slug, "ledger.json");
  const remove = async () => call(contracts.projectsRemove, { project: added.slug });
  const record = (held: Record<string, unknown>) => JSON.stringify({ ...emptyLedger(), ...held });
  writeFileSync(ledger, record({ lanes: { L1: { id: "L1", status: "open" } } }));
  assert.match(
    which(await remove(), "error").error,
    /1 open or waiting lane\(s\)/,
    "not detached while work runs in it",
  );
  writeFileSync(ledger, record({ lanes: { L1: { id: "L1", status: "waiting", after: ["L0"] } } }));
  assert.match(
    which(await remove(), "error").error,
    /1 open or waiting lane\(s\)/,
    "a lane waiting to open is work to come",
  );
  // Closed lanes and their cut tasks are provenance that nothing deletes, so they must not count as work.
  const closed = {
    lanes: { L1: { id: "L1", status: "closed" } },
    tasks: { "L1-T1": { id: "L1-T1", lane: "L1", status: "cut" } },
  };
  writeFileSync(ledger, record(closed));
  assert.deepEqual(await remove(), { removed: added.slug });
  assert.equal((await listed()).includes(added.slug), false);
  assert.deepEqual(
    [[...paseo.opened.keys()], paseo.archived],
    [[root], []],
    "attached twice it is one project in Paseo, and detaching leaves it there: it is the Human's",
  );
  assert.match(which(await remove(), "error").error, /has been seen/);
  const back = which(await call(contracts.projectsAdd, { root }), "slug");
  assert.equal(back.slug, added.slug);
  assert.ok((await listed()).includes(added.slug), "an attach that reports a slug is one the rest of the plugin finds");
  assert.equal((await call(contracts.settingsRead, { project: added.slug })).status, "ready");

  const repo = realpathSync(tempDir("sw3-rpc-live-"));
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const linked = join(realpathSync(tempDir("sw3-rpc-linked-")), "wt");
  git(repo, "worktree", "add", "-q", "-b", "side", linked);
  const plain = realpathSync(tempDir("sw3-rpc-plain-"));
  const ours = join(stateRoot(), "worktrees/shop-ef484b/S0");
  mkdirSync(ours, { recursive: true });
  const roots = [repo, linked, plain, ours, join(repo, "nowhere"), root];
  assert.deepEqual(
    await call(contracts.projectsCandidates, { roots }),
    [repo],
    "a setup screen is offered no worktree, gone or plain directory, nor a project already set up",
  );

  const walk = realpathSync(tempDir("sw3-rpc-browse-"));
  mkdirSync(join(walk, "plain"), { recursive: true });
  git(walk, "init", "-q", "repo");
  const folders = which(await call(contracts.paths, { path: walk }), "folders");
  assert.equal(folders.path, walk);
  assert.equal(typeof folders.parent, "string", "a folder that is not the root offers the way up");
  assert.deepEqual(
    folders.folders.map((folder) => [folder.name, folder.repository]).sort(),
    [
      ["plain", false],
      ["repo", true],
    ],
    "a repository is marked as one",
  );
  assert.equal(which(await call(contracts.paths, { path: join(walk, "repo") }), "folders").repository, true);
  assert.match(
    which(await call(contracts.paths, { path: join(walk, "nowhere") }), "error").error,
    /is not a directory/,
  );
  const locked = join(walk, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  t.after(() => chmodSync(locked, 0o700));
  const refused = await call(contracts.paths, { path: locked });
  assert.match(
    which(refused, "error").error,
    /could not be read/,
    "a folder that cannot be read is a refusal, not a rejection",
  );
});

test("Paseo holds a provider for each role and agent an attached project's team seats: none at load with no project attached, set up on attach, following each settings save, and taken off on detach, though never from under a live seat", async () => {
  const config = fakeConfig({
    providers: { claude: { env: { TOKEN: "keep" } }, "sw3-peer-codex": { extends: "codex", label: "x" } },
    agentProfiles: [{ id: "sw3-lead-claude", provider: "sw3-lead-claude" }],
  });
  const live: { provider: string }[] = [];
  const { call, runtime, providers } = served(daemon(config, live));
  const loaded = runtime.prepare();
  await call(contracts.projects, {});
  await loaded;
  assert.deepEqual(
    await providers(),
    {},
    "a load with no project attached leaves no provider of the kit's, once a panel call brings Paseo's API",
  );
  const root = realpathSync(tempDir("sw3-rpc-providers-"));
  git(root, "init", "-q");
  const added = which(await call(contracts.projectsAdd, { root }), "slug");
  assert.deepEqual(
    Object.keys(await providers()).sort(),
    ["sw3-lead-claude", "sw3-peer-omp", "sw3-scribe-omp", "sw3-supervisor-claude"],
    "attaching sets up exactly what the project's team seats, so its Supervisor can be started at once",
  );
  const own = which(await call(contracts.settingsRead, { project: added.slug }), "values");
  const values = { roles: { lead: { harness: "omp" } } };
  const ownSaved = await call(contracts.settingsWrite, { project: added.slug, revision: own.revision, values });
  assert.equal(ownSaved.status, "saved", JSON.stringify(ownSaved));
  assert.deepEqual(
    Object.keys(await providers()).sort(),
    ["sw3-lead-omp", "sw3-peer-omp", "sw3-scribe-omp", "sw3-supervisor-claude"],
    "a project's own save moves its seats",
  );
  const machine = which(await call(contracts.settingsRead, {}), "values");
  live.push({ provider: "sw3-lead-omp/glm" });
  const haiku = { roles: { supervisor: { model: "haiku" } } };
  assert.equal((await call(contracts.settingsWrite, { revision: machine.revision, values: haiku })).status, "saved");
  assert.deepEqual(
    (await providers())["sw3-supervisor-claude"]?.additionalModels?.map((model) => model.id),
    ["haiku"],
    "and so does the machine's",
  );
  const back = which(await call(contracts.settingsRead, { project: added.slug }), "values");
  await call(contracts.settingsWrite, { project: added.slug, revision: back.revision, values: {} });
  assert.ok("sw3-lead-omp" in (await providers()), "a Lead still working on its agent keeps its provider");
  live.splice(0);
  assert.deepEqual(await call(contracts.projectsRemove, { project: added.slug }), { removed: added.slug });
  assert.deepEqual(await providers(), {}, "detached, its seats' providers go with it, and one no seat runs on");
  const { config: held } = await config.api.get();
  assert.deepEqual(
    [held.providers.claude, held.agentProfiles],
    [{ env: { TOKEN: "keep" } }, []],
    "the owner's own stay",
  );
  assert.equal(
    config.patches.some(
      (patch) => "providers" in patch && Object.keys(patch.providers!).some((id) => !id.startsWith("sw3-")),
    ),
    false,
    "and no patch touches them",
  );
});

test("while Paseo cannot say which seats are live, a provider the team no longer seats stays, since a seat may still run on it", async () => {
  const paseo = daemon();
  const { call, providers } = served(paseo);
  const root = realpathSync(tempDir("sw3-rpc-unlisted-"));
  git(root, "init", "-q");
  const added = which(await call(contracts.projectsAdd, { root }), "slug");
  assert.ok("sw3-lead-claude" in (await providers()));
  paseo.agents.list = async () => {
    throw new Error("the daemon did not answer");
  };
  const own = which(await call(contracts.settingsRead, { project: added.slug }), "values");
  const values = { roles: { lead: { harness: "omp" } } };
  assert.equal(
    (await call(contracts.settingsWrite, { project: added.slug, revision: own.revision, values })).status,
    "saved",
  );
  assert.deepEqual(
    Object.keys(await providers()).sort(),
    ["sw3-lead-claude", "sw3-lead-omp", "sw3-peer-omp", "sw3-scribe-omp", "sw3-supervisor-claude"],
    "the Lead's new agent is set up, and its old one stays until Paseo can say nobody runs on it",
  );
});

test("a level is the machine's: one that breaks a seat is refused by name, a project is set up from a copy of it, and a project's layer holds none", async () => {
  const { call } = served();
  const machine = async () => which(await call(contracts.settingsRead, {}), "values");
  const broken = await call(contracts.settingsWrite, {
    revision: (await machine()).revision,
    values: { levels: { max: { supervisor: { harness: "omp" } } } },
  });
  assert.match(which(broken, "error").error, /^Max: Oh My Pi has no supervisor settings/m, "named by its level");
  const vague = await call(contracts.settingsWrite, {
    revision: (await machine()).revision,
    values: { levels: { balanced: { supervisor: { model: "opus", thinking: "galaxy" } } } },
  });
  assert.match(
    which(vague, "error").error,
    /^Balanced: .*no thinking option galaxy/m,
    "and so is a thinking its model lacks",
  );
  const cheap = { lead: { harness: "omp" }, supervisor: { model: "opus", thinking: "medium" } };
  const saved = await call(contracts.settingsWrite, {
    revision: (await machine()).revision,
    values: { levels: { cheap } },
  });
  assert.equal(saved.status, "saved", JSON.stringify(saved));
  assert.equal(
    which(await call(contracts.team, {}), "roles").roles.lead!.harness,
    "claude",
    "a level moves no seat until a project is set up from it",
  );

  const root = realpathSync(tempDir("sw3-rpc-level-"));
  git(root, "init", "-q");
  const added = which(await call(contracts.projectsAdd, { root, values: { roles: cheap } }), "slug");
  assert.equal(added.refused, undefined);
  const team = async () => which(await call(contracts.team, { project: added.slug }), "roles").roles;
  const set = await team();
  assert.deepEqual([set.lead!.harness, set.supervisor!.model, set.supervisor!.thinking], ["omp", "opus", "medium"]);
  const later = { lead: { harness: "claude" } };
  await call(contracts.settingsWrite, { revision: (await machine()).revision, values: { levels: { cheap: later } } });
  assert.equal((await team()).lead!.harness, "omp", "changing a level later moves no project set up from it");

  const own = which(await call(contracts.settingsRead, { project: added.slug }), "values");
  const inProject = await call(contracts.settingsWrite, {
    project: added.slug,
    revision: own.revision,
    values: { ...own.values, levels: { cheap } },
  });
  assert.match(which(inProject, "error").error, /Levels are this machine's/);
});
