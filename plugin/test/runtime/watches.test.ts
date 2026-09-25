import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../server/catalog/kit.ts";
import type { Seats, SeatView } from "../../server/core/ports.ts";
import { follow } from "../../server/core/stream.ts";
import { SeatWatch, Watches } from "../../server/runtime/watch/watches.ts";
import { FakeTimeline, settle } from "./fake-timeline.ts";
import { laneWithPeer } from "./harness.ts";

const kit = loadKit(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

function seatsWith(timelines: Map<string, FakeTimeline>): Seats {
  return {
    watch: (id, see) => {
      const timeline = timelines.get(id) ?? new FakeTimeline();
      timelines.set(id, timeline);
      return follow(timeline, see, { log: () => {} });
    },
  } as Seats;
}

const seat = (id: string, provider: string): SeatView => ({ id, provider, cwd: "/tmp/p", status: "running", updatedAt: new Date().toISOString() });

test("a seat created while the round sweeps is followed once, and only the roles that are watched", () => {
  const timelines = new Map<string, FakeTimeline>();
  const watches = new Watches({ kit, seats: seatsWith(timelines), context: () => undefined, found: () => {}, on: () => true, log: () => {} });
  const peer = seat("p1", "sw2-peer-codex/gpt-5.6-sol");
  watches.follow(peer);
  watches.sync([peer, seat("s1", "sw2-supervisor-claude/claude-opus-5"), seat("r1", "sw2-reviewer-claude/claude-opus-5"), seat("l1", "sw2-lead-claude/claude-opus-5")]);
  watches.follow(peer);
  assert.equal(timelines.get("p1")!.subscriptions, 1);
  assert.deepEqual([...timelines.keys()].sort(), ["l1", "p1"], "Leads and Peers are watched; a Supervisor and a Reviewer are not");
});

test("a seat archived while it is being joined leaves no subscription behind, and is followed again if it comes back", async () => {
  const timelines = new Map<string, FakeTimeline>();
  let open: () => void = () => {};
  const slow = new FakeTimeline();
  slow.ready = new Promise((resolve) => (open = resolve));
  timelines.set("p1", slow);
  const watches = new Watches({ kit, seats: seatsWith(timelines), context: () => undefined, found: () => {}, on: () => true, log: () => {} });
  watches.follow(seat("p1", "sw2-peer-codex/gpt-5.6-sol"));
  watches.drop("p1");
  open();
  await settle();
  assert.equal(slow.listeners.size, 0);
  assert.equal((watches.get("p1") !== undefined), false);
  watches.sync([seat("p1", "sw2-peer-codex/gpt-5.6-sol")]);
  assert.equal((watches.get("p1") !== undefined), true);
});

test("a seat the round no longer sees is let go, and one that failed to join is tried again next round", async () => {
  const timelines = new Map<string, FakeTimeline>();
  const broken = new FakeTimeline();
  broken.refetch = async () => ({ epoch: "e", entries: [], error: "no such agent" });
  timelines.set("p2", broken);
  const watches = new Watches({ kit, seats: seatsWith(timelines), context: () => undefined, found: () => {}, on: () => true, log: () => {} });
  watches.sync([seat("p1", "sw2-peer-codex/gpt-5.6-sol"), seat("p2", "sw2-peer-codex/gpt-5.6-sol")]);
  await settle();
  assert.equal((watches.get("p2") !== undefined), false, "a join that failed is not held as followed");
  watches.sync([seat("p2", "sw2-peer-codex/gpt-5.6-sol")]);
  assert.equal((watches.get("p1") !== undefined), false);
  assert.equal(timelines.get("p1")!.listeners.size, 0);
  assert.equal(broken.subscriptions, 2);
});

test("with the watch switched off nothing is followed, and switching it off lets go of what already was", async () => {
  const timelines = new Map<string, FakeTimeline>();
  let on = false;
  const watches = new Watches({ kit, seats: seatsWith(timelines), context: () => undefined, found: () => {}, on: () => on, log: () => {} });
  const peer = seat("p1", "sw2-peer-codex/gpt-5.6-sol");
  watches.follow(peer);
  watches.sync([peer]);
  assert.equal(watches.get("p1"), undefined, "off means off: not followed at all, rather than read in code alone");
  assert.equal(timelines.has("p1"), false, "and no subscription is opened for it");
  on = true;
  watches.sync([peer]);
  await settle();
  assert.notEqual(watches.get("p1"), undefined);
  on = false;
  watches.sync([peer]);
  assert.equal(watches.get("p1"), undefined, "turning it off lets go on the next round, with no reload");
  assert.equal(timelines.get("p1")!.listeners.size, 0);
});

test("a seat's brief is read again until the ledger has placed it", () => {
  // A Peer's first turn starts before start_task places it, so an empty first read must not be kept.
  let placed = false;
  const rules = { destructive: /x^/, testPath: /x^/, suppressed: /x^/, gates: [], cwd: "/work", repeatsAt: 3, recoverWithin: 10 };
  const watch = new SeatWatch({ id: "p1", provider: "sw2-peer-claude", cwd: "/work" }, () => ({ rules: { ...rules, owned: placed ? ["src/a.ts"] : undefined }, handedBack: () => undefined, goal: placed ? "Task L1-T1: a" : "", context: "", beside: [], role: "Peer", can: [] }));
  assert.equal(watch.brief()?.goal, "");
  placed = true;
  assert.equal(watch.brief()?.goal, "Task L1-T1: a");
  assert.deepEqual(watch.brief()?.rules.owned, ["src/a.ts"]);
});

test("a refusal from the desk reaches no one as a failed call, while a command that failed does", async () => {
  const { h, timeline } = await laneWithPeer("outbox-watch-refused.json", { attention: { watch: true }, roles: { peer: { harness: "claude", model: "claude-opus-5" } } });
  timeline.beat("turn_started", "t1");
  timeline.add({ type: "user_message", text: "Clean the build" }, "t1");
  // A Peer's refused hand-back, as Claude Code records a team call the desk turned down.
  timeline.add({ type: "tool_call", callId: "r1", name: "mcp__team__done", status: "failed", detail: { type: "unknown", input: { outcome: "complete" }, output: "This task is already accepted; there is nothing to hand back." }, error: { message: "Tool call failed" } }, "t1");
  timeline.add({ type: "tool_call", callId: "c1", name: "Bash", status: "failed", detail: { type: "shell", command: "cat ./missing.txt", output: "" } }, "t1");
  await settle();
  const facts = readFileSync(join(h.project.state, "events.log"), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.kind === "watch.fact");
  assert.deepEqual(facts.map((event) => [event.fact, event.quote]), [["call-failed", "Bash: cat ./missing.txt"]]);
  h.runtime.dispose();
});
