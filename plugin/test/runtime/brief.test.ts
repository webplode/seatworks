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
