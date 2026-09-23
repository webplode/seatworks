import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../server/catalog/kit.ts";
import type { Seen } from "../../server/core/ports.ts";
import type { StreamMessage } from "../../server/core/stream.ts";
import { DESTRUCTIVE, FACT_LEVELS, FACT_TITLES, type Fact, type Rules, SUPPRESSED, TEST_PATH, onDetail, stuck } from "../../server/runtime/watch/facts.ts";
import { weigh } from "../../server/runtime/watch/jev/rules.ts";
import { SeatWatch } from "../../server/runtime/watch/watches.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kit = loadKit(join(here, "..", ".."));
// The kit no longer ships Devin, but its recorded ACP stream still stands for an agent whose exit line reads as completed.
const DEVIN_EXIT = "^Exited with code ([0-9]+)$";

const fixture = (name: string): StreamMessage[] =>
  readFileSync(join(here, "..", "fixtures", "stream", `${name}.jsonl`), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const rules = (extra: Partial<Rules> = {}): Rules => ({
  destructive: new RegExp(DESTRUCTIVE, "i"),
  testPath: new RegExp(TEST_PATH, "i"),
  suppressed: new RegExp(SUPPRESSED, "i"),
  gates: [],
  repeatsAt: 3,
  recoverWithin: 10,
  ...extra,
});

function toSeen(message: StreamMessage, epochs: Map<string, number>): Seen | undefined {
  const { event } = message;
  if (event.type === "turn_started") return { kind: "turn", phase: "started", turnId: event.turnId ?? null };
  if (event.type === "turn_completed") return { kind: "turn", phase: "completed", turnId: event.turnId ?? null };
  if (event.type !== "timeline" || typeof message.seq !== "number") return undefined;
  if (!epochs.has(message.epoch!)) epochs.set(message.epoch!, epochs.size);
  const replay = epochs.get(message.epoch!)! > 0;
  return { kind: "row", row: { item: event.item!, seq: message.seq, epoch: message.epoch!, turnId: event.turnId ?? null, replay } };
}

function play(messages: StreamMessage[], given: Rules, heard = false) {
  const watch = new SeatWatch({ id: "s1", provider: "sw2-peer-claude", cwd: "/work" }, () => ({ rules: given, heardSince: () => heard, goal: "", context: "", beside: [], role: "Peer" }));
  const facts: (Fact & { seq?: number })[] = [];
  const epochs = new Map<string, number>();
  let now = 1_000;
  for (const message of messages) {
    const fresh = typeof message.epoch === "string" && epochs.size > 0 && !epochs.has(message.epoch);
    const seen = toSeen(message, epochs);
    if (!seen) continue;
    if (fresh) watch.see({ kind: "reset" }, now);
    now += 1_000;
    for (const fact of watch.see(seen, now)) facts.push({ ...fact, seq: message.seq });
  }
  return facts;
}

const kinds = (facts: Fact[]) => facts.map((fact) => fact.kind);

test("a failed shell call is seen on every harness however it says so, once, and never again from a reload's history", () => {
  for (const harness of ["claude", "pi", "codex", "devin"]) {
    const exit = harness === "devin" ? DEVIN_EXIT : kit.harnesses[harness]?.exitPattern;
    const facts = play(fixture(harness), rules(exit ? { exit: new RegExp(exit) } : {}));
    const failures = facts.filter((fact) => fact.kind === "call-failed");
    assert.equal(failures.length, 1, `${harness}: ${JSON.stringify(facts)}`);
    assert.match(failures[0]!.quote, /cat \.\/does-not-exist\.txt/, harness);
    assert.ok(!kinds(facts).includes("destructive"), harness);
  }
});

test("Devin's failures are visible only through the exit pattern its harness declares", () => {
  assert.deepEqual(kinds(play(fixture("devin"), rules())).filter((kind) => kind === "call-failed"), [], "without the pattern a failed command reads as completed");
});

test("an irreversible command is caught the moment its command is known, before the call finishes, and only once", () => {
  const rewritten = fixture("claude").map((message) => JSON.parse(JSON.stringify(message).replaceAll("sleep 4; echo step-one", "rm -rf build")) as StreamMessage);
  const facts = play(rewritten, rules()).filter((fact) => fact.kind === "destructive");
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.level, "page");
  assert.equal(facts[0]!.seq, 3, "Claude's first row for the call has no command; the second has it, and the call is still running");
  const settledAt = rewritten.find((message) => message.event.item?.status === "completed" && JSON.stringify(message).includes("rm -rf build"))!.seq!;
  assert.ok(facts[0]!.seq! < settledAt);
});

