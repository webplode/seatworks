import assert from "node:assert/strict";
import { test } from "node:test";
import { teamBrief } from "../../server/runtime/brief.ts";
import { emptyBinding } from "../../server/runtime/supervision.ts";
import { emptyLedger } from "../../server/desk/ledger.ts";
import type { Binding } from "../../shared/supervision.ts";

const binding = (): Binding => ({ ...emptyBinding(), active: true, supervisor: { agent: "sup", workspace: "home" }, projects: [{ id: "p", root: "/project", slug: "project", name: "Project", grants: ["observe"], leads: [] }] });
test("paused or unobserved projects cannot contribute chat status", () => {
  const b = binding(); b.active = false;
  assert.equal(teamBrief(b, [], () => { throw Error("must not read"); }, []).projects.length, 0);
  b.active = true; b.projects[0]!.grants = [];
  assert.equal(teamBrief(b, [], () => { throw Error("must not read"); }, []).items.length, 0);
});
test("team questions do not become Human approval requests", () => {
  const ledger = emptyLedger();
  ledger.asks.q = { id: "q", from: "peer", fromRole: "peer", to: "sup", kind: "scope", text: "Which module?", status: "open", openedAt: 0, reminders: 0 };
  const view = teamBrief(binding(), [], () => ledger, []);
  assert.equal(view.questions, 1); assert.equal(view.needsYou, 0); assert.equal(view.items[0]!.kind, "question");
});
test("a failed ledger read is visible rather than an idle or successful team", () => {
  const view = teamBrief(binding(), [], () => { throw Error("corrupt"); }, []);
  assert.equal(view.projects[0]!.status, "Status unavailable"); assert.equal(view.items[0]!.kind, "error");
});
test("one real permission is counted once and card payloads are bounded", () => {
  const b = binding(); b.projects[0]!.leads = [{ agent: "sup", workspace: "home", objective: "test", ownership: [], origin: "external" }];
  const view = teamBrief(b, [{ id: "sup", provider: "test", cwd: "/project", workspaceId: "home", status: "idle", updatedAt: "now", pendingPermissions: Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, title: "Approval" })) }], () => emptyLedger(), []);
  assert.equal(view.needsYou, 30); assert.equal(view.items.length, 24); assert.equal(view.omitted, 6);
});
test("associated external Leads count as work even without a managed lane", () => {
  const b = binding(); b.projects[0]!.leads = [{ agent: "external", workspace: "w", objective: "existing work", ownership: [], origin: "external" }];
  assert.equal(teamBrief(b, [], () => emptyLedger(), []).lines, 1);
});
test("a Lead's ready report becomes a land card, and a red gate a tests card, never both", () => {
  const ledger = emptyLedger();
  ledger.lanes.L1 = { id: "L1", title: "Checkout", status: "open", branch: "sw/L1", base: "main", lead: "lead-1" } as never;
  ledger.lanes.L2 = { id: "L2", title: "Search", status: "open", branch: "sw/L2", base: "main", lead: "lead-2" } as never;
  ledger.lanes.L3 = { id: "L3", title: "Still going", status: "open", branch: "sw/L3", base: "main", lead: "lead-3" } as never;
  const reports = new Map([["L1", { ready: true, gate: true, summary: "Done" }], ["L2", { ready: true, gate: false }], ["L3", { ready: false }]]);
  const view = teamBrief(binding(), [], () => ledger, [], { reports: () => reports, diff: () => "2 files · +10 −1", teamFiles: () => [] });
  const land = view.items.find(i => i.kind === "land")!;
  assert.equal(land.lane, "L1"); assert.equal(land.diff, "sw/L1 → main · 2 files · +10 −1"); assert.equal(land.agent, "lead-1");
  assert.equal(view.items.filter(i => i.kind === "tests").map(i => i.lane).join(), "L2");
  assert.equal(view.items.some(i => i.lane === "L3"), false);
  assert.equal(view.projects[0]!.status, "1 ready to land");
});
test("uncommitted team instructions are offered for commit, naming only those files", () => {
  const view = teamBrief(binding(), [], () => emptyLedger(), [], { reports: () => new Map(), diff: () => null, teamFiles: () => ["AGENTS.md"] });
  const item = view.items.find(i => i.kind === "commit")!;
  assert.deepEqual(item.files, ["AGENTS.md"]); assert.equal(item.scope, "p");
});
test("a Supervisor that cannot sign in comes first, with a reload, and counts as needing the Human", () => {
  const b = binding(); b.projects[0]!.leads = [{ agent: "sup", workspace: "home", objective: "t", ownership: [], origin: "external" }];
  const view = teamBrief(b, [{ id: "sup", provider: "t", cwd: "/project", workspaceId: "home", status: "idle", updatedAt: "now", pendingPermissions: [{ id: "1", title: "Approval" }] }], () => emptyLedger(), [], undefined, "Not logged in · Please run /login");
  assert.equal(view.signIn, "Not logged in · Please run /login");
  assert.equal(view.items[0]!.action, "reload"); assert.equal(view.needsYou, 2);
});
test("each open work stream reads as one line: its title and how far it got", () => {
  const ledger = emptyLedger();
  ledger.lanes.L1 = { id: "L1", title: "Checkout", status: "open", branch: "b", base: "main", lead: "lead-1" } as never;
  ledger.tasks.T1 = { id: "T1", lane: "L1", status: "merged" } as never;
  ledger.tasks.T2 = { id: "T2", lane: "L1", status: "running" } as never;
  const view = teamBrief(binding(), [], () => ledger, []);
  assert.deepEqual(view.projects[0]!.streams, [{ id: "L1", title: "Checkout", state: "1 of 2 tasks done", agent: "lead-1" }]);
});
