import assert from "node:assert/strict";
import { supervisionRpc } from "../../shared/rpc.ts";
import { test } from "node:test";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../server/catalog/kit.ts";
import { Desk } from "../../server/desk/desk.ts";
import { resolveTeam } from "../../server/catalog/team.ts";
import { Supervision, canonicalRoot } from "../../server/runtime/supervision.ts";
import { SupervisionControl } from "../../server/runtime/supervision-control.ts";
import { Outbox } from "../../server/runtime/outbox.ts";
import { writeJson } from "../../server/core/store.ts";
import type { SeatView, Seats } from "../../server/core/ports.ts";
import { tempDir } from "../tempdir.ts";
import { seatsOn } from "../../server/core/paseo-adapter.ts";

test("a missing native agent cannot be mistaken for an idle live recipient", async () => {
  const api = { agents: { ref: (id: string) => ({ id, async refresh() {}, current: () => null }) } };
  await assert.rejects(seatsOn(() => api as never).look("missing"), /unavailable/);
});

test("native project reassignment revokes a queued correction even when its path stays the same", async () => {
  const f = fixture(); await f.bind(); await f.adopt("p0", "lead0");
  f.agents.get("lead0")!.status = "running";
  await f.control.message("sup", "p0", "lead0", "Correction", "moved");
  const original = f.seats.look;
  f.seats.look = async (id) => ({ ...await original(id), projectId: "different-native-project" });
  f.agents.get("lead0")!.status = "idle";
  await f.outbox.pump("lead0");
  assert.equal(f.outbox.records().find((l) => l.key === "moved")!.state, "revoked");
  assert.equal(f.sent.length, 0);
});

function fixture(activity = async (_id: string, _limit: number): Promise<unknown> => ({ entries: [{ text: "NATIVE_TRANSCRIPT" }] })) {
  const root = tempDir();
  const store = new Supervision(root);
  const paths = ["a", "b", "c"].map((name) => join(root, name));
  paths.forEach((p) => mkdirSync(p));
  const agents = new Map<string, SeatView>([
    ["sup", { id: "sup", provider: "sw2-supervisor-claude", cwd: root, workspaceId: "home", status: "idle", updatedAt: "now" }],
    ...paths.map((cwd, i): [string, SeatView] => [`lead${i}`, { id: `lead${i}`, provider: "codex", cwd, workspaceId: `w${i}`, status: "idle", updatedAt: "now" }]),
  ]);
  const sent: { to: string; text: string }[] = [];
  const seats: Seats = { async open() { return [...agents.values()]; }, async look(id) { const a = agents.get(id); if (!a) throw new Error("gone"); return { ...a, projectId: `p${paths.indexOf(a.cwd)}` }; },
    async send(to, text) { sent.push({ to, text }); }, async typed() { return []; }, async respond() { throw new Error("Corrections must not answer permissions."); }, async archive() {}, watch() { throw new Error("unused"); } };
  const outbox = new Outbox(join(root, "outbox.json"), (_to, items) => items.map((i) => i.text).join("\n"), seats, undefined, undefined,
    (letter, seat) => letter.guard ? store.validate(letter.guard, seat) : undefined);
  const control = new SupervisionControl({ store, seats, outbox, activity, kit: loadKit(fileURLToPath(new URL("../../", import.meta.url))),
    workspaces: { async named() { return undefined; }, async owned() { return []; }, async make() { throw new Error("No workspaces are created on adoption."); }, async seat() { throw new Error("No agents are created on adoption."); }, async archive() {} },
    inventory: async () => ({ projects: paths.map((root, i) => ({ id: `p${i}`, root, name: "same-name" })), workspaces: paths.map((path, i) => ({ id: `w${i}`, project: `p${i}`, path })) }),
    source: { record() {} } as never,
  });
  const bind = async () => { const binding = await control.bind({ revision: store.read().revision, supervisor: "sup", active: true, projects: ["p0", "p1"].map((id) => ({ id, grants: ["observe", "message", "coordinate"] })) }); sent.length = 0; return binding; };
  const adopt = (project: string, agent: string) => control.adopt({ revision: store.read().revision, project, agent, objective: "Maintain the contract", ownership: ["src/**"] });
  return { root, store, paths, agents, sent, seats, outbox, control, bind, adopt };
}

test("one binding adopts pre-existing external Leads without recreating or reparenting them", async () => {
  const f = fixture(); await f.bind(); await f.adopt("p0", "lead0"); await f.adopt("p1", "lead1");
  assert.equal(f.agents.size, 4);
  assert.equal(f.store.read().projects[0]!.leads[0]!.origin, "external");
  assert.equal(new Supervision(f.root).read().supervisor?.agent, "sup");
  await f.control.message("sup", "p0", "lead0", "Preserve the public API", "one");
  assert.deepEqual(f.sent.map((m) => m.to), ["lead0"]);
  await assert.rejects(f.control.message("sup", "p1", "lead0", "wrong project", "two"));
  await assert.rejects(f.control.message("sup", "p2", "lead2", "outside scope", "three"));
  await assert.rejects(f.control.message("lead1", "p0", "lead0", "spoof authority", "four"));
});