const piRow = (seq: number) => fixture("pi").find((message) => message.seq === seq && message.epoch === fixture("pi")[1]!.epoch)!;

function again(message: StreamMessage, callId: string, seq: number, change: (detail: Record<string, unknown>) => void = () => {}): StreamMessage {
  const copy = JSON.parse(JSON.stringify(message)) as StreamMessage;
  copy.event.item!.callId = callId;
  change(copy.event.item!.detail as Record<string, unknown>);
  copy.seq = seq;
  copy.epoch = fixture("pi")[1]!.epoch;
  return copy;
}

const opening = (): StreamMessage[] => [fixture("pi")[0]!, fixture("pi")[1]!];

test("the same action failing three times is stuck", () => {
  const failedCat = piRow(15);
  const messages = [...opening(), again(failedCat, "a", 2), again(failedCat, "b", 3), again(failedCat, "c", 4)];
  const stuck = play(messages, rules()).filter((fact) => fact.kind === "stuck");
  assert.equal(stuck.length, 1);
  assert.match(stuck[0]!.quote, /the same action failing 3 times: bash: cat \.\/does-not-exist\.txt/);
});

test("the same action with the same result four times is stuck, and three is not", () => {
  const done = piRow(11);
  const three = [...opening(), again(done, "a", 2), again(done, "b", 3), again(done, "c", 4)];
  assert.deepEqual(kinds(play(three, rules())).filter((kind) => kind === "stuck"), []);
  const stuck = play([...three, again(done, "d", 5)], rules()).filter((fact) => fact.kind === "stuck");
  assert.match(stuck[0]!.quote, /the same action with the same result 4 times: bash: sleep 4; echo step-one/);
});

test("alternating between two actions three times is stuck", () => {
  const done = piRow(11);
  const other = (callId: string, seq: number) => again(done, callId, seq, (detail) => (detail.command = "ls"));
  const messages = [...opening(), again(done, "a", 2), other("b", 3), again(done, "c", 4), other("d", 5), again(done, "e", 6), other("f", 7)];
  const stuck = play(messages, rules()).filter((fact) => fact.kind === "stuck");
  assert.match(stuck[0]!.quote, /alternating between two actions 3 times/);
});

test("saying the same thing three times with nothing done between is stuck", () => {
  const said = fixture("pi").find((message) => message.event.item?.type === "assistant_message")!;
  const say = (seq: number, id: string) => {
    const copy = JSON.parse(JSON.stringify(said)) as StreamMessage;
    copy.event.item = { ...copy.event.item!, messageId: id, text: "Let me check the file again." };
    copy.seq = seq;
    return copy;
  };
  const stuck = play([...opening(), say(2, "m1"), say(3, "m2"), say(4, "m3"), again(piRow(11), "x", 5)], rules()).filter((fact) => fact.kind === "stuck");
  assert.match(stuck[0]!.quote, /the same words 3 times/);
});

