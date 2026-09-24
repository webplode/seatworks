import assert from "node:assert/strict";
import { test } from "node:test";
import { teamBrief } from "../../server/runtime/brief.ts";
import { approvable } from "../../shared/brief.ts";
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
  assert.equal(view.projects[0]!.status, "1 ready for your approval");
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
test("a lane that carried on the Human's branch is offered to finish, not to merge, and shows no diff against itself", () => {
  const ledger = emptyLedger();
  ledger.lanes.L1 = { id: "L1", title: "Fix totals", status: "open", branch: "fix/totals", base: "fix/totals", onBranch: true, lead: "lead-1" } as never;
  let asked = false;
  const view = teamBrief(binding(), [], () => ledger, [], { reports: () => new Map([["L1", { ready: true, gate: true }]]), diff: () => { asked = true; return "0 files"; }, teamFiles: () => [] });
  const item = view.items.find(i => i.kind === "land")!;
  assert.deepEqual([item.stays, item.diff, item.title, asked], [true, "Stays on fix/totals · nothing is merged", "Ready to finish · tests passed", false]);
});
test("a lane waiting for others is listed after the open ones, with what it waits for", () => {
  const ledger = emptyLedger();
  ledger.lanes.L1 = { id: "L1", title: "Checkout", status: "open", branch: "b", base: "main", lead: "lead-1" } as never;
  ledger.lanes.L2 = { id: "L2", title: "Receipts", status: "waiting", branch: "c", base: "main", after: ["L1"] } as never;
  const view = teamBrief(binding(), [], () => ledger, []);
  assert.deepEqual(view.projects[0]!.streams!.map(s => [s.id, s.state]), [["L1", "waiting"], ["L2", "starts when earlier work is merged"]]);
  ledger.lanes.L1!.status = "closed";
  assert.equal(teamBrief(binding(), [], () => ledger, []).projects[0]!.status, "1 piece of work waiting to start");
});
test("every card says in plain words what the Human approves, and Approve all takes only what a plain yes settles", () => {
  const ledger = emptyLedger();
  ledger.lanes.L1 = { id: "L1", title: "Checkout", status: "open", branch: "sw/L1", base: "main", lead: "lead-1" } as never;
  ledger.lanes.L2 = { id: "L2", title: "Search", status: "open", branch: "sw/L2", base: "main", lead: "lead-2" } as never;
  ledger.asks.q = { id: "q", from: "lead-1", fromRole: "lead", to: "sup", kind: "scope", text: "Which module?", status: "open", openedAt: 0, reminders: 0 };
  const reports = new Map([["L1", { ready: true, gate: true, summary: "Commit abc adds src/x.js" }], ["L2", { ready: true, gate: false }]]);
  const view = teamBrief(binding(), [], () => ledger, [], { reports: () => reports, diff: () => "2 files · +10 −1", teamFiles: () => ["AGENTS.md"] });
  const byKind = (kind: string) => view.items.filter((item) => item.kind === kind);
  assert.equal(byKind("land")[0]!.plain, 'Approve to add "Checkout" to main (2 files · +10 −1). Its tests passed. Your Supervisor merges it and wraps it up.');
  assert.match(byKind("commit")[0]!.plain!, /^Approve to save AGENTS\.md in the project's history \(a git commit\)\./);
  assert.match(byKind("tests")[0]!.plain!, /^Nothing to approve yet\./);
  assert.ok(view.items.every((item) => item.plain), "no card leaves the Human to decode an agent's report");
  assert.deepEqual(view.items.filter(approvable).map((item) => item.kind).sort(), ["commit", "land"], "red tests and questions are never approved in bulk");
});

test("agents failing on one model make one card with the way out, and the Leads' questions about it fold into it", () => {
  const ledger = emptyLedger();
  ledger.lanes.L1 = { id: "L1", title: "Project: Checkout", status: "open", branch: "sw/L1", base: "main", lead: "lead-1" } as never;
  ledger.tasks["L1-T1"] = { id: "L1-T1", lane: "L1", title: "a", status: "working", peer: "peer-1" } as never;
  ledger.tasks["L1-T2"] = { id: "L1-T2", lane: "L1", title: "b", status: "working", peer: "peer-2" } as never;
  ledger.asks.q = { id: "q", from: "lead-1", fromRole: "lead", to: "sup", kind: "blocked", text: "My Peer fails: Model not found: cursor/luna. Switch it?", status: "open", openedAt: 0, reminders: 0 };
  ledger.asks.r = { id: "r", from: "lead-1", fromRole: "lead", to: "sup", kind: "scope", text: "Which module?", status: "open", openedAt: 0, reminders: 0 };
  const seat = (id: string) => ({ id, provider: "sw2-peer-pi", model: "cursor/luna", cwd: "/project", status: "idle", updatedAt: "" });
  const failures = new Map([["peer-1", { role: "Peer", message: "Model not found: cursor/luna" }], ["peer-2", { role: "Peer", message: "Model not found: cursor/luna" }]]);
  const view = teamBrief(binding(), [seat("peer-1"), seat("peer-2")], () => ledger, [], { reports: () => new Map(), diff: () => null, teamFiles: () => [], failures: () => failures });
  const card = view.items[0]!;
  assert.deepEqual([card.kind, card.action, card.title], ["error", "models", "An AI model isn't working"]);
  assert.equal(card.plain, "2 Peers in Project stopped because the model cursor/luna gave an error. Pick another model in Team & models, then ask your Supervisor to start the work again. 1 team question about this is folded into this card.");
  assert.deepEqual(view.items.filter((i) => i.kind === "question").map((i) => i.detail), ["Which module?"], "a question about something else stays");
  assert.equal(view.items.filter((i) => i.action === "models").length, 1);
  assert.equal(view.projects[0]!.streams![0]!.title, "Checkout", "the project's name is not repeated in its own work");
});
