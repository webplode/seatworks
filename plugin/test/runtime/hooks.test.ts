import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { PaseoHost } from "../../server/adapters/paseo/host.ts";
import { SEAT_KEY } from "../../server/catalog/kit/kit.ts";
import { seatDir } from "../../server/catalog/seat/seats.ts";
import { home, stateRoot } from "../../server/core/paths.ts";
import type { AgentConfig } from "../../server/core/ports.ts";
import { projectOf } from "../../server/desk/project/project.ts";
import { tempDir } from "../tempdir.ts";
import { harness } from "./harness.ts";

type Hook = (input: unknown, context: { paseo: unknown }) => unknown;
type Made = { config: AgentConfig; env: Record<string, string> };

/** Paseo's plugin server as far as a host registers on it: each hook called as the daemon calls it, with its API. */
function daemon(host: PaseoHost, h: ReturnType<typeof harness>) {
  const hooks = new Map<string, Hook>();
  const register = (name: string, hook: Hook) => void hooks.set(name, hook);
  host.connect({ before: register, on: register } as unknown as PluginServerContext, h.runtime);
  return (name: string, input: unknown) => hooks.get(name)!(input, { paseo: h.paseo });
}

/** Whether `promise` has settled by the time every job already queued has run. */
const settled = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0))]);