test("a failure the seat has not climbed out of in ten steps is noticed, and a pass of the same command ends it", () => {
  const failedCat = piRow(15);
  const done = piRow(11);
  const steps = (count: number, from: number) => Array.from({ length: count }, (_, index) => again(done, `ok-${from + index}`, from + index, (detail) => (detail.command = `echo ${index}`)));
  const lost = play([...opening(), again(failedCat, "bad", 2), ...steps(10, 3)], rules()).filter((fact) => fact.kind === "no-recovery");
  assert.equal(lost.length, 1);
  const cured = again(failedCat, "good", 3, (detail) => Object.assign(detail, { exitCode: 0, output: "hello" }));
  const recovered = play([...opening(), again(failedCat, "bad", 2), { ...cured, event: { ...cured.event, item: { ...cured.event.item!, status: "completed" } } }, ...steps(10, 4)], rules());
  assert.deepEqual(kinds(recovered).filter((kind) => kind === "no-recovery"), []);
});

test("an edit that takes assertions out of a test, or silences a check, is noticed when it lands", () => {
  const edit = fixture("devin").find((message) => message.event.item?.type === "tool_call" && message.event.item?.name === "edit" && message.event.item?.status === "completed")!;
  const weakened = again(edit, "e1", 2, (detail) =>
    Object.assign(detail, { filePath: "test/strings.test.ts", oldString: "assert.equal(a, 1);\nassert.equal(b, 2);", newString: "assert.equal(a, 1);" }),
  );
  const silenced = again(edit, "e2", 3, (detail) => Object.assign(detail, { filePath: "src/a.ts", oldString: "const x = f();", newString: "// @ts-ignore\nconst x = f();" }));
  const facts = play([...opening(), weakened, silenced], rules());
  assert.deepEqual(
    facts.filter((fact) => fact.level === "attend").map((fact) => [fact.kind, fact.quote]),
    [
      ["test-weakened", "test/strings.test.ts: 2 assertions become 1"],
      ["suppressed", "src/a.ts: adds @ts-ignore"],
    ],
  );
});

test("a turn that reports having written files the gate never saw afterwards is unverified, and one that ran it is not", () => {
  const edit = fixture("devin").find((message) => message.event.item?.type === "tool_call" && message.event.item?.name === "edit" && message.event.item?.status === "completed")!;
  const wrote = again(edit, "w", 2, (detail) => Object.assign(detail, { filePath: "src/a.ts" }));
  const gate = again(piRow(11), "g", 3, (detail) => Object.assign(detail, { command: "npm test" }));
  const start: StreamMessage = { event: { type: "turn_started", turnId: "t" } };
  const end: StreamMessage = { event: { type: "turn_completed", turnId: "t" } };
  const skipped = play([start, fixture("pi")[1]!, wrote, end], rules({ gates: ["npm test"] }), true);
  assert.deepEqual(kinds(skipped).filter((kind) => kind === "unverified"), ["unverified"]);
  assert.deepEqual(kinds(play([start, fixture("pi")[1]!, wrote, gate, end], rules({ gates: ["npm test"] }), true)).filter((kind) => kind === "unverified"), []);
  assert.deepEqual(kinds(play([start, fixture("pi")[1]!, wrote, end], rules({ gates: ["npm test"] }), false)).filter((kind) => kind === "unverified"), [], "a turn that reported nothing claimed nothing");
  // The runner the gate's script starts is the gate too, on one module's tests as on all of them.
  const own = again(piRow(11), "g", 3, (detail) => Object.assign(detail, { command: 'node --test "test/text/slug.test.js"' }));
  assert.deepEqual(kinds(play([start, fixture("pi")[1]!, wrote, own, end], rules({ gates: ["npm test", "node --test"] }), true)).filter((kind) => kind === "unverified"), []);
});

const claudeTurn2 = () =>
  fixture("claude")
    .filter((message) => message.epoch === fixture("claude")[1]!.epoch || !message.epoch)
    .map((message) => JSON.parse(JSON.stringify(message).replace(/sleep 5; echo (alpha|beta|gamma)/g, "npm test")) as StreamMessage)
    .map((message) => {
      const item = message.event.item;
      if (item?.type === "tool_call" && item.name === "Bash" && item.status === "completed") Object.assign(item, { status: "failed", error: { content: "1 failing" } });
      return message;
    });

