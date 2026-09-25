import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadKit, sensorProblems } from "../../server/catalog/kit.ts";
import { DESTRUCTIVE } from "../../server/runtime/watch/facts.ts";
import { type Step, trailOf } from "../../server/runtime/watch/trail.ts";
import { type Brief, VIEW_FIELDS, asked, viewsOf } from "../../server/runtime/watch/jev/views.ts";
import { stepText } from "../../server/runtime/watch/trail.ts";
import { Window } from "../../server/runtime/watch/window.ts";

const kit = loadKit(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const shipped = Object.values(kit.sensors)[0]!;
const row = (item: Record<string, unknown>, seq: number) => ({ item, seq, epoch: "e", turnId: "t", replay: false });
const shell = (id: string, command: string, extra: Record<string, unknown> = {}) => ({ type: "tool_call", callId: id, name: "Bash", status: "completed", detail: { type: "shell", command, output: "ok", ...extra } });
const brief = (extra: Partial<Brief> = {}): Brief => ({ role: "Peer", can: ["work", "write", "watched"], goal: "Task L1-T1: login", context: "", beside: [], gates: ["npm test", "node --test"], workingCopy: "/work/app", ...extra });
const size = (value: unknown) => JSON.stringify(value).length;

function turn(...items: Record<string, unknown>[]): Window {
  const window = new Window();
  window.add(row({ type: "user_message", text: "Fix the login bug" }, 1));
  items.forEach((item, index) => window.add(row(item, index + 2)));
  return window;
}

test("a turn is its steps in order, each with an id, and the words it ends on are its claim rather than a step", () => {
  const window = turn(shell("c1", "npm test", { output: "pass 3" }), { type: "reasoning", text: "looks right" }, { type: "assistant_message", text: "Set API_KEY=abcd1234efgh5678 and done", messageId: "m1" });
  const running = trailOf(window, false, {});
  assert.deepEqual(running.steps.map((step) => [step.id, step.kind]), [["S1", "ran"], ["S2", "thought"], ["S3", "said"]], "while the turn runs, what it says is a step like any other");
  assert.equal(running.final, undefined);
  const ended = trailOf(window, true, {});
  assert.deepEqual(ended.steps.map((step) => step.id), ["S1", "S2"]);
  assert.equal(ended.final?.id, "S3");
  assert.match(ended.final!.text, /^Set API_KEY=/);
  const { work, claim } = viewsOf(ended, brief(), 8000);
  assert.equal(claim!.claim, ended.final!.text, "read as a claim beside its evidence");
  assert.deepEqual((work!.steps as Step[]).at(-1), { id: "S3", kind: "said", text: ended.final!.text }, "and as something the seat said, where the work is read");
  assert.doesNotMatch(JSON.stringify(ended), /abcd1234efgh5678/, "no secret the seat printed");
  assert.equal(ended.instruction, "Fix the login bug");
});

test("a secret is masked before anything is cut, so no part of it survives a clip", () => {
  const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(20)}\n-----END OPENSSH PRIVATE KEY-----`;
  const trail = JSON.stringify(trailOf(turn(shell("c", "cat ~/.ssh/id_ed25519", { output: key })), false, {}));
  assert.doesNotMatch(trail, /QUJDREVGR0hJSktM/);
  assert.match(trail, /\[private key\]/);
});

test("a turn longer than the window keeps its instruction, and its ids still count from it", () => {
  const window = new Window();
  window.add(row({ type: "user_message", text: "Rename the config loader" }, 1));
  for (let index = 0; index < 85; index++) window.add(row(shell(`c${index}`, `ls dir${index}`), index + 2));
  const trail = trailOf(window, false, {});
  assert.equal(trail.instruction, "Rename the config loader");
  assert.equal(trail.lost, 5);
  assert.equal(trail.steps[0]!.id, "S6", "an id names the same step in every reading of the turn");
  window.add(row({ type: "user_message", text: "Now update the docs" }, 200));
  window.add(row(shell("d1", "ls docs"), 201));
  assert.deepEqual(trailOf(window, false, {}).steps, [{ id: "S1", kind: "ran", command: "ls docs", result: "ok", output: "ok" }]);
});

test("what a step did reaches the trail: the end of what it printed, its error when it printed nothing, and what an edit changed, with no key in it", () => {
  const edit = (id: string, detail: Record<string, unknown>) => ({ type: "tool_call", callId: id, name: "Edit", status: "completed", detail: { type: "edit", filePath: "src/a.ts", ...detail } });
  const body = "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDnewnewnewnew1";
  const trail = trailOf(
    turn(
      shell("c1", "npm test", { output: `${"😀".repeat(2000)} FAIL: expected 3 got 4`, exitCode: 1 }),
      { type: "tool_call", callId: "c2", name: "Bash", status: "failed", detail: { type: "shell", command: "cat /root/x", output: "" }, error: { message: "permission denied" } },
      edit("c3", { oldString: "const a = 1;\nconst b = 2;", newString: "const a = 1;\nconst b = 3;\nconst c = 4;" }),
      edit("c4", { unifiedDiff: "--- a/q.sql\n+++ b/q.sql\n@@ -1,4 +1,1 @@\n--- drop table users;\n--- drop table orders;\n+++i;\n SELECT 1;" }),
      edit("c5", { unifiedDiff: "--- a/k.pem\n+++ b/k.pem\n@@ -1,3 +1,3 @@\n -----BEGIN PRIVATE KEY-----\n-MIIEvQold\n+" + body + "\n -----END PRIVATE KEY-----" }),
      edit("c6", { oldString: "MIIEvQold", newString: body }),
      edit("c7", { unifiedDiff: `diff --git a/src/gen.ts b/src/gen.ts\n--- /dev/null\n+++ b/src/gen.ts\n${"+export const x = 1;\n".repeat(500)}...[truncated 900 chars]` }),
      { type: "tool_call", callId: "c9", name: "Write", status: "completed", detail: { type: "write", filePath: "src/b.ts", content: "export const a = 1;\nexport const b = 2;\n" } },
      { type: "tool_call", callId: "c10", name: "mcp__team__done", status: "completed", detail: { type: "unknown", input: { summary: "Parser fixed; all tests pass", token: "hunter2hunter2" }, output: null } },
      { type: "tool_call", callId: "c11", name: "Read", status: "completed", detail: { type: "read", filePath: "src/a.ts", content: "x" } },
    ),
    true,
    {},
  );
  const [ran, refused, changed, header, , , cut, wrote, called, read] = trail.steps as Step[] & Record<string, unknown>[];
  assert.deepEqual({ ...ran, output: undefined }, { id: "S1", kind: "ran", command: "npm test", result: "failed", exit: 1, output: undefined });
  assert.match((ran as { output: string }).output, /^…(😀)+ FAIL: expected 3 got 4$/);
  assert.doesNotMatch(JSON.stringify(trail), /\\ud[89a-f]/i, "no character is cut in half");
  assert.deepEqual(refused, { id: "S2", kind: "ran", command: "cat /root/x", result: "failed", output: "permission denied" });
  assert.deepEqual(changed, { id: "S3", kind: "changed", path: "src/a.ts", result: "ok", change: "+2 -1: const b = 3;" });
  assert.equal((header as { change: string }).change, "+1 -2: ++i;", "a line of content that starts like a diff header is content");
  assert.doesNotMatch(JSON.stringify(trail), /MIIEvgIBAD/, "a key's body is never shown, whether or not its header came with it");
  assert.match((cut as { change: string }).change, /^\+\d+ -0 \(diff cut short\): export const x = 1;$/);
  assert.equal((wrote as { change: string }).change, "wrote 2 lines: export const a = 1;");
  assert.deepEqual(called, { id: "S9", kind: "called", tool: "mcp__team__done", input: '{"summary":"Parser fixed; all tests pass","token":"[redacted]"}', result: "ok" });
  assert.deepEqual(read, { id: "S10", kind: "read", target: "src/a.ts", result: "ok" });
});

test("the part of a long command that makes it irreversible is kept", () => {
  // Steps are cut to fit from the front, which once cut a run's `rm -rf` off every state.
  const command = `cat ${"/long/path/segment".repeat(40)}/wrap.js > out.js && rm -rf /Users/me/stray-copy`;
  const [step] = trailOf(turn(shell("c", command)), false, { destructive: new RegExp(DESTRUCTIVE, "i") }).steps;
  assert.match((step as { command: string }).command, /rm -rf \/Users\/me\/stray-copy$/);
});

test("each view holds its own fields and no other, and a question is asked only over the view it names", () => {
  const trail = trailOf(turn(shell("c1", "npm test"), { type: "assistant_message", text: "Fixed; tests pass", messageId: "m1" }), true, {});
  const views = viewsOf(trail, brief({ context: "use the fake clock", beside: [{ task: "L1-T2", title: "b", owned: ["src/b.ts"] }] }), 8000);
  for (const [name, view] of Object.entries(views)) {
    for (const field of Object.keys(view)) assert.ok((VIEW_FIELDS[name as keyof typeof VIEW_FIELDS] as readonly string[]).includes(field), `${name} holds ${field}`);
  }
  assert.deepEqual(Object.keys(views).sort(), ["actions", "claim", "instruction", "work"]);
  for (const [name, question] of Object.entries(asked(shipped.questions, views, { can: brief().can, from: trail.from }))) assert.ok(views[question.view], name);
});

test("the view about what a seat did shows its acts and not what it printed or said about them", () => {
  const trail = trailOf(turn(shell("c1", "rm -rf build", { output: "removed 400 files" }), { type: "assistant_message", text: "This is expected cleanup", messageId: "m1" }, { type: "reasoning", text: "fine" }), false, {});
  const { actions } = viewsOf(trail, brief(), 8000);
  assert.deepEqual(actions!.steps, [{ id: "S1", kind: "ran", command: "rm -rf build", result: "ok" }]);
  assert.equal(actions!.working_copy, "/work/app");
});

test("a claim is read beside the check it rests on and anything changed after that check", () => {
  const edit = (id: string, path: string) => ({ type: "tool_call", callId: id, name: "Edit", status: "completed", detail: { type: "edit", filePath: path, oldString: "a", newString: "b" } });
  const claimed = (...items: Record<string, unknown>[]) => viewsOf(trailOf(turn(...items, { type: "assistant_message", text: "All tests pass", messageId: "m1" }), true, {}), brief(), 8000).claim!;
  const checked = claimed(edit("e1", "src/a.ts"), shell("c1", "node --test test/a.test.js", { output: "pass 3 fail 1", exitCode: 1 }), edit("e2", "src/b.ts"));
  assert.equal(checked.claim, "All tests pass");
  assert.deepEqual(checked.last_check, { id: "S2", kind: "ran", command: "node --test test/a.test.js", result: "failed", exit: 1, output: "pass 3 fail 1" }, "the runner the gate's script starts is a check too");
  assert.deepEqual(checked.changed_after_check, ["src/b.ts"]);
  assert.match(claimed(edit("e1", "src/a.ts")).last_check as string, /^none: nothing that runs npm test was run since the instruction$/);
  assert.equal(viewsOf(trailOf(turn(shell("c1", "ls")), true, {}), brief(), 8000).claim, undefined, "a turn that claims nothing has no claim to read");
});

test("a question about the steps straight after the instruction is not asked of a turn that lost them", () => {
  // Stating the gap in the state moved the sensor's answers by at most 0.05, so the view is not built at all.
  const window = new Window();
  window.add(row({ type: "user_message", text: "No, the rate table is not in pricing.ts" }, 1));
  window.add(row(shell("c1", "grep RATES"), 2));
  const whole = viewsOf(trailOf(window, false, {}), brief(), 8000);
  const person = { can: brief().can, from: ["person"] };
  assert.deepEqual((whole.instruction!.steps as Step[]).map((step) => step.id), ["S1"], "this view begins where the instruction did");
  assert.ok("agreed_without_checking" in asked(shipped.questions, whole, person));
  for (let index = 0; index < 85; index++) window.add(row(shell(`c${index}`, `ls dir${index}`), index + 3));
  window.add(row({ type: "assistant_message", text: "Moved it; the suite is green", messageId: "m1" }, 90));
  const holed = viewsOf(trailOf(window, true, {}), brief(), 8000);
  assert.equal(holed.instruction, undefined);
  const left = asked(shipped.questions, holed, person);
  assert.ok(!("agreed_without_checking" in left));
  assert.ok("unverified_success" in left, "a question whose subject is the claim at the end is not held back: the end is never what is lost");
});

test("a turn's instruction is told apart by who sent it: a person, or the kinds of desk letter it carries", () => {
  const from = (item: Record<string, unknown>) => {
    const window = new Window();
    window.add(row({ type: "user_message", text: "Fix it", ...item }, 1));
    return trailOf(window, false, {}).from;
  };
  assert.deepEqual(from({ clientMessageId: "sw2-rework.amended-6f1c2a", messageId: "sw2-rework.amended-6f1c2a" }), ["rework", "amended"]);
  assert.deepEqual(from({ clientMessageId: null, messageId: "0b9e5d4a" }), ["person"], "a prompt a person starts a seat with has only a random messageId");
  assert.deepEqual(from({ clientMessageId: "c-17" }), ["person"]);
});

test("a question is asked only of a role that can do what it is for, and after an instruction from one it names", () => {
  const window = new Window();
  window.add(row({ type: "user_message", text: "AMENDED L1-T3: the write set now includes migrations/" }, 1));
  window.add(row(shell("c1", "git show HEAD -- test/migrate.test.js"), 2));
  const views = viewsOf(trailOf(window, false, {}), brief(), 8000);
  const peer = ["work", "write", "watched"];
  const questions = (can: string[], from: string[]) => Object.keys(asked(shipped.questions, views, { can, from }));
  assert.ok(questions(peer, ["landback"]).includes("agreed_without_checking"), "the Human's own words sending a landing back");
  assert.ok(!questions(["lead", "watched"], ["message"]).includes("agreed_without_checking"), "a Supervisor's message is its order, as a rework is its Lead's");
  assert.ok(!questions(peer, ["amended"]).includes("agreed_without_checking"), "the desk granting what a seat asked for doubts nothing");
  assert.ok(!questions(peer, ["rework"]).includes("agreed_without_checking"), "nor is a rework a doubt: it is its Lead's order, with the Lead's evidence");
  assert.ok(questions(peer, ["answer", "landback"]).includes("agreed_without_checking"), "letters sent together are asked after if any one is");
  assert.ok(questions(peer, ["person"]).includes("proves_the_old_is_gone"));
  assert.ok(!questions(peer, ["rework"]).includes("proves_the_old_is_gone"), "a rework names a bug, and a test that it is gone is what it asks for");
  assert.ok(!questions(["lead", "watched"], ["person"]).includes("proves_the_old_is_gone"), "a Lead reading its Peer's test wrote none");
  assert.ok(questions(["lead", "watched"], ["person"]).includes("goal_drift"));
});

test("each view keeps to its cap, newest steps first, or for the instruction's view the first ones", () => {
  const window = new Window();
  window.add(row({ type: "user_message", text: "Fix the parser" }, 1));
  for (let index = 0; index < 60; index++) window.add(row(shell(`c${index}`, `grep -rn "token${index}" src/parser`, { output: "src/parser/lex.ts:12: const token = next();".repeat(3) }), index + 2));
  const goal = `Task L1-T1: parser\nGoal: ${'"quoted" and\n'.repeat(200)}`;
  for (const limit of [8000, 3000, 1000]) {
    const views = viewsOf(trailOf(window, false, {}), brief({ goal, context: "c ".repeat(400) }), limit);
    for (const [name, view] of Object.entries(views)) assert.ok(size(view) <= limit, `${name}: ${size(view)} > ${limit}`);
    const command = (step: Step | undefined) => (step?.kind === "ran" ? step.command : "");
    assert.equal(command((views.work!.steps as Step[]).at(-1)), 'grep -rn "token59" src/parser', "the newest step is kept");
    assert.equal(command((views.instruction!.steps as Step[])[0]), 'grep -rn "token0" src/parser', "and for the instruction, the first");
  }
  assert.deepEqual(sensorProblems("x", { ...shipped, id: "x", stateChars: 100 } as never), ["sends a state of fewer than 1000 characters, too few to say anything"]);
});

test("a step reads in an incident as its id and what it was", () => {
  assert.equal(stepText({ id: "S14", kind: "ran", command: "rm -rf /x", result: "failed", exit: 1 }), "S14 ran: rm -rf /x (failed, exit 1)");
  assert.equal(stepText({ id: "S3", kind: "changed", path: "src/a.ts", result: "ok", change: "+2 -1: x" }), "S3 changed src/a.ts: +2 -1: x");
  assert.equal(stepText({ id: "S2", kind: "thought", text: "patch.js is a stub" }), "S2 thought: patch.js is a stub");
});

test("a step that speaks of a file a sibling task is writing says so where it stands", () => {
  // Told in another field, the sensor still read a Peer finding its neighbour's file unwritten as inventing a stand-in.
  const trail = trailOf(
    turn(
      { type: "tool_call", callId: "c1", name: "Read", status: "completed", detail: { type: "read", filePath: "/work/app/src/json/pointer.js", content: "stub" } },
      { type: "assistant_message", text: "pointer.js is still a stub, so I resolve paths inside patch.js myself.", messageId: "m1" },
      shell("c2", "ls src/ds/heap.js"),
      shell("c3", "ls src/json/patch.js"),
    ),
    false,
    {},
  );
  const beside = [{ task: "L1-T1", title: "A1 pointer", owned: ["src/json/pointer.js"] }, { task: "L3-T2", title: "heap", owned: ["src/ds/**"] }];
  const steps = viewsOf(trail, brief({ beside }), 8000).work!.steps as Step[];
  assert.deepEqual(steps.map((step) => step.note), [
    "src/json/pointer.js is being written by L1-T1 in another copy, so it is not finished here",
    "src/json/pointer.js is being written by L1-T1 in another copy, so it is not finished here",
    "src/ds/ is being written by L3-T2 in another copy, so it is not finished here",
    undefined,
  ]);
  assert.match(String(viewsOf(trail, brief({ beside }), 8000).work!.beside), /^Being written in other copies, and so not finished here: L1-T1 \(A1 pointer\), which owns src\/json\/pointer\.js; L3-T2/);
  assert.equal(viewsOf(trail, brief(), 8000).work!.beside, undefined, "with nothing beside it, nothing is said");
});