test("a seat as Paseo creates, opens and archives it: prompt, key, seat directory, and the daemon handle every hook brings", async () => {
  const h = harness();
  const host = new PaseoHost();
  h.restart(host);
  const hook = daemon(host, h);
  await assert.rejects(host.seats.open(), /has not reached this plugin/, "not listed as nobody seated");
  await assert.rejects(host.workspaces.owned("shop-1a2b"), /has not reached this plugin/);
  assert.equal(await settled(host.reached()), false);

  const create = (provider: string, env: Record<string, string> = {}) =>
    hook("agent.create", { request: { config: { provider, cwd: h.root }, env } }) as Made;
  const made = create("sw3-lead-claude", { KEPT: "yes" });
  assert.equal(await settled(host.reached()), true, "the hook brought Paseo's API");
  const key = made.env[SEAT_KEY]!;
  assert.match(key, /^[0-9a-f]{48}$/);
  assert.equal(made.env.KEPT, "yes", "what Paseo passed stays");
  assert.equal((made.config.mcpServers?.team as { env?: Record<string, string> }).env?.[SEAT_KEY], key);
  assert.notEqual(create("sw3-lead-claude").env[SEAT_KEY], key, "each seat its own");
  assert.match(
    create("sw3-peer-omp").env[SEAT_KEY]!,
    /^[0-9a-f]{48}$/,
    "a harness reading servers from a file shared by its seats gets the key through the env alone",
  );
  const prompt = (provider: string) => create(provider).config.systemPrompt ?? "";
  const [own = "", told = ""] = prompt("sw3-peer-claude").split(/\n\n(?=# Working rules\n)/);
  assert.match(own, /^# Peer\n/, "created with its role's prompt");
  assert.match(told, /^# Working rules\n[^]*`search`/, "then what it is told of its servers");
  const delta = readFileSync(join(import.meta.dirname, "..", "..", "harness", "codex", "delta", "peer.md"), "utf-8");
  assert.equal(
    prompt("sw3-peer-codex"),
    `${own}\n\n${delta.trimEnd()}\n\n${told}`,
    "and what its harness needs said comes between",
  );

  const open = (agentId: string, reason: string, env: Record<string, string> = {}, cwd = h.root) =>
    (hook("agent.session_open", { request: { agentId, reason, provider: "sw3-lead-claude", cwd, env } }) as Made).env;
  assert.equal(open("agent-9", "create", { [SEAT_KEY]: "k9" })[SEAT_KEY], "k9");
  assert.equal(open("agent-9", "resume")[SEAT_KEY], "k9", "a resumed seat's server starts again with its key");
  assert.equal(open("agent-0", "resume")[SEAT_KEY], undefined, "a seat never given one gets none");
  const keys = join(stateRoot(), "keys.json");
  const bound = readFileSync(keys, "utf-8");
  writeFileSync(keys, "{not json");
  assert.throws(
    () => open("agent-8", "create", { [SEAT_KEY]: "k8" }),
    /keys\.json is there but could not be read[^]*Nothing was written over it/,
    "a seat is refused rather than bound over every other seat's key",
  );
  assert.equal(readFileSync(keys, "utf-8"), "{not json");
  writeFileSync(keys, bound);

  const { kit } = h.runtime;
  const lead = kit.roles.find((role) => role.role === "lead")!;
  const claude = kit.harnesses.claude!;
  const link = join(seatDir(kit, lead, claude, home(), h.project), "projects");
  assert.throws(() => lstatSync(link), "nothing to link to yet");
  mkdirSync(join(home(), ".claude", "projects"), { recursive: true });
  open("agent-9", "resume");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "a login made after a seat was built reaches it when it opens");

  // A seat's own directory is added, and Claude reads an added directory's CLAUDE.md but never its AGENTS.md.
  const root = tempDir("sw3-supervisor-project-");
  writeFileSync(
    join(root, "AGENTS.md"),
    "Use pnpm.\n\n<!-- seatworks:begin: an older kit -->\nOld rules.\n<!-- seatworks:end -->\n\nUse Node 26.\n",
  );
  const file = join(seatDir(kit, lead, claude, home(), projectOf(root)), "CLAUDE.md");
  const rules = () => (existsSync(file) ? readFileSync(file, "utf-8") : "");
  open("agent-7", "create", {}, root);
  assert.equal(
    readFileSync(join(root, "AGENTS.md"), "utf-8"),
    "Use pnpm.\n\n<!-- seatworks:begin: an older kit -->\nOld rules.\n<!-- seatworks:end -->\n\nUse Node 26.\n",
    "a seat opening never writes the Human's checkout: the block is written when a project is attached, and each seat has it from its own instructions",
  );
  assert.match(
    rules(),
    new RegExp(`^@${join(root, "AGENTS.md")}$`, "m"),
    "a Claude seat takes in the project's AGENTS.md, though its path holds a word the Lead must not see",
  );
  writeFileSync(join(root, "CLAUDE.md"), "Use npm.\n");
  open("agent-7", "resume", {}, root);
  assert.match(
    rules(),
    new RegExp(`^@${join(root, "AGENTS.md")}$`, "m"),
    "and still takes it in beside the project's CLAUDE.md, since its Seatworks block is there, where Claude would read CLAUDE.md alone",
  );
  writeFileSync(join(root, "CLAUDE.md"), "Use npm.\n\n@AGENTS.md\n");
  open("agent-7", "resume", {}, root);
  assert.doesNotMatch(rules(), /AGENTS\.md/, "but not twice, where the project's CLAUDE.md takes it in itself");

  await hook("agent.archived", { agent: { id: "agent-9", provider: "sw3-lead-claude", cwd: h.root } });
  assert.equal(open("agent-9", "resume")[SEAT_KEY], undefined, "a seat archived lets its key go");

  const ways: [string, unknown][] = [
    ["agent.create", { request: { config: { provider: "sw3-lead-claude", cwd: h.root }, env: {} } }],
    [
      "agent.session_open",
      { request: { agentId: "agent-8", reason: "resume", provider: "sw3-lead-claude", cwd: h.root, env: {} } },
    ],
    ["agent.turn_started", { agent: { id: "agent-8", provider: "sw3-lead-claude", cwd: h.root } }],
  ];
  for (const [name, input] of ways) {
    const fresh = new PaseoHost();
    const call = daemon(fresh, h);
    assert.equal(await settled(fresh.reached()), false, `nothing has reached the host before ${name}`);
    await call(name, input);
    assert.equal(await settled(fresh.reached()), true, `${name} brings Paseo's API`);
  }
});

test("the create that first brings Paseo's API waits for the provider pass it unblocks, twenty seconds at most", async (t) => {
  const h = harness();
  const request = { request: { config: { provider: "sw3-lead-claude", cwd: h.root }, env: {} } };
  const connected = (providers: Promise<void>) => {
    const host = new PaseoHost();
    const hooks = new Map<string, Hook>();
    const register = (name: string, hook: Hook) => void hooks.set(name, hook);
    host.connect({ before: register, on: register } as unknown as PluginServerContext, h.runtime, providers);
    return () => hooks.get("agent.create")!(request, { paseo: h.paseo });
  };
  let reconciled = () => {};
  const create = connected(new Promise<void>((resolve) => (reconciled = resolve)));
  // After a reload, Paseo resolves the seat's provider as soon as this hook returns: one not yet written is refused.
  const first = Promise.resolve(create());
  assert.equal(await settled(first), false, "the first waits for the pass");
  assert.ok((create() as Made).env[SEAT_KEY], "a later one does not");
  reconciled();
  assert.ok(((await first) as Made).env[SEAT_KEY]);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stuck = Promise.resolve(connected(new Promise<void>(() => {}))());
  const due = () => Promise.race([stuck.then(() => true), new Promise((resolve) => setImmediate(resolve, false))]);
  t.mock.timers.tick(19_999);
  assert.equal(await due(), false);
  t.mock.timers.tick(1);
  assert.ok(((await stuck) as Made).env[SEAT_KEY], "a pass that never ends holds no seat past Paseo's hook limit");
});