test("Claude's task notifications are not calls, so three failing runs of one command are the same action failing three times", () => {
  const facts = play(claudeTurn2(), rules());
  assert.equal(facts.filter((fact) => fact.kind === "call-failed" && fact.quote.includes("npm test")).length, 3);
  assert.match(facts.find((fact) => fact.kind === "stuck")!.quote, /the same action failing 3 times: Bash: npm test/);
});

test("two actions alternating are stuck only when their results alternate too", () => {
  const done = piRow(11);
  const moving = (callId: string, seq: number, command: string, output: string) => again(done, callId, seq, (detail) => Object.assign(detail, { command, output }));
  const progressing = [...opening(), moving("a", 2, "npm test", "3 failing"), moving("b", 3, "vim", "x"), moving("c", 4, "npm test", "2 failing"), moving("d", 5, "vim", "x"), moving("e", 6, "npm test", "1 failing"), moving("f", 7, "vim", "x")];
  assert.deepEqual(kinds(play(progressing, rules())).filter((kind) => kind === "stuck"), []);
});

test("a failure is climbed out of when the same program passes, and the latest failure is the one tracked", () => {
  const failedCat = piRow(15);
  const done = piRow(11);
  const run = (callId: string, seq: number, command: string, ok: boolean) =>
    again(ok ? done : failedCat, callId, seq, (detail) => Object.assign(detail, { command, ...(ok ? { exitCode: 0 } : {}) }));
  const steps = (count: number, from: number) => Array.from({ length: count }, (_, index) => again(done, `ok-${from + index}`, from + index, (detail) => (detail.command = `cat file${index}`)));
  const cured = play([...opening(), run("f", 2, "npm test", false), run("p", 3, "npm test 2>&1 | tail -30", true), ...steps(12, 4)], rules());
  assert.deepEqual(kinds(cured).filter((kind) => kind === "no-recovery"), []);
  const moved = play([...opening(), run("probe", 2, "rg legacyFlag src", false), run("f", 3, "npm test", false), ...steps(10, 4)], rules());
  assert.match(moved.find((fact) => fact.kind === "no-recovery")!.quote, /`npm test` failed/, "the fact names the failure the seat is in now, not an earlier probe");
});

test("a test's title saying should is not an assertion", () => {
  const edit = fixture("devin").find((message) => message.event.item?.type === "tool_call" && message.event.item?.name === "edit" && message.event.item?.status === "completed")!;
  const renamed = again(edit, "e", 2, (detail) =>
    Object.assign(detail, { filePath: "test/a.test.ts", oldString: 'it("should add", () => { assert.equal(add(1, 1), 2); });', newString: 'it("adds", () => { assert.equal(add(1, 1), 2); });' }),
  );
  assert.deepEqual(kinds(play([...opening(), renamed], rules())), []);
});

test("an edit that arrives as a unified diff is read for weakened tests too", () => {
  const edit = fixture("codex").find((message) => message.event.item?.name === "apply_patch" && message.event.item?.status === "completed")!;
  const patched = again(edit, "p", 2, (detail) => {
    for (const key of Object.keys(detail)) if (key !== "type") delete detail[key];
    Object.assign(detail, { type: "edit", filePath: "test/a.test.ts", unifiedDiff: "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1,3 +1,2 @@\n assert.equal(a, 1);\n-assert.equal(b, 2);\n+// later\n" });
  });
  assert.deepEqual(kinds(play([...opening(), patched], rules())), ["test-weakened"]);
});

test("Devin's constant exit line is not a result, so repeating a command there is not the same result four times", () => {
  const exit = new RegExp(DEVIN_EXIT);
  const ran = fixture("devin").find((message) => message.event.item?.type === "tool_call" && message.event.item?.status === "completed" && JSON.stringify(message).includes("Exited with code 0"))!;
  const four = [...opening(), ...["a", "b", "c", "d"].map((id, index) => again(ran, id, index + 2, (detail) => (detail.command = "git status")))];
  assert.deepEqual(kinds(play(four, rules({ exit }))).filter((kind) => kind === "stuck"), []);
});