test("a stale UI cannot overwrite a newer binding and overlapping ownership is explicit", async () => {
  const f = fixture(); await f.bind(); const revision = f.store.read().revision;
  await f.adopt("p0", "lead0");
  await assert.rejects(f.control.bind({ revision, active: false, supervisor: "sup", projects: [] }), /changed/);
  f.agents.set("other", { ...f.agents.get("lead0")!, id: "other" });
  await assert.rejects(f.adopt("p0", "other"), /overlaps/);
  assert.equal(f.store.read().projects[0]!.leads.length, 1);
});

test("a queued correction never answers a permission and is revoked after scope changes", async () => {
  const f = fixture(); await f.bind(); await f.adopt("p0", "lead0");
  f.agents.get("lead0")!.pendingPermissions = [{ id: "q", kind: "question", input: { questions: [{ question: "Delete?", options: ["yes", "no"] }] } }];
  await f.control.message("sup", "p0", "lead0", "Change priority", "correction");
  assert.equal(f.outbox.records().find((l) => l.key === "correction")!.state, "queued");
  f.store.change(f.store.read().revision, (b) => { b.projects = []; });
  f.agents.get("lead0")!.pendingPermissions = [];
  await f.outbox.pump("lead0");
  assert.equal(f.outbox.records().find((l) => l.key === "correction")!.state, "revoked");
  assert.equal(f.sent.length, 0);
});

test("a send interrupted by process loss becomes unknown and is not retried", async () => {
  const f = fixture(); await f.bind(); await f.adopt("p0", "lead0");
  f.agents.get("lead0")!.status = "running";
  await f.control.message("sup", "p0", "lead0", "Correction", "crash");
  const records = f.outbox.records(); records.find((l) => l.key === "crash")!.state = "sending";
  writeJson(join(f.root, "outbox.json"), records);
  const restarted = new Outbox(join(f.root, "outbox.json"), () => "do not replay", f.seats);
  f.agents.get("lead0")!.status = "idle";
  await restarted.pump("lead0");
  assert.equal(restarted.records().find((l) => l.key === "crash")!.state, "unknown");
  assert.equal(f.sent.length, 0);
});

