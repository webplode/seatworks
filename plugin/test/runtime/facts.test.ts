import assert from "node:assert/strict";
import { test } from "node:test";
import { TEAM_SERVER } from "../../server/catalog/kit/kit.ts";
import type { StreamMessage } from "../../server/adapters/paseo/stream.ts";
import { callsTo } from "../../server/runtime/watch/facts.ts";
import { SeatWatch } from "../../server/runtime/watch/watches.ts";
import { again, claudeTurn2, fixture, kinds, kit, opening, piRow, play, rules, watchOver } from "./seat-replay.ts";

const done = piRow(11);
const failedCat = piRow(15);

/** `command` run at `seq`, passing or failing as the recorded runs did. */
const run = (callId: string, seq: number, command: string, ok: boolean) =>
  again(ok ? done : failedCat, callId, seq, (detail) =>
    Object.assign(detail, { command, ...(ok ? { exitCode: 0 } : {}) }),
  );

/** `count` passing steps from `seq` on, none of them the program that failed. */
const steps = (count: number, seq: number) =>
  Array.from({ length: count }, (_, index) => run(`ok-${seq + index}`, seq + index, `echo ${index}`, true));

/** A failed call named `name`, with its own detail if given. */
const failing = (name: string, seq: number, detail?: Record<string, unknown>) => {
  const copy = again(failedCat, `t${seq}`, seq);
  Object.assign(copy.event.item!, { name, ...(detail ? { detail } : {}) });
  return copy;
};

const LIMITS = { longTurnMinutes: 30, longTurnTimes: 3, longTurnAfterTurns: 5, longTurnMedianOf: 20 };

const found = (messages: StreamMessage[], kind: string) =>
  play([...opening(), ...messages], rules()).filter((fact) => fact.kind === kind);

test("each harness's recorded turn is read into the facts it shows, once, never from a reload's history", () => {
  for (const harness of ["claude", "pi", "codex"]) {
    const facts = play(fixture(harness), rules());
    const failures = facts.filter((fact) => fact.kind === "call-failed");
    assert.equal(failures.length, 1, `${harness}: ${JSON.stringify(facts)}`);
    assert.match(failures[0]!.quote, /cat \.\/does-not-exist\.txt/, harness);
    assert.ok(!kinds(facts).includes("destructive"), harness);
  }

  // As Paseo maps an OpenCode shell call: its detail has no exit code, and the tool's own metadata rides on the item.
  const exited = (code: number) => {
    const row = again(failedCat, `cat-${code}`, 2);
    Object.assign(row.event.item!, {
      status: "completed",
      error: null,
      detail: {
        type: "shell",
        command: "cat ./does-not-exist.txt",
        output: "cat: ./does-not-exist.txt: No such file or directory\n",
      },
      metadata: { exit: code, truncated: false },
    });
    return row;
  };
  const opencode = kit.harnesses.opencode!.timeline;
  assert.deepEqual(kinds(play([...opening(), exited(1)], rules(), undefined, opencode)), ["call-failed"]);
  assert.deepEqual(kinds(play([...opening(), exited(0)], rules(), undefined, opencode)), []);
  assert.deepEqual(
    kinds(play([...opening(), exited(1)], rules())),
    [],
    "a harness that names no such field is read by the call's own status",
  );

  const notified = play(claudeTurn2(), rules());
  assert.equal(
    notified.filter((fact) => fact.kind === "call-failed" && fact.quote.includes("npm test")).length,
    3,
    "Claude's task notifications are not calls",
  );
  assert.match(
    notified.find((fact) => fact.kind === "stuck")!.quote,
    /the same action failing 3 times: Bash: npm test/,
  );

  // Paseo records a Claude seat's MCP calls with an empty input, so four different start_task calls compared equal.
  const started = (input: Record<string, unknown>) =>
    ["1", "2", "3", "4"].map((id, index) => {
      const copy = again(done, `mcp-${id}`, index + 2);
      Object.assign(copy.event.item!, {
        name: "mcp__team__start_task",
        detail: { type: "unknown", input, output: "started" },
      });
      return copy;
    });
  assert.deepEqual(found(started({}), "stuck"), [], "calls the record cannot tell apart are not one call repeated");
  assert.match(
    found(started({ title: "x" }), "stuck")[0]?.quote ?? "",
    /the same action with the same result/,
    "the same call with the same arguments still is",
  );

  const deskOf = (harness: string) =>
    rules({ desk: callsTo(kit.harnesses[harness]!.mcpCall, kit.harnesses[harness]!.mcpServerField, TEAM_SERVER) });
  assert.deepEqual(
    kinds(play([...opening(), failing("mcp__team__start_task", 2)], deskOf("claude"))),
    [],
    "a refusal the desk gave a seat is not a failed call: the desk already said why and what instead",
  );
  // Pi names a call server_tool, so a pasted team_x server's calls start the same way; the server it records tells them apart.
  const pi = [
    failing("team_plan_tasks", 2, {
      type: "unknown",
      output: {
        content: [{ type: "text", text: "Error: The plan was not taken" }],
        details: { error: "tool_error", server: "team" },
      },
    }),
    failing("team_plan_tasks", 3, {
      type: "unknown",
      output: { content: [{ type: "text", text: 'Validation failed for tool "team_plan_tasks"' }], details: {} },
    }),
    failing("team_x_lookup", 4, {
      type: "unknown",
      output: {
        content: [{ type: "text", text: "Error: not found" }],
        details: { error: "tool_error", server: "team_x" },
      },
    }),
  ];
  assert.deepEqual(
    kinds(play([...opening(), ...pi], deskOf("pi"))),
    ["call-failed", "call-failed"],
    "pi: a call Pi refused before the desk saw it, and another server's, are still failures",
  );

  const stdin = failing("terminal", 2, { type: "plain_text", text: "y\n" });
  assert.deepEqual(
    kinds(play([...opening(), stdin], rules(), undefined, kit.harnesses.codex!.timeline)),
    [],
    "Codex writing to a command's stdin is no call of the seat's own",
  );
  assert.deepEqual(kinds(play([...opening(), stdin], rules(), undefined, kit.harnesses.claude!.timeline)), [
    "call-failed",
  ]);
});