test("a second loop in the same turn is reported, once the first has been broken", () => {
  const failedCat = piRow(15);
  const done = piRow(11);
  const fail = (callId: string, seq: number, command: string) => again(failedCat, callId, seq, (detail) => (detail.command = command));
  const loop = [...opening(), fail("a", 2, "make"), fail("b", 3, "make"), fail("c", 4, "make"), again(done, "ok", 5), fail("d", 6, "cargo build"), fail("e", 7, "cargo build"), fail("f", 8, "cargo build")];
  assert.equal(kinds(play(loop, rules())).filter((kind) => kind === "stuck").length, 2);
});

test("a message steered into a long turn does not make it long again", () => {
  const watch = new SeatWatch({ id: "s1", provider: "sw2-peer-claude", cwd: "/work" }, () => ({ rules: rules(), heardSince: () => false, goal: "", context: "", beside: [], role: "Peer" }));
  const t0 = Date.parse("2026-09-19T10:00:00Z");
  watch.see({ kind: "turn", phase: "started", turnId: "t" }, t0);
  assert.equal(watch.longTurn(t0 + 40 * 60_000, 30).length, 1);
  watch.see({ kind: "row", row: { item: { type: "user_message", text: "Also check the README" }, seq: 1, epoch: "e", turnId: "t", replay: false } }, t0 + 40 * 60_000);
  assert.deepEqual(watch.longTurn(t0 + 45 * 60_000, 30), []);
});

test("a commit message written to the temp directory is not a write the gate has to see", () => {
  const edit = fixture("devin").find((message) => message.event.item?.type === "tool_call" && message.event.item?.name === "edit" && message.event.item?.status === "completed")!;
  const wrote = again(edit, "w", 2, (detail) => Object.assign(detail, { filePath: "/work/src/a.ts" }));
  const gate = again(piRow(11), "g", 3, (detail) => Object.assign(detail, { command: "npm test" }));
  const message = again(edit, "m", 4, (detail) => Object.assign(detail, { filePath: "/var/folders/xy/T/msg" }));
  const start: StreamMessage = { event: { type: "turn_started", turnId: "t" } };
  const end: StreamMessage = { event: { type: "turn_completed", turnId: "t" } };
  assert.deepEqual(kinds(play([start, fixture("pi")[1]!, wrote, gate, message, end], rules({ gates: ["npm test"], cwd: "/work" }), true)).filter((kind) => kind === "unverified"), []);
  // Devin names a file it creates "Wrote <path>", which read as a relative path inside the project.
  const created = again(edit, "c", 5, (detail) => Object.assign(detail, { filePath: "Wrote /var/folders/xy/T/bench.mjs" }));
  assert.deepEqual(kinds(play([start, fixture("pi")[1]!, wrote, gate, created, end], rules({ gates: ["npm test"], cwd: "/work" }), true)).filter((kind) => kind === "unverified"), []);
  const inside = again(edit, "i", 5, (detail) => Object.assign(detail, { filePath: "Wrote ./src/b.ts" }));
  assert.deepEqual(kinds(play([start, fixture("pi")[1]!, wrote, gate, inside, end], rules({ gates: ["npm test"], cwd: "/work" }), true)).filter((kind) => kind === "unverified"), ["unverified"]);
});

test("irreversible commands are caught where a command starts, in any flag order, and not in quoted text", () => {
  const destructive = new RegExp(DESTRUCTIVE, "i");
  for (const command of ["rm -r -f build", "sudo rm -rf /", "cd x && rm -fr dist", "find . -exec rm -f {} \;", "bash -c \"rm -rf tmp\"", "git -C repo push --force", "git branch -df feat", "git branch -d -f feat", "git branch --delete --force x"]) {
    assert.equal(destructive.test(command), true, command);
  }
  for (const command of ["echo 'rm -rf /'", "grep -rn 'git reset --hard' docs", "terraform -chdir=x plan", "git branch -d feat", "git branch -f feat HEAD", "rm -i a"]) {
    assert.equal(destructive.test(command), false, command);
  }
});

