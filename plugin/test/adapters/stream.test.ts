import assert from "node:assert/strict";
import { test } from "node:test";
import type { Seen } from "../../server/core/ports.ts";
import { follow } from "../../server/adapters/paseo/stream.ts";
import { SeatWatch } from "../../server/runtime/watch/watches.ts";
import { Window } from "../../server/runtime/watch/window.ts";
import { FakeTimeline, settle } from "../runtime/fake-timeline.ts";

const call = (callId: string, status: string, command?: string) => ({
  type: "tool_call",
  callId,
  name: "Bash",
  status,
  detail: command ? { type: "shell", command } : { type: "unknown" },
});

function watching(timeline: FakeTimeline, archived?: () => Promise<boolean>) {
  const seen: Seen[] = [];
  const stream = follow(timeline, (entry) => seen.push(entry), archived ? { archived } : {});
  const rows = () =>
    seen.flatMap((entry) =>
      entry.kind === "row"
        ? [{ from: entry.row.seqStart, seq: entry.row.seq, replay: entry.row.replay, epoch: entry.row.epoch }]
        : [],
    );
  const resets = () => seen.filter((entry) => entry.kind === "reset").length;
  return { seen, stream, rows, resets };
}

test("a seat joined mid-turn is told what it did before as replay and what it does after as live, each call whole and once, and the turn it is in from its start", async () => {
  const joining = new FakeTimeline();
  joining.add({ type: "user_message", text: "go" });
  joining.add(call("c1", "running", "sleep 4"));
  const joined = watching(joining);
  joining.add(call("c1", "completed", "sleep 4"));
  await joined.stream.ready;
  joining.add({ type: "assistant_message", text: "done" });
  await settle();
  assert.deepEqual(
    joined.rows(),
    [
      { from: 1, seq: 1, replay: true, epoch: "epoch-1" },
      { from: 2, seq: 3, replay: false, epoch: "epoch-1" },
      { from: 4, seq: 4, replay: false, epoch: "epoch-1" },
    ],
    "a call that finished while the stream was being joined is one row, and live, not history",
  );

  const sideBySide = new FakeTimeline();
  sideBySide.add({ type: "user_message", text: "go" });
  sideBySide.add(call("a", "running", "sleep 2"));
  sideBySide.add(call("b", "running", "ls"));
  sideBySide.add(call("b", "completed", "ls"));
  sideBySide.add(call("a", "completed", "sleep 2"));
  sideBySide.add({ type: "assistant_message", text: "Hello" });
  sideBySide.add({ type: "assistant_message", text: " world" });
  const whole = watching(sideBySide);
  await whole.stream.ready;
  assert.deepEqual(
    whole.seen.flatMap((entry) =>
      entry.kind === "row"
        ? [[entry.row.item.type, entry.row.item.callId ?? entry.row.item.text, entry.row.item.status]]
        : [],
    ),
    [
      ["user_message", "go", undefined],
      ["tool_call", "a", "completed"],
      ["tool_call", "b", "completed"],
      ["assistant_message", "Hello world", undefined],
    ],
    "calls run side by side are each told whole, though the later one finished first",
  );

  const midTurn = new FakeTimeline();
  midTurn.add({ type: "user_message", text: "go" });
  const started = Date.parse("2026-09-19T10:00:00.000Z");
  midTurn.activeTurn = { turnId: "turn-1", startedAt: new Date(started).toISOString() };
  const inTurn = watching(midTurn);
  await inTurn.stream.ready;
  assert.deepEqual(
    inTurn.seen.find((entry) => entry.kind === "turn"),
    { kind: "turn", phase: "started", turnId: "turn-1", at: started },
    "a long turn is timed from its start, not from the join",
  );
});

test("what the seat did while nobody listened is read back from where the sequence broke, live, and text read back replaces what was told", async () => {
  const beats = new FakeTimeline();
  const idle = watching(beats);
  await idle.stream.ready;
  beats.beat("turn_started");
  beats.add({ type: "plugin", pluginId: "seatworks-v3", text: "note" });
  beats.add({ type: "assistant_message", text: "x" });
  beats.beat("turn_failed", "turn-1", "boom");
  await settle();
  assert.deepEqual(
    idle.seen.map((entry) =>
      entry.kind === "row"
        ? `row ${entry.row.seq}`
        : entry.kind === "turn"
          ? `turn ${entry.phase}${entry.error ? ` ${entry.error}` : ""}`
          : entry.kind,
    ),
    ["idle", "turn started", "row 2", "turn failed boom"],
    "the join says the seat was in no turn then, and the plugin's own item is not the seat's doing",
  );

  const gap = new FakeTimeline();
  const missed = watching(gap);
  await missed.stream.ready;
  gap.add(call("c1", "running", "a"));
  gap.add(call("c1", "completed", "a"), "turn-1", true);
  gap.add(call("c2", "running", "b"), "turn-1", true);
  gap.add(call("c2", "completed", "b"));
  await settle();
  assert.deepEqual(
    missed.rows().map((row) => [row.from, row.seq]),
    [
      [1, 1],
      [1, 2],
      [3, 4],
    ],
    "each call read back whole, the one already told included",
  );
  assert.deepEqual(
    missed.rows().map((row) => row.replay),
    [false, false, false],
    "what was missed happened just now, not in history",
  );
  assert.deepEqual(gap.fetches.at(-1), { direction: "after", from: 1 });

  const text = new FakeTimeline();
  const window = new Window();
  const stream = follow(text, (seen) => seen.kind === "row" && window.add(seen.row));
  await stream.ready;
  text.add({ type: "assistant_message", text: "Hello" });
  text.add({ type: "assistant_message", text: " world" }, "turn-1", true);
  text.add(call("c1", "running", "ls"));
  await settle();
  assert.deepEqual(
    window.units.map((unit) => (unit.kind === "said" ? unit.text : unit.kind)),
    ["Hello world", "call"],
    "text read back is said once, whole",
  );
});