test("a seat going round in circles is stuck: failing, repeating, alternating or saying the same thing, and a second loop after the first", () => {
  const quotes = (messages: StreamMessage[]) => found(messages, "stuck").map((fact) => fact.quote);
  const failing3 = [1, 2, 3].map((n) => run(`f${n}`, n + 1, "cat ./does-not-exist.txt", false));
  assert.match(quotes(failing3).join(), /^the same action failing 3 times: bash: cat \.\/does-not-exist\.txt$/);
  assert.deepEqual(
    kinds(play([...opening(), ...failing3], rules({ stuckWithin: 2 }))).filter((kind) => kind === "stuck"),
    [],
    "only as many of its latest steps as the owner sets are read for a loop",
  );

  const three = [again(done, "a", 2), again(done, "b", 3), again(done, "c", 4)];
  assert.deepEqual(quotes(three), [], "the same result three times is not stuck");
  assert.match(
    quotes([...three, again(done, "d", 5)]).join(),
    /the same action with the same result 4 times: bash: sleep 4; echo step-one/,
  );

  const other = (callId: string, seq: number) => again(done, callId, seq, (detail) => (detail.command = "ls"));
  const alternating = [again(done, "a", 2), other("b", 3), again(done, "c", 4), other("d", 5), again(done, "e", 6)];
  assert.match(quotes([...alternating, other("f", 7)]).join(), /alternating between two actions 3 times/);
  const moving = (callId: string, seq: number, command: string, output: string) =>
    again(done, callId, seq, (detail) => Object.assign(detail, { command, output }));
  const progressing = [
    moving("a", 2, "npm test", "3 failing"),
    moving("b", 3, "vim", "x"),
    moving("c", 4, "npm test", "2 failing"),
    moving("d", 5, "vim", "x"),
    moving("e", 6, "npm test", "1 failing"),
    moving("f", 7, "vim", "x"),
  ];
  assert.deepEqual(quotes(progressing), [], "two actions alternating are stuck only when their results alternate too");

  const said = fixture("pi").find((message) => message.event.item?.type === "assistant_message")!;
  const say = (seq: number, id: string) => {
    const copy = JSON.parse(JSON.stringify(said)) as StreamMessage;
    copy.event.item = { ...copy.event.item!, messageId: id, text: "Let me check the file again." };
    copy.seq = seq;
    return copy;
  };
  assert.match(
    quotes([say(2, "m1"), say(3, "m2"), say(4, "m3"), again(done, "x", 5)]).join(),
    /the same words 3 times/,
  );

  const make = [2, 3, 4].map((seq) => run(`m${seq}`, seq, "make", false));
  const cargo = [6, 7, 8].map((seq) => run(`c${seq}`, seq, "cargo build", false));
  assert.equal(
    quotes([...make, again(done, "ok", 5), ...cargo]).length,
    2,
    "a second loop is told once the first broke",
  );
});

