import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { RISKY_PATHS } from "../../server/catalog/team.ts";
import { saveIncidents } from "../../server/desk/incidents.ts";
import { type Lane, type Task, emptyLedger } from "../../server/desk/ledger.ts";
import { landCheck } from "../../server/desk/landing.ts";
import type { Project } from "../../server/desk/project.ts";
import { tempDir } from "../tempdir.ts";

const checks = { plan: "shadow" as const, approve: "risky" as const, approver: "human" as const, risk: RISKY_PATHS, land: "on" as const, landApprove: "risky" as const, landLines: 1000 };
const passed = { set: true, ok: true };

/** A repository whose main holds a test with two assertions, and a lane branch the test writes on. */
function shop() {
  const root = tempDir("sw2-landing-");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { encoding: "utf-8" });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("src/cart.ts", "export const total = 1;\n");
  write("test/cart.test.ts", "assert.equal(total, 1);\nassert.ok(total);\n");
  write("test/old.test.ts", "assert.ok(true);\n");
  write("package-lock.json", "{}\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "seed");
  git("checkout", "-qb", "lane/l1");
  const commit = () => {
    git("add", "-A");
    git("commit", "-qm", "work");
  };
  const project: Project = { root, slug: "shop-abc123", state: tempDir("sw2-landing-state-") };
  const lane = { id: "L1", title: "Cart", outcome: "a cart", acceptance: [], outOfScope: [], base: "main", branch: "lane/l1", writeSet: ["src/**", "test/**"], contracts: [], opener: "sup", status: "open", openedAt: 0, tasks: 0, ready: { at: 0 } } as unknown as Lane;
  const ledger = emptyLedger();
  ledger.lanes.L1 = lane;
  return { root, write, commit, project, lane, ledger };
}

const task = (id: string, extra: Partial<Task>): Task =>
  ({ id, lane: "L1", kind: "code", mode: "lane", title: `Task ${id}`, goal: "", acceptance: [], owned: [], outOfScope: [], status: "merged", openedAt: 0, updatedAt: 0, silent: 0, ...extra }) as Task;

test("a lane with nothing in it to worry about lands on evidence alone: what changed, and the gate", async () => {
  const { write, commit, project, lane, ledger } = shop();
  write("src/cart.ts", "export const total = 2;\n");
  write("test/cart.test.ts", "assert.equal(total, 2);\nassert.ok(total);\nassert.ok(total > 0);\n");
  commit();
  const checked = await landCheck(project, ledger, lane, passed, checks);
  assert.deepEqual(checked.signals, []);
  assert.deepEqual(checked.evidence, ["1 commit; 2 files, 5 lines changed.", "Gate: passed on the lane.", "Tests changed: test/cart.test.ts."]);
});

test("each thing that should reach a person before a lane lands is named, one enough to hold it", async () => {
  const { root, write, commit, project, lane, ledger } = shop();
  write("test/cart.test.ts", "assert.equal(total, 1);\nit.skip('later', () => {});\n");
  rmSync(join(root, "test/old.test.ts"));
  write("src/auth/login.ts", "export const login = 1;\n");
  write("docs/notes.md", "x\n".repeat(600));
  write("src/big.ts", "y\n".repeat(500));
  write("package-lock.json", `${"{}\n".repeat(900)}`);
  commit();
  ledger.tasks["L1-T1"] = task("L1-T1", { handback: { file: "", outcome: "complete", summary: "", at: 0, gate: { ok: false, note: "npm test: the gate failed with exit 1" } } });
  ledger.tasks["L1-R1"] = task("L1-R1", { kind: "review", status: "done", handback: { file: "", outcome: "changes", summary: "", at: 0 } });
  saveIncidents(project.state, {
    next: 4,
    items: {
      I1: { id: "I1", seat: "peer-1", where: "w", lane: "L1", task: "L1-T1", kind: "test-weakened", level: "attend", quote: "q", facts: [], opened: 0, last: 0, count: 1, open: true },
      I2: { id: "I2", seat: "peer-2", where: "w", lane: "L2", kind: "destructive", level: "page", quote: "q", facts: [], opened: 0, last: 0, count: 1, open: true },
      I3: { id: "I3", seat: "peer-1", where: "w", lane: "L1", task: "L1-T1", kind: "agreed_without_checking", level: "attend", quote: "q", facts: [], p: 0.8, opened: 0, last: 0, count: 1, open: true },
    },
  });
  const checked = await landCheck(project, ledger, lane, { set: true, ok: false }, checks);
  assert.deepEqual(checked.signals, [
    "The gate failed on the lane, and landing was asked for over it.",
    "test/old.test.ts is deleted.",
    "test/cart.test.ts: adds a skip marker.",
    "src/auth/login.ts is a path this project counts as risky.",
    "1104 lines changed, over the 1000 this project reviews in one sitting.",
    "docs/notes.md is outside the lane's write set, src/**, test/**.",
    "package-lock.json is outside the lane's write set, src/**, test/**.",
    "L1-T1 was accepted over its red gate: npm test: the gate failed with exit 1.",
    "Incident I1 on this lane is still open: test-weakened.",
  ]);
  assert.match(checked.evidence.join("\n"), /L1-R1 review: changes\./);
  // A question the sensor answered is shown, and holds nothing on its own.
  assert.match(checked.evidence.join("\n"), /Incident I3 on this lane is open, from the sensor's reading: agreed_without_checking\./);
});

test("a project without a gate is held, and its evidence says no gate ran", async () => {
  const { write, commit, project, lane, ledger } = shop();
  write("src/cart.ts", "export const total = 3;\n");
  commit();
  assert.deepEqual((await landCheck(project, ledger, lane, { set: false, ok: true }, checks)).signals, ["This project has no gate, so nothing ran the lane's checks."]);
  assert.match((await landCheck(project, ledger, lane, { set: false, ok: true }, checks)).evidence.join("\n"), /Gate: none set\./);
});

test("a lane its Lead has not reported ready as it now stands is held: never reported, or amended since", async () => {
  const { write, commit, project, lane, ledger } = shop();
  write("src/cart.ts", "export const total = 4;\n");
  commit();
  delete lane.ready;
  assert.deepEqual((await landCheck(project, ledger, lane, passed, checks)).signals, ["Its Lead has not reported it ready as it now stands: never, or the lane was amended since."]);
});