test("a rewind or a reload starts the timeline again as replay, whether or not it was watched through it", async () => {
  const rewound = new FakeTimeline();
  const rewind = watching(rewound);
  await rewind.stream.ready;
  rewound.add({ type: "user_message", text: "one" });
  rewound.add({ type: "user_message", text: "two" });
  await settle();
  rewound.rewind(1);
  await settle();
  assert.ok(
    rewind.seen.findIndex((entry) => entry.kind === "reset") > 0,
    "the rewind voids what was seen, told as a reset",
  );
  assert.deepEqual(rewind.rows().slice(-1), [{ from: 1, seq: 1, replay: true, epoch: "epoch-2" }]);
  rewound.add({ type: "assistant_message", text: "after" });
  await settle();
  assert.deepEqual(rewind.rows().slice(-1), [{ from: 2, seq: 2, replay: false, epoch: "epoch-2" }]);

  const reloaded = new FakeTimeline();
  const reload = watching(reloaded);
  await reload.stream.ready;
  reloaded.add({ type: "user_message", text: "go" });
  reloaded.add(call("c1", "completed", "rm -rf build"));
  await settle();
  reloaded.epoch = "epoch-2";
  const history = reloaded.rows;
  reloaded.rows = [];
  reloaded.beat("turn_started", "turn-2");
  reloaded.add({ type: "user_message", text: "again" }, "turn-2");
  for (const row of history) reloaded.add(row.item, null);
  reloaded.add(call("c2", "running", "ls"), "turn-2");
  await settle();
  assert.equal(reload.resets(), 1);
  assert.deepEqual(
    reload.rows().slice(2),
    [
      { from: 1, seq: 1, replay: false, epoch: "epoch-2" },
      { from: 2, seq: 2, replay: true, epoch: "epoch-2" },
      { from: 3, seq: 3, replay: true, epoch: "epoch-2" },
      { from: 4, seq: 4, replay: false, epoch: "epoch-2" },
    ],
    "history a reload sends again is replay, and what the seat does meanwhile is not, in whatever order they arrive",
  );

  const unwatched = new FakeTimeline();
  const tail = watching(unwatched);
  await tail.stream.ready;
  unwatched.add({ type: "user_message", text: "go" });
  await settle();
  unwatched.epoch = "epoch-9";
  unwatched.rows = [{ item: { type: "user_message", text: "go" }, seq: 1, turnId: "turn-1" }];
  unwatched.add({ type: "assistant_message", text: "hi" });
  await settle();
  assert.equal(tail.resets(), 1);
  assert.deepEqual(
    tail.rows().slice(1),
    [
      { from: 1, seq: 1, replay: true, epoch: "epoch-9" },
      { from: 2, seq: 2, replay: true, epoch: "epoch-9" },
    ],
    "a seat reloaded while nobody listened is read again from its tail, not told as a gap",
  );
});

test("a follower lets go of a seat that is gone or never answers, and reads back what a reconnect missed", async (t) => {
  const reconnected = new FakeTimeline();
  const watch = new SeatWatch({ id: "p1", provider: "sw3-peer-claude", cwd: "/work" }, () => undefined);
  const followed = follow(reconnected, (seen) => seen.kind !== "lost" && watch.see(seen));
  await followed.ready;
  reconnected.beat("turn_started");
  reconnected.add(call("c1", "running", "npm test"));
  await settle();
  reconnected.add(call("c1", "completed", "npm test"), "turn-1", true);
  reconnected.add({ type: "assistant_message", text: "done" }, "turn-1", true);
  reconnected.beat("turn_completed", "turn-1", undefined, true);
  reconnected.restore();
  await settle();
  assert.deepEqual(
    watch.window.units.map((unit) =>
      unit.kind === "call" ? unit.call.status : unit.kind === "said" ? unit.text : unit.kind,
    ),
    ["completed", "done"],
  );
  assert.deepEqual(
    watch.longTurn(Date.now() + 40 * 60_000, {
      longTurnMinutes: 30,
      longTurnTimes: 3,
      longTurnAfterTurns: 5,
      longTurnMedianOf: 20,
    }),
    [],
    "a turn that ended unseen is over, or it would read as a long turn for ever",
  );

  const stopping = new FakeTimeline();
  const stopped = watching(stopping);
  await stopped.stream.ready;
  const asked = stopping.fetches.length;
  stopping.rewind(0);
  stopped.stream.stop();
  await settle();
  assert.equal(stopping.fetches.length, asked, "Paseo resumes an agent to serve its history and never closes it");

  let archived = false;
  const archiving = new FakeTimeline();
  const gone = watching(archiving, async () => archived);
  await gone.stream.ready;
  const fetched = archiving.fetches.length;
  archived = true;
  archiving.rewind(0);
  await settle();
  assert.equal(archiving.fetches.length, fetched, "no history is asked of an archived agent");
  archiving.add({ type: "assistant_message", text: "late" });
  await settle();
  assert.equal(gone.rows().length, 0, "and nothing more is told once it has stopped");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const silent = new FakeTimeline();
  silent.ready = new Promise(() => {});
  const hung = follow(silent, () => {});
  t.mock.timers.tick(10_000);
  await assert.rejects(hung.ready, /took longer than 10000 ms/);
  assert.equal(silent.listeners.size, 0, "a join that never becomes ready leaves nothing subscribed");
});