test("a failure not climbed out of in ten steps is noticed, ended only by the same program or the gate passing", () => {
  const lost = (messages: StreamMessage[]) => found(messages, "no-recovery").map((fact) => fact.quote);
  assert.equal(lost([run("bad", 2, "cat ./does-not-exist.txt", false), ...steps(10, 3)]).length, 1);
  const cured = run("good", 3, "cat ./does-not-exist.txt", true);
  assert.deepEqual(lost([run("bad", 2, "cat ./does-not-exist.txt", false), cured, ...steps(10, 4)]), []);
  assert.deepEqual(
    lost([run("f", 2, "npm test", false), run("p", 3, "npm test 2>&1 | tail -30", true), ...steps(12, 4)]),
    [],
    "the same program passing, as its runner starts it, ends the stretch",
  );
  assert.match(
    lost([run("probe", 2, "rg legacyFlag src", false), run("f", 3, "npm test", false), ...steps(10, 4)]).join(),
    /`npm test` failed/,
    "the fact names the failure the seat is in now, not an earlier probe",
  );
  assert.deepEqual(
    lost([run("a", 2, "rg legacyFlag src", false), run("b", 3, "rg otherThing src", true), ...steps(12, 4)]),
    [],
  );
  assert.equal(
    lost([run("a", 2, "npm run check", false), run("b", 3, "npm run lint", true), ...steps(10, 4)]).length,
    1,
    "a red gate is not climbed out of by another script passing",
  );
});

test("a seat refused again and again, by its agent's permissions or by the desk, is a refusal loop, told once until something goes through", () => {
  const refused = (seq: number, command: string) => {
    const copy = again(failedCat, `r${seq}`, seq, (detail) => Object.assign(detail, { command }));
    Object.assign(copy.event.item!, {
      error: { content: `Permission to use Bash with command ${command} has been denied.` },
    });
    return copy;
  };
  const loops = (messages: StreamMessage[]) => found(messages, "refusal-loop").map((fact) => fact.quote);
  assert.deepEqual(loops([refused(2, "git log"), refused(3, "git status"), refused(4, "git diff")]), [
    "3 refusals in a row, the last: bash: git diff",
  ]);
  assert.deepEqual(
    loops([refused(2, "git log"), refused(3, "git status"), run("ok", 4, "ls", true), refused(5, "git diff")]),
    [],
    "a call that goes through breaks the run",
  );
  assert.equal(
    loops([2, 3, 4, 5, 6].map((seq) => refused(seq, `git log -${seq}`))).length,
    1,
    "a loop is told once while it lasts",
  );
  assert.deepEqual(
    loops([run("a", 2, "cat a", false), run("b", 3, "cat b", false), run("c", 4, "cat c", false)]),
    [],
    "a failure that is no refusal is not one",
  );
});

test("a seat that ends a turn never having reached its team's tools is told of, since it can neither hand back nor ask", () => {
  let heard = false;
  const watch = watchOver(() => ({ rules: rules(), handedBack: () => undefined, heard: () => heard, placed: true }));
  const turn = (id: string): StreamMessage[] => [
    { event: { type: "turn_started", turnId: id } },
    again(done, `ok-${id}`, 2),
    { event: { type: "turn_completed", turnId: id } },
  ];
  assert.deepEqual(kinds(watch(turn("t1"))), ["desk-unreached"]);
  heard = true;
  assert.deepEqual(kinds(watch(turn("t2"))), [], "once the desk has heard from it, it is not");
});

test("a seat's turn stays open through the late end of an older turn, and a message steered into a long turn does not make it long again", () => {
  const context = () => ({ rules: rules(), handedBack: () => undefined, heard: () => true, placed: true });
  const seat = { id: "s1", provider: "sw3-peer-claude", cwd: "/work" };
  const late = new SeatWatch(seat, context);
  late.see({ kind: "turn", phase: "started", turnId: "turn-2" }, 1_000);
  late.see({ kind: "turn", phase: "completed", turnId: "turn-1" }, 2_000);
  assert.equal(late.longTurn(1_000 + 40 * 60_000, LIMITS).length, 1, "turn-2 is still running, so it is still timed");
  const ended = new SeatWatch(seat, context);
  ended.see({ kind: "turn", phase: "started", turnId: "turn-2" }, 1_000);
  ended.see({ kind: "turn", phase: "completed", turnId: "turn-1" }, 2_000);
  ended.see({ kind: "turn", phase: "completed", turnId: "turn-2" }, 3_000);
  assert.deepEqual(ended.longTurn(1_000 + 40 * 60_000, LIMITS), [], "its own end closes it");

  const steered = new SeatWatch(seat, context);
  const t0 = Date.parse("2026-09-19T10:00:00Z");
  steered.see({ kind: "turn", phase: "started", turnId: "t" }, t0);
  assert.equal(steered.longTurn(t0 + 40 * 60_000, LIMITS).length, 1);
  const message = { type: "user_message", text: "Also check the README" };
  steered.see(
    { kind: "row", row: { item: message, seqStart: 1, seq: 1, epoch: "e", turnId: "t", replay: false } },
    t0 + 40 * 60_000,
  );
  assert.deepEqual(steered.longTurn(t0 + 45 * 60_000, LIMITS), []);

  // Two 20-minute turns, then a third running for 40.
  const paced = () => {
    const watch = new SeatWatch(seat, context);
    for (const [turn, start] of [
      ["p1", 0],
      ["p2", 20],
    ] as const) {
      watch.see({ kind: "turn", phase: "started", turnId: turn }, t0 + start * 60_000);
      watch.see({ kind: "turn", phase: "completed", turnId: turn }, t0 + (start + 20) * 60_000);
    }
    watch.see({ kind: "turn", phase: "started", turnId: "p3" }, t0 + 40 * 60_000);
    return watch;
  };
  const limits = { longTurnMinutes: 30, longTurnTimes: 3, longTurnAfterTurns: 5, longTurnMedianOf: 20 };
  assert.equal(paced().longTurn(t0 + 80 * 60_000, limits).length, 1, "two turns say nothing of its pace");
  assert.deepEqual(
    paced().longTurn(t0 + 80 * 60_000, { ...limits, longTurnAfterTurns: 2 }),
    [],
    "once the owner says two turns do, forty minutes is within three of its twenty",
  );
});

