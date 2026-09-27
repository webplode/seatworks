import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../tempdir.ts";
import { settle } from "./fake-timeline.ts";
import { harness, heldCreate, laneWithPeer } from "./harness.ts";
import { heldCall, heldLook } from "./lane-gates.ts";

type Harness = ReturnType<typeof harness>;

const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["anything else in the repository"] };
const task = (key: string, extra: Record<string, unknown>) => ({
  key,
  title: key,
  goal: "g",
  acceptance: ["a"],
  outOfScope: ["the rest of the repository"],
  ...extra,
});

async function opened(isolate = false) {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Build", ...scope, isolate });
  return { h, sup, lead: h.ledger().lanes.L1!.lead! };
}

const seats = (h: Harness, title: string) =>
  [...h.agents.values()].filter((agent) => agent.title.startsWith(title)).length;

test("two task calls at once put one writer in the lane's copy: the one that finds its task already started leaves it, and the other waits for the copy", async () => {
  const { h, lead } = await opened();
  const first = heldCreate(h, /^L1-T1 ·/);
  const planning = h.call(lead, "lead", "add_tasks", {
    tasks: [task("P", { holds: ["c.txt"], parallel: true }), task("L", { hints: ["a.txt"] })],
  });
  await first.reached;
  const second = await h.call(lead, "lead", "add_tasks", { tasks: [task("M", { hints: ["b.txt"] })] });
  assert.match(second.text, /M is L1-T3 M: held: L1-T2 is still writing in the lane's working copy/);
  first.release();
  const planned = await planning;
  assert.match(planned.text, /L is L1-T2 L: running/);
  const tasks = Object.values(h.ledger().tasks);
  assert.deepEqual(
    tasks.filter((entry) => entry.mode === "lane" && entry.status === "running").map((entry) => entry.id),
    ["L1-T2"],
  );
  assert.equal(seats(h, "L1-T2 ·"), 1);
});

test("two lanes opened at once in the project's own copy open one there, and the other is told the copy is taken", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const looked = heldLook(h, sup);
  const cart = h.call(sup, "supervisor", "open_lane", { title: "Cart", ...scope });
  await looked.reached;
  assert.equal((await h.call(sup, "supervisor", "open_lane", { title: "Order", ...scope })).ok, true);
  looked.release();
  const refused = await cart;
  assert.equal(refused.ok, false);
  assert.match(refused.text, /Lane L1 is working in the project's own copy/);
  const inOwnCopy = Object.values(h.ledger().lanes).filter((lane) => lane.status === "open" && !lane.slot);
  assert.deepEqual(
    inOwnCopy.map((lane) => lane.title),
    ["Order"],
  );
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), inOwnCopy[0]!.branch);
});

test("a waiting lane opened by a round while a close opens another opens once, and a lane asked for meanwhile finds the project's copy taken", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const open = (title: string, extra: Record<string, unknown> = {}) =>
    h.call(sup, "supervisor", "open_lane", { title, ...scope, ...extra });
  await open("Cart", { isolate: true });
  await open("Order", { isolate: true, after: ["L1"] });
  await open("Receipt", { after: ["L1"] });
  h.agents.get(h.ledger().lanes.L1!.lead!)!.status = "idle";
  const order = heldCreate(h, /^L2 · Lead/);
  const landing = h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  await order.reached;
  await h.tick(Date.now());
  const receipt = h.ledger().lanes.L3!;
  assert.deepEqual([receipt.status, receipt.slot], ["open", undefined]);
  assert.match((await open("Pay")).text, /Lane L3 is working in the project's own copy/);
  order.release();
  assert.equal((await landing).ok, true);
  assert.deepEqual([seats(h, "L2 · Lead"), seats(h, "L3 · Lead")], [1, 1]);
  assert.equal(Object.values(h.ledger().slots).filter((slot) => slot.lane === "L2").length, 1);
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), receipt.branch);
  assert.deepEqual([h.ledger().lanes.L3!.status, h.ledger().lanes.L3!.lead], ["open", receipt.lead]);
});