test("a failure stretch ends when the same program passes, but a red gate is not climbed out of by another script passing", () => {
  const failedCat = piRow(15);
  const done = piRow(11);
  const run = (callId: string, seq: number, command: string, ok: boolean) =>
    again(ok ? done : failedCat, callId, seq, (detail) => Object.assign(detail, { command, ...(ok ? { exitCode: 0 } : {}) }));
  const steps = (count: number, from: number) => Array.from({ length: count }, (_, index) => again(done, `ok-${from + index}`, from + index, (detail) => (detail.command = `cat file${index}`)));
  assert.deepEqual(kinds(play([...opening(), run("a", 2, "rg legacyFlag src", false), run("b", 3, "rg otherThing src", true), ...steps(12, 4)], rules())).filter((kind) => kind === "no-recovery"), []);
  assert.deepEqual(kinds(play([...opening(), run("a", 2, "npm run check", false), run("b", 3, "npm run lint", true), ...steps(10, 4)], rules())).filter((kind) => kind === "no-recovery"), ["no-recovery"]);
});

test("Devin's constant exit line is not a result, so alternating commands there are not stuck", () => {
  const exit = new RegExp(DEVIN_EXIT);
  const ran = fixture("devin").find((message) => message.event.item?.type === "tool_call" && message.event.item?.status === "completed" && JSON.stringify(message).includes("Exited with code 0"))!;
  const cycle = [...opening(), ...Array.from({ length: 6 }, (_, index) => again(ran, `c${index}`, index + 2, (detail) => (detail.command = index % 2 ? "gh run view 123 --json status" : "sleep 30")))];
  assert.deepEqual(kinds(play(cycle, rules({ exit }))).filter((kind) => kind === "stuck"), []);
});

test("a whole-file rewrite of a test is read against what the seat last read of it, and one with nothing to compare says nothing", () => {
  const read = { event: { type: "timeline", item: { type: "tool_call", callId: "r", name: "Read", status: "completed", detail: { type: "read", filePath: "/work/test/a.test.ts", content: "assert.equal(a, 1);\nassert.equal(b, 2);\n// eslint-disable-next-line\n" } }, turnId: "t" }, seq: 2, epoch: fixture("pi")[1]!.epoch } as StreamMessage;
  const write = (seq: number, content: string) => ({ event: { type: "timeline", item: { type: "tool_call", callId: `w${seq}`, name: "Write", status: "completed", detail: { type: "write", filePath: "/work/test/a.test.ts", content } }, turnId: "t" }, seq, epoch: fixture("pi")[1]!.epoch }) as StreamMessage;
  const weakened = play([...opening(), read, write(3, "assert.equal(a, 1);\n// eslint-disable-next-line\n")], rules());
  assert.deepEqual(kinds(weakened), ["test-weakened"], "the existing eslint-disable is not a new one");
  assert.deepEqual(kinds(play([...opening(), write(3, "assert.equal(a, 1);\n// eslint-disable-next-line\n")], rules())), [], "a write with no before cannot be said to weaken anything");
});

test("a Codex diff cut short is not read as assertions removed", () => {
  const edit = fixture("codex").find((message) => message.event.item?.name === "apply_patch" && message.event.item?.status === "completed")!;
  const cut = again(edit, "p", 2, (detail) => {
    for (const key of Object.keys(detail)) if (key !== "type") delete detail[key];
    Object.assign(detail, { type: "edit", filePath: "test/a.test.ts", unifiedDiff: "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1,2 +1,2 @@\n assert.equal(a, 1);\n-assert.equal(b, 2);\n...[truncated 900 chars]" });
  });
  assert.deepEqual(kinds(play([...opening(), cut], rules())), []);
});