test("a command refused, then run again through a shell, an eval or a script the seat just wrote, got round a guard", () => {
  const refused = (seq: number, command: string) => {
    const copy = again(failedCat, `r${seq}`, seq, (detail) => Object.assign(detail, { command }));
    Object.assign(copy.event.item!, {
      error: { content: `Permission to use Bash with command ${command} has been denied.` },
    });
    return copy;
  };
  const guards = (messages: StreamMessage[]) => found(messages, "guard").map((fact) => fact.quote);
  assert.deepEqual(guards([refused(2, "git push origin main"), run("b", 3, 'bash -c "git push origin main"', true)]), [
    'ran `git push` through `bash -c "git push origin main"` after it was refused',
  ]);
  const script = again(piRow(11), "w", 3, (detail) =>
    Object.assign(detail, { type: "write", filePath: "/tmp/p.sh", content: "#!/bin/sh\ngit push origin main\n" }),
  );
  assert.equal(guards([refused(2, "git push origin main"), script, run("c", 4, "sh /tmp/p.sh", true)]).length, 1);
  assert.deepEqual(
    guards([refused(2, "git push origin main"), run("d", 3, "git status", true)]),
    [],
    "another command is not",
  );
});

test("a seat thinking and talking with no call between, or compacting again and again, is told once while it lasts", () => {
  const words = (seq: number, count: number) =>
    Array.from({ length: count }, (_, index) => {
      const copy = again(done, `x${seq + index}`, seq + index);
      // Thoughts in a row are one; a thought and a saying, or two sayings, are two.
      const item =
        index % 2 === 0
          ? { type: "reasoning", text: `Thinking, step ${index}.` }
          : { type: "assistant_message", text: `Saying, step ${index}.`, messageId: `m${seq + index}` };
      Object.assign(copy.event, { item });
      return copy;
    });
  const compacted = (seq: number) => {
    const copy = again(done, `k${seq}`, seq);
    Object.assign(copy.event, { item: { type: "compaction" } });
    return copy;
  };
  const circling = found(words(2, 12), "stuck").map((fact) => fact.quote);
  assert.deepEqual(circling, ["10 thoughts and sayings with no call between them"]);
  assert.deepEqual(found([...words(2, 5), run("a", 7, "ls", true), ...words(8, 5)], "stuck"), [], "a call breaks it");
  assert.deepEqual(
    found([compacted(2), compacted(3), compacted(4)], "context-pressure").map((fact) => fact.quote),
    ["its context compacted 2 times since its instruction"],
  );
});

test("a command that failed and then passed with no edit between is a red two runs disagree about", () => {
  const flaky = (messages: StreamMessage[]) => found(messages, "flaky").map((fact) => fact.quote);
  assert.deepEqual(flaky([run("a", 2, "npm test", false), run("b", 3, "npm test", true)]), [
    "`npm test` failed, then passed with no edit between",
  ]);
  const edited = again(piRow(11), "w", 3, (detail) =>
    Object.assign(detail, { type: "edit", filePath: "src/a.ts", oldString: "a", newString: "b" }),
  );
  assert.deepEqual(
    flaky([run("a", 2, "npm test", false), edited, run("b", 4, "npm test", true)]),
    [],
    "a fix is no flake",
  );
});