test("two calls reaching for the same paths at once: tasks do not both get them, and the lane written second hears of the first, whichever writes first", async () => {
  const { h, sup, lead } = await opened();
  const held = (paths: string[]) =>
    Object.values(h.ledger().tasks)
      .filter((entry) => entry.status === "running" && paths.some((path) => entry.holds.includes(path)))
      .map((entry) => entry.id);
  await h.call(lead, "lead", "add_tasks", { tasks: [task("Beside", { holds: ["b.txt"], parallel: true })] });
  const amend = (holds: string[]) =>
    h.call(lead, "lead", "amend_task", { task: "L1-T1", why: "it needs more", holds: ["b.txt", ...holds] });
  const add = (key: string, path: string) =>
    h.call(lead, "lead", "add_tasks", { tasks: [task(key, { holds: [path], parallel: true })] });

  const late = heldLook(h, lead);
  const amending = amend(["c.txt"]);
  await late.reached;
  assert.equal((await add("Other", "c.txt")).ok, true);
  late.release();
  assert.match(
    (await amending).text,
    /What it holds overlaps what L1-T2 holds at c\.txt\. Leave those paths out of L1-T1\./,
  );
  const early = heldLook(h, lead);
  const adding = add("Third", "d.txt");
  await early.reached;
  assert.equal((await amend(["d.txt"])).ok, true);
  early.release();
  assert.match((await adding).text, /holds d\.txt, which L1-T1 holds and is still writing, and does not wait for it/);
  assert.deepEqual([held(["c.txt"]), held(["d.txt"])], [["L1-T2"], ["L1-T1"]]);

  const lane = (title: string, path: string) => ({ title, ...scope, isolate: true, writeSet: [path] });
  await h.call(sup, "supervisor", "open_lane", lane("Cart", "e.txt"));
  await h.call(sup, "supervisor", "open_lane", lane("Order", "f.txt"));
  const widen = (id: string, path: string) =>
    h.call(sup, "supervisor", "amend_lane", { lane: id, why: "it needs g too", writeSet: [path, "g.txt"] });
  const looked = heldLook(h, sup);
  const cart = widen("L2", "e.txt");
  await looked.reached;
  const order = await widen("L3", "f.txt");
  looked.release();
  assert.doesNotMatch(order.text, /works beside/);
  assert.match((await cart).text, /It now works beside lanes that may write what it does: L3 \(g\.txt\)/);
});

test("two seats' turns ending at once land an ordered lane once, and put a copy back once, one ending while the other is still being ended", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  /** Ends `first`'s turn up to `call` on it in Paseo and `second`'s whole, checking what stands before and after, then lets `first` go on. */
  const endTogether = async (
    first: string,
    call: "refresh" | "archive",
    second: string,
    stands: (ended: boolean) => void,
  ) => {
    const held = heldCall(h, first, call);
    for (const id of [first, second]) h.agents.get(id)!.status = "idle";
    const ending = h.endTurn(first, "done");
    await held.reached;
    stands(false);
    await h.endTurn(second, "done");
    stands(true);
    held.release();
    await ending;
  };
  const landings = () =>
    h
      .heard(sup)
      .join("\n")
      .match(/(?<!NOT )LANDED L1 /g)?.length ?? 0;
  h.commit(lane.worktree!, "a.txt", "A\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "a" });
  await h.idle(peer);
  await h.call(lead, "lead", "accept", { task: "L1-T1" });
  await h.runtime.desk.settled(h.project);
  await h.call(lead, "lead", "start_review", { task: "L1-T1", focus: "Is a right?" });
  const reviewer = h.ledger().tasks["L1-R1"]!.peer!;
  h.commitTo("main", "other.txt", "main moved\n");
  assert.match((await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).text, /^Lane L1 lands once /);
  assert.deepEqual(h.ledger().lanes.L1!.landing?.writers.sort(), [lead, reviewer].sort());
  await endTogether(reviewer, "refresh", lead, (ended) => {
    assert.deepEqual(h.ledger().lanes.L1!.landing?.writers, ended ? undefined : [lead]);
  });
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().lanes.L1!.status, "closed");
  await h.idle(sup);
  assert.equal(landings(), 1);

  await h.call(sup, "supervisor", "open_lane", { title: "Again", ...scope });
  const again = h.ledger().lanes.L2!;
  await h.call(again.lead!, "lead", "add_tasks", { tasks: [task("Work", { hints: ["a.txt"] })] });
  const writer = h.ledger().tasks["L2-T1"]!.peer!;
  assert.equal((await h.call(sup, "supervisor", "drop_lane", { lane: "L2", reason: "no longer wanted" })).ok, true);
  assert.deepEqual(h.ledger().lanes.L2!.restoring?.writers.sort(), [again.lead!, writer].sort());
  await endTogether(writer, "archive", again.lead!, (ended) => {
    assert.deepEqual(h.ledger().lanes.L2!.restoring?.writers.sort(), ended ? [writer] : [again.lead!, writer].sort());
    assert.equal(h.git(h.root, "branch", "--show-current").trim(), h.ledger().tasks["L2-T1"]!.branch);
  });
  assert.equal(h.ledger().lanes.L2!.restoring, undefined);
  assert.equal(h.git(h.root, "branch", "--show-current").trim(), "main");
});