test("a suppression in prose is not one, and the one quoted is the one added", () => {
  const edit = fixture("devin").find((message) => message.event.item?.type === "tool_call" && message.event.item?.name === "edit" && message.event.item?.status === "completed")!;
  const prose = again(edit, "d", 2, (detail) => Object.assign(detail, { filePath: "README.md", oldString: "", newString: "Pass it as\nany other value." }));
  const second = again(edit, "e", 3, (detail) => Object.assign(detail, { filePath: "src/b.ts", oldString: "// eslint-disable-next-line\nf();", newString: "// eslint-disable-next-line\nf();\n// @ts-ignore\ng();" }));
  const facts = play([...opening(), prose, second], rules());
  assert.deepEqual(facts.map((fact) => [fact.kind, fact.quote]), [["suppressed", "src/b.ts: adds @ts-ignore"]]);
});

test("a write to the temp directory is scratch space, while one elsewhere outside the copy is outside its scope", () => {
  const edit = fixture("devin").find((message) => message.event.item?.type === "tool_call" && message.event.item?.name === "edit" && message.event.item?.status === "completed")!;
  const temp = again(edit, "m", 2, (detail) => Object.assign(detail, { filePath: "/var/folders/xy/T/msg" }));
  const ssh = again(edit, "k", 3, (detail) => Object.assign(detail, { filePath: "/Users/me/.ssh/config" }));
  assert.deepEqual(play([...opening(), temp, ssh], rules({ cwd: "/work", temp: "/var/folders/xy/T" })).map((fact) => [fact.kind, fact.quote]), [["outside-scope", "/Users/me/.ssh/config"]]);
});

test("the gate named in an unverified fact is masked like any other quote", () => {
  const edit = fixture("devin").find((message) => message.event.item?.type === "tool_call" && message.event.item?.name === "edit" && message.event.item?.status === "completed")!;
  const wrote = again(edit, "w", 2, (detail) => Object.assign(detail, { filePath: "src/a.ts" }));
  const gate = "GITHUB_TOKEN=ghp_0123456789abcdefghijklmn npm test";
  const facts = play([{ event: { type: "turn_started", turnId: "t" } }, fixture("pi")[1]!, wrote, { event: { type: "turn_completed", turnId: "t" } }], rules({ gates: [gate] }), true);
  assert.doesNotMatch(facts.find((fact) => fact.kind === "unverified")!.quote, /ghp_0123/);
});

test("the end of a turn that is not the one the seat is in does not close it", () => {
  const watch = new SeatWatch({ id: "s1", provider: "sw2-peer-claude", cwd: "/work" }, () => ({ rules: rules(), heardSince: () => false, goal: "", context: "", beside: [], role: "Peer" }));
  watch.see({ kind: "turn", phase: "started", turnId: "turn-2" }, 1_000);
  watch.see({ kind: "turn", phase: "completed", turnId: "turn-1" }, 2_000);
  assert.equal(watch.running, true);
  watch.see({ kind: "turn", phase: "completed", turnId: "turn-2" }, 3_000);
  assert.equal(watch.running, false);
});

test("an instruction arriving mid-turn is a new subject, so the reading before it no longer counts as the one before", () => {
  const watch = new SeatWatch({ id: "s1", provider: "sw2-peer-claude", cwd: "/work" }, () => ({ rules: rules(), heardSince: () => false, goal: "", context: "", beside: [], role: "Peer" }));
  const questions = { drifting: { view: "work" as const, instructions: "q", threshold: 0.7, level: "attend" as const, alone: true } };
  const answer = { answers: { drifting: 0.9 }, model: "m" };
  const findings = (before?: Record<string, number>) => weigh(answer, questions, [], { unclear: 0.2, ended: false, before }).findings.length;

  watch.see({ kind: "turn", phase: "started", turnId: "t" }, 1_000);
  watch.reading = { turnId: "t", answers: answer.answers };
  assert.equal(findings(watch.reading.answers), 1, "twice high about one subject is what opens a standing condition mid-turn");

  watch.see({ kind: "row", row: { item: { type: "user_message", text: "No, leave the pricing alone" }, seq: 2, epoch: "e", turnId: "t", replay: false } });
  assert.equal(findings(watch.reading?.answers), 0, "one answer about the old instruction and one about the new are two subjects, not twice about one");
  assert.equal(watch.reading, undefined, "the turn runs on, but what the seat was told to do has changed");
});