test("a process exiting after transport acceptance cannot replay the command in a new process", () => {
  const root = tempDir();
  const file = join(root, "outbox.json");
  const marker = join(root, "accepted.txt");
  const module = new URL("../../server/runtime/outbox.ts", import.meta.url).href;
  const common = `import { Outbox } from ${JSON.stringify(module)};
    import { appendFileSync } from 'node:fs';
    const file = ${JSON.stringify(file)};
    const marker = ${JSON.stringify(marker)};
    const seats = { async look(id) { return { id, status: 'idle' }; }, async send() { appendFileSync(marker, 'accepted\\n'); process.exit(0); } };
    const box = new Outbox(file, () => 'correction', seats);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", `${common} await box.post({to:'lead',key:'one',text:'correction'});`]);
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].state, "sending");
  execFileSync(process.execPath, ["--input-type=module", "-e", `${common} await box.pump('lead');`]);
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].state, "unknown");
  assert.equal(readFileSync(marker, "utf8"), "accepted\n");
});

test("dependency delivery cannot unblock its consumer until that exact consumer confirms", async () => {
  const f = fixture(); await f.bind(); await f.adopt("p0", "lead0"); await f.adopt("p1", "lead1");
  const deps = f.control.dependencies;
  let item = await deps.request("sup", { producer: { project: "p0", agent: "lead0" }, consumer: { project: "p1", agent: "lead1" }, request: "Publish API schema", checkpoint: "Schema review" });
  await assert.rejects(deps.change("sup", { id: item.id, revision: 0, state: "accepted", checkpoint: "Review" }), /producer/);
  item = await deps.change("lead0", { id: item.id, revision: 0, state: "accepted", checkpoint: "Build schema" });
  item = await deps.change("lead0", { id: item.id, revision: 1, state: "delivered", artifact: "repoA@abcdef:api/schema.json", checkpoint: "Consumer validation" });
  await assert.rejects(deps.change("lead0", { id: item.id, revision: 2, state: "confirmed", checkpoint: "Done" }), /consumer/);
  assert.equal(deps.read()[0]!.state, "delivered");
  item = await deps.change("lead1", { id: item.id, revision: 2, state: "confirmed", checkpoint: "Mobile implementation resumes" });
  assert.equal(item.state, "confirmed");
  assert.equal(f.store.read().projects[0]!.root, canonicalRoot(f.paths[0]!));
});


test("the live desk accepts integer dependency revisions from existing Leads", async () => {
  const f = fixture(); await f.bind(); await f.adopt("p0", "lead0"); await f.adopt("p1", "lead1");
  for (const id of ["lead0", "lead1"]) f.agents.get(id)!.provider = "sw2-lead-codex";
  const kit = loadKit(fileURLToPath(new URL("../../", import.meta.url)));
  const desk = new Desk({ kit, supervision: f.control, outbox: f.outbox, seats: f.seats,
    workspaces: {} as never, log() {}, teamFor: () => resolveTeam(kit) });
  const request = await f.control.dependencies.request("sup", { producer: { project: "p0", agent: "lead0" }, consumer: { project: "p1", agent: "lead1" }, request: "contract", checkpoint: "accept" });
  const call = (agent: string, revision: number, state: string) => desk.handle({ id: `${agent}-${revision}`, at: Date.now(), agent, role: "lead", cwd: f.paths[0]!, tool: "coordinate", args: { id: request.id, revision, state, checkpoint: "verify", ...(state === "delivered" ? { artifact: "contract@v1" } : {}) } });
  const bad = await call("lead0", 0.5, "accepted");
  assert.equal(bad.ok, false);
  assert.match(bad.text, /revision must be an integer/);
  for (const [agent, revision, state] of [["lead0", 0, "accepted"], ["lead0", 1, "delivered"], ["lead1", 2, "confirmed"]] as const) {
    const reply = await call(agent, revision, state);
    assert.equal(reply.ok, true, reply.text);
    assert.equal(JSON.parse(reply.text).state, state);
  }
  assert.equal(f.control.dependencies.read()[0]!.by, "lead1");
});


test("the supervision RPC remains valid after a real delivery without a failure detail", async () => {
  const f = fixture(); await f.bind(); await f.adopt("p0", "lead0");
  await f.control.message("sup", "p0", "lead0", "Correction", "rpc-delivery");
  const view = await f.control.view();
  assert.ok(view.deliveries.some((d) => d.state === "delivered"));
  assert.deepEqual(supervisionRpc.output.parse(view), view);
});


test("Supervisor activity reads a native existing Lead only inside its current observe scope", async () => {
  const reads: string[] = [];
  const f = fixture(async (id, limit) => { reads.push(id); assert.equal(limit, 10); return { entries: [{ text: "NATIVE_TRANSCRIPT" }] }; });
  await f.bind();
  f.store.change(f.store.read().revision, (b) => { b.projects.forEach((p) => { p.grants = ["observe"]; }); });
  const kit = loadKit(fileURLToPath(new URL("../../", import.meta.url)));
  const desk = new Desk({ kit, supervision: f.control, outbox: f.outbox, seats: f.seats, workspaces: {} as never, log() {}, teamFor: () => resolveTeam(kit) });
  const call = (project: string, agent: string, limit = 10) => desk.handle({ id: "activity", at: Date.now(), agent: "sup", role: "supervisor", cwd: f.root, tool: "activity", args: { project, agent, limit } });
  const allowed = await call("p0", "lead0");
  assert.equal(allowed.ok, true, allowed.text);
  assert.match(allowed.text, /NATIVE_TRANSCRIPT/);
  assert.equal((await call("p1", "lead0")).ok, false);
  assert.equal((await call("p2", "lead2")).ok, false);
  assert.equal((await call("p0", "lead0", 1000)).ok, false);
  assert.deepEqual(reads, ["lead0"]);
  f.agents.get("lead0")!.archivedAt = "now";
  assert.equal((await call("p0", "lead0")).ok, false);
  assert.deepEqual(reads, ["lead0"]);
});

test("activity withholds a transcript when scope or native placement changes during the read", async () => {
  for (const change of ["scope", "placement"] as const) {
    const f = fixture(async () => {
      if (change === "scope") f.store.change(f.store.read().revision, (b) => { b.active = false; });
      else f.agents.get("lead0")!.cwd = f.paths[1]!;
      return { entries: [{ text: "MUST_NOT_ESCAPE" }] };
    });
    await f.bind();
    await assert.rejects(f.control.activity("sup", "p0", "lead0", 10));
  }
});


test("a new Supervisor stays idle until its binding can authorize an activation", async () => {
  const f = fixture();
  const kit = loadKit(fileURLToPath(new URL("../../", import.meta.url)));
  const control = new SupervisionControl({ store: f.store, kit, seats: f.seats, outbox: f.outbox,
    inventory: async () => ({ projects: [], workspaces: [] }), activity: async () => [],
    source: { teamFor: () => resolveTeam(kit) } as never,
    workspaces: { async named() { return { id: "home", project: "home" }; }, async owned() { return []; },
      async make() { throw new Error("unexpected"); }, async archive() {},
      async seat(_workspace, spec) {
        assert.equal(f.store.read().supervisor, null);
        assert.equal(spec.prompt, undefined, "do not start a turn before binding the Supervisor");
        return { ...f.agents.get("sup")!, projectId: "home" };
      } },
  });
  await control.create(f.store.read().revision);
  assert.equal(f.store.read().supervisor?.agent, "sup");
  assert.equal(f.store.read().active, false);
});