test("a lane closed twice at once is closed once, and the second call is told it is already being closed", async () => {
  const { h, sup, lead } = await opened();
  h.agents.get(lead)!.status = "idle";
  h.commitTo("main", "other.txt", "main moved\n");
  const looked = heldLook(h, lead);
  const landing = h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  await looked.reached;
  const dropped = await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "no longer wanted" });
  assert.equal(dropped.ok, false);
  assert.match(dropped.text, /Lane L1 is already being closed by another call/);
  looked.release();
  assert.equal((await landing).ok, true);
  assert.match(
    (await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "again" })).text,
    /Lane L1 is already closed\./,
  );
  assert.equal(h.events("lane.closed").length, 1);
});

test("a READY whose gate is still running when its lane closes is not recorded on the closed lane", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const gate = tempDir("sw3-gate-");
  await h.call(sup, "supervisor", "set_project", {
    gate: `: > ${gate}/reached; until test -f ${gate}/open; do sleep 0.02; done; true`,
    gateOn: "lane",
  });
  await h.call(sup, "supervisor", "open_lane", { title: "Slow", ...scope });
  const reporting = h.call(h.ledger().lanes.L1!.lead!, "lead", "report", { summary: "ready to land", ready: true });
  for (let i = 0; i < 500 && !existsSync(join(gate, "reached")); i++) await settle();
  assert.ok(existsSync(join(gate, "reached")));
  assert.equal((await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "no longer wanted" })).ok, true);
  writeFileSync(join(gate, "open"), "");
  const reported = await reporting;
  assert.equal(reported.ok, false, reported.text);
  assert.equal(h.ledger().lanes.L1!.ready, undefined);
});

test("an ask whose task is cut, or whose lane closes, while whoever answers is looked up is not opened", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  const toLead = heldLook(h, lead);
  const asking = h.call(peer, "peer", "ask", { question: "Which one?", bestGuess: "the first" });
  await toLead.reached;
  assert.equal((await h.call(lead, "lead", "cut", { task: "L1-T1", reason: "not needed" })).ok, true);
  toLead.release();
  assert.match((await asking).text, /L1-T1 was cut while you asked/);

  const toSup = heldLook(h, sup);
  const leading = h.call(lead, "lead", "ask", { kind: "question", text: "Which one?", default: "the first" });
  await toSup.reached;
  assert.equal((await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "no longer wanted" })).ok, true);
  toSup.release();
  const asked = await leading;
  assert.equal(asked.ok, false, asked.text);
  assert.deepEqual(Object.values(h.ledger().asks), []);
});