test("Claude's task notifications stay in what the sensor reads, though nothing counts them", () => {
  const watch = new SeatWatch({ id: "s1", provider: "sw2-peer-claude", cwd: "/work" }, () => ({ rules: rules(), heardSince: () => false, goal: "", context: "", beside: [], role: "Peer" }));
  for (const message of claudeTurn2()) {
    if (message.event.type !== "timeline") continue;
    watch.see({ kind: "row", row: { item: message.event.item!, seq: message.seq!, epoch: message.epoch!, turnId: message.event.turnId ?? null, replay: false } });
  }
  assert.ok(watch.window.units.some((unit) => unit.kind === "call" && unit.call.name === "task_notification" && unit.call.pseudo));
});

test("every fact that can open an incident has a title a person can read", () => {
  // A note is sensor evidence and never an incident on its own, so only the other levels need a title.
  for (const [kind, level] of Object.entries(FACT_LEVELS)) {
    if (level === "note") assert.equal(FACT_TITLES[kind], undefined, `${kind} never reaches a screen`);
    else assert.ok(FACT_TITLES[kind] && !/[-_]/.test(FACT_TITLES[kind]!.split(" ")[0]!), `${kind} has no readable title`);
  }
});

test("an irreversible command is quoted where it is irreversible, however long what comes before it", () => {
  // A page once quoted the first 200 characters, cut right where the `rm -rf` target began.
  const command = `cat ${"/long/path/segment".repeat(12)}/wrap.js > ${"/long/path/segment".repeat(6)}/wrap.js && rm -rf /Users/me/stray-copy`;
  const [fact] = onDetail({ id: "c", name: "Bash", status: "completed", ended: true, detail: { type: "shell", command } } as never, rules());
  assert.equal(fact?.kind, "destructive");
  assert.match(fact!.quote, /rm -rf \/Users\/me\/stray-copy$/);
  assert.equal(fact!.quote.length <= 201, true, fact!.quote);
});

test("calls the record cannot tell apart are not read as one call repeated", () => {
  // Paseo records a Claude seat's MCP calls with an empty input, so four different start_task calls compared equal.
  const call = (id: string, detail: Record<string, unknown>) => ({ kind: "call" as const, call: { id, name: "mcp__team__start_task", status: "completed", ended: true, error: null, detail: { type: "unknown", ...detail } } as never });
  const bare = ["1", "2", "3", "4"].map((id) => call(id, { input: {}, output: "started" }));
  assert.equal(stuck(bare, { repeatsAt: 3 }), undefined);
  const same = ["1", "2", "3", "4"].map((id) => call(id, { input: { title: "x" }, output: "started" }));
  assert.match(stuck(same, { repeatsAt: 3 }) ?? "", /the same action with the same result/, "the same call with the same arguments still is");
});

test("removing only scratch files is not an irreversible command, and anything else in the same line still is", () => {
  // A Lead writing a commit message to $TMPDIR and removing it afterwards was paged as destructive.
  const shell = (command: string) => onDetail({ id: "c", name: "Bash", status: "completed", ended: true, detail: { type: "shell", command } } as never, rules({ temp: "/var/folders/xy/T" }));
  assert.deepEqual(shell(`cat > "$TMPDIR/msg" <<'EOF'\nfix: merge\nEOF\ngit commit -F "$TMPDIR/msg" && rm -f "$TMPDIR/msg"`), []);
  assert.deepEqual(shell("rm -rf /tmp/sw2-probe ${TMPDIR}/x /var/folders/xy/T/y"), []);
  const [kept] = shell(`rm -f "$TMPDIR/msg" && rm -rf src`);
  assert.equal(kept?.kind, "destructive");
  assert.match(kept!.quote, /rm -rf src/);
  assert.equal(shell("rm -rf /tmp/a src").length, 1, "one real target among scratch ones is enough");
});
