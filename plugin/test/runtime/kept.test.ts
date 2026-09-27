import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type harness, laneWithPeer } from "./harness.ts";

type Harness = ReturnType<typeof harness>;

const task = (key: string, title: string, path = "a.txt", extra: Record<string, unknown> = {}) => ({
  key,
  title,
  goal: "g",
  acceptance: ["a"],
  ...(extra.parallel ? { holds: [path] } : { hints: [path] }),
  outOfScope: ["the rest of the repository"],
  ...extra,
});

/** The Peer commits `text` to `file` in the lane's copy and hands its task back, and the Lead accepts it and it merges. */
async function acceptWork(h: Harness, lead: string, peer: string, id: string, file = "a.txt", text = `${id}\n`) {
  h.commit(h.ledger().lanes.L1!.worktree!, file, text);
  const done = await h.call(peer, "peer", "done", { outcome: "complete", summary: text.trim() });
  assert.equal(done.ok, true, done.text);
  await h.idle(peer);
  const accepted = await h.call(lead, "lead", "accept", { task: id });
  assert.equal(accepted.ok, true, accepted.text);
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks[id]!.status, "merged");
  return accepted.text;
}

const live = (h: Harness) =>
  [...h.agents.values()]
    .filter((agent) => agent.provider.startsWith("sw3-peer-") && !agent.archivedAt)
    .map((agent) => agent.id);

const kept = (id: string, seat: string) =>
  new RegExp(
    `- ${id} [^:]+: merged, hand-back \\d+ min ago; its Peer ${seat} idle \\d+ min is kept until its Lead releases it`,
  );

test("a Peer whose task is accepted is kept for rework until its Lead releases it, and the lane's copy never has two writers", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  const say = async (tool: string, args: Record<string, unknown>) => (await h.call(lead, "lead", tool, args)).text;
  const status = () => say("status", {});
  assert.match(
    await say("release", { task: "L1-T1" }),
    /L1-T1 is running: accept it first, or cut it, which stops its Peer\./,
  );

  await h.call(lead, "lead", "add_tasks", { tasks: [task("u", "Second", "a.txt", { after: ["L1-T1"] })] });
  assert.match(await acceptWork(h, lead, peer, "L1-T1"), /^L1-T1 is in the merge queue\./);
  const second = h.ledger().tasks["L1-T2"]!;
  assert.equal(second.status, "running");
  assert.notEqual(second.peer, peer, "a task never goes to a Peer that worked another");
  assert.deepEqual(live(h), [peer, second.peer], "and the Peer kept is not let go for it");
  assert.match(
    h.heard(lead).join("\n"),
    new RegExp(`Started L1-T2 in the lane's working copy on ${second.branch} with Peer ${second.peer}\\.`),
  );
  assert.match(
    await status(),
    new RegExp(
      `- L1-T1 Clean build: merged, hand-back \\d+ min ago; its Peer ${peer} idle \\d+ min is kept until its Lead releases it`,
    ),
  );
  const message = await h.call(lead, "lead", "message", { to: "L1-T1", text: "why a.txt?" });
  assert.equal(message.ok, false);
  assert.match(
    message.text,
    /^L1-T1 is merged, and its Peer is kept only to take rework: send rework if its work must change\./,
    "not with the Peer said to be gone",
  );
  assert.match(
    (await h.call(sup, "supervisor", "message", { to: "L1-T1", text: "why a.txt?" })).text,
    /^L1-T1 is merged, and its Peer is kept only to take rework: ask its Lead to send rework if its work must change\./,
    "whoever supervises holds no rework of its own",
  );
  assert.match(
    await say("amend_task", { task: "L1-T1", why: "totals move to cents", goal: "totals in cents" }),
    /^L1-T1 is merged, and its Peer is kept on it: send what changes with rework\./,
  );
  assert.match(await say("rework", { task: "L1-T1", text: "x" }), /L1-T2 holds the lane's working copy/);
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "merged", "and nothing moved");

  await acceptWork(h, lead, second.peer!, "L1-T2");
  assert.deepEqual(live(h), [peer, second.peer], "one kept for each accepted task");
  const both = await status();
  assert.match(both, kept("L1-T1", peer));
  assert.match(both, kept("L1-T2", second.peer!));
  await h.call(lead, "lead", "start_review", { task: "L1-T2", focus: "Is it right?" });
  assert.match(await say("release", { task: "L1-R1" }), /^L1-R1 is a review: its reviewer goes when you cut it\./);
  await h.call(lead, "lead", "cut", { task: "L1-R1", reason: "read it" });

  const ready = await h.call(lead, "lead", "report", { summary: "the lane is done", ready: true });
  assert.equal(ready.ok, true, ready.text);
  assert.ok(h.ledger().lanes.L1!.ready, "reported ready");
  const sent = await h.call(lead, "lead", "rework", {
    task: "L1-T1",
    text: "the lane review found the total off by one",
  });
  assert.equal(sent.ok, true, sent.text);
  const reopened = h.ledger().tasks["L1-T1"]!;
  assert.deepEqual(
    [reopened.status, reopened.peer, h.git(lane.worktree!, "branch", "--show-current").trim()],
    ["rework", peer, reopened.branch],
    "the same Peer, on its own branch again",
  );
  h.git(lane.worktree!, "merge-base", "--is-ancestor", lane.branch, "HEAD");
  assert.equal(h.ledger().lanes.L1!.ready, undefined, "a lane with a task open again is not ready");
  await h.idle(peer);
  assert.match(h.heard(peer).join("\n"), /REWORK requested by your lead\n\nthe lane review found the total off by one/);
  await acceptWork(h, lead, peer, "L1-T1", "a.txt", "fixed\n");

  const released = await h.call(lead, "lead", "release", { task: "L1-T1" });
  assert.equal(released.ok, true, released.text);
  assert.match(released.text, /The Peer kept from L1-T1 is released\./);
  assert.ok(h.agents.get(peer)!.archivedAt);
  assert.match(await say("release", { task: "L1-T1" }), /The Peer kept from L1-T1 is gone already\./);
  assert.match(
    await say("amend_task", { task: "L1-T1", why: "totals move to cents", goal: "totals in cents" }),
    /^L1-T1 is merged; start a task for what is asked now\./,
  );

  assert.match(await status(), kept("L1-T2", second.peer!));
  h.agents.get(second.peer!)!.status = "running";
  assert.equal((await h.call(lead, "lead", "release", { task: "L1-T2" })).ok, true);
  assert.equal(h.agents.get(second.peer!)!.archivedAt, null, "archived once its turn ends, not under it");
  assert.doesNotMatch(
    await status(),
    /is kept until its Lead releases it/,
    "though Paseo lists it until that turn ends",
  );
  assert.match(
    await say("rework", { task: "L1-T2", text: "x" }),
    /The Peer on L1-T2 is gone: add a task for what must change\./,
  );
  assert.equal(h.ledger().tasks["L1-T2"]!.status, "merged");

  await h.call(lead, "lead", "add_tasks", { tasks: [task("v", "Third")] });
  const third = h.ledger().tasks["L1-T3"]!.peer!;
  await acceptWork(h, lead, third, "L1-T3");
  assert.match(await status(), kept("L1-T3", third));
  const seat = h.agents.get(third)!;
  seat.archivedAt = new Date().toISOString();
  await h.runtime.archived({ id: third, provider: seat.provider, cwd: seat.cwd, title: seat.title });
  assert.equal(h.ledger().agents[third]!.gone, true, "the Human archived it in Paseo");
  assert.doesNotMatch(await status(), /is kept until its Lead releases it/);

  await h.call(lead, "lead", "add_tasks", { tasks: [task("w", "Fourth")] });
  const fourth = h.ledger().tasks["L1-T4"]!.peer!;
  h.commit(lane.worktree!, "a.txt", "fourth\n");
  await h.call(fourth, "peer", "done", { outcome: "complete", summary: "a" });
  h.agents.get(fourth)!.archivedAt = new Date().toISOString();
  assert.match(
    await say("rework", { task: "L1-T4", text: "x" }),
    /The Peer on L1-T4 is gone: reseat the task for a fresh Peer on its branch and copy, or cut it\./,
  );
  assert.equal(h.ledger().tasks["L1-T4"]!.status, "done", "not left waiting on a rework nobody will do");

  assert.equal((await h.call(lead, "lead", "cut", { task: "L1-T4", reason: "wrong" })).ok, true);
  await h.call(lead, "lead", "add_tasks", { tasks: [task("x", "Again")] });
  assert.equal(h.ledger().tasks["L1-T5"]!.status, "running");
  h.commit(lane.worktree!, "a.txt", "the second task's work\n");
  const again = await h.call(lead, "lead", "cut", { task: "L1-T4", reason: "to be sure" });
  assert.equal(again.ok, false);
  assert.match(again.text, /^L1-T4 is already cut\.$/);
  assert.equal(
    readFileSync(join(lane.worktree!, "a.txt"), "utf-8"),
    "the second task's work\n",
    "the lane's copy is not reset under the task writing in it now",
  );
});

/** A task beside L1-T1, with `text` committed to `file` in its own copy, handed back, accepted and merged. */
async function mergedBeside(h: Harness, lead: string, title: string, file: string, text = `${file}\n`) {
  await h.call(lead, "lead", "add_tasks", { tasks: [task("p", title, file, { parallel: true })] });
  const side = Object.values(h.ledger().tasks).find((entry) => entry.title === title)!;
  h.commit(side.worktree!, file, text);
  assert.equal((await h.call(side.peer!, "peer", "done", { outcome: "complete", summary: file })).ok, true);
  await h.idle(side.peer!);
  assert.equal((await h.call(lead, "lead", "accept", { task: side.id })).ok, true);
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks[side.id]!.status, "merged");
  return h.ledger().tasks[side.id]!;
}

test("a task beside others keeps its Peer in its own copy once merged, until its Lead releases it, the Human archives it, or the lane lands", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  const side = await mergedBeside(h, lead, "Beside", "b.txt", "B\n");
  assert.equal(h.agents.get(side.peer!)!.archivedAt, null, "the merge does not let it go: its Lead does");
  assert.ok(existsSync(side.worktree!), "and it keeps the copy it works in");
  assert.match(
    (await h.call(lead, "lead", "status", {})).text,
    new RegExp(`- L1-T2 Beside: merged[^\\n]*; its Peer ${side.peer} idle \\d+ min is kept until its Lead releases it`),
  );

  const asked = await h.call(lead, "lead", "message", { to: "L1-T2", text: "why b.txt alone?" });
  assert.match(asked.text, /^(Delivered|Queued)/, "in a copy of its own, a merged task's Peer can still be asked");
  assert.match(
    (await h.call(sup, "supervisor", "message", { to: "L1-T2", text: "why b.txt alone?" })).text,
    /Its Lead has been told what reached it/,
  );
  assert.match(
    h.heard(lead).join("\n"),
    /RECONCILE L1: [^]*Integration and acceptance: L1-T2 is merged already, and nothing here changed that\./,
  );
  const answered = await h.call(side.peer!, "peer", "ask", {
    question: "b.txt only: is that enough?",
    bestGuess: "yes",
  });
  assert.equal(answered.ok, true, `and it can answer its Lead with ask: ${answered.text}`);
  const quotes = await mergedBeside(h, lead, "Quotes", "d.txt");
  assert.equal((await h.call(lead, "lead", "rework", { task: "L1-T2", text: "b wants its second line" })).ok, true);
  assert.equal(h.ledger().tasks["L1-T2"]!.status, "rework");
  assert.equal(
    h.git(side.worktree!, "show", "HEAD:d.txt"),
    "d.txt\n",
    "sent back after its merge, it takes up the lane as it stands before it reads the letter",
  );
  h.commit(side.worktree!, "b.txt", "B\nB2\n");
  assert.equal((await h.call(side.peer!, "peer", "done", { outcome: "complete", summary: "b2" })).ok, true);
  await h.idle(side.peer!);
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T2" })).ok, true);
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks["L1-T2"]!.status, "merged");
  assert.equal(h.git(lane.worktree!, "show", `${lane.branch}:b.txt`), "B\nB2\n", "the fix is in the lane");

  const released = await h.call(lead, "lead", "release", { task: "L1-T2" });
  assert.equal(released.ok, true, released.text);
  assert.ok(h.agents.get(side.peer!)!.archivedAt);
  assert.equal(existsSync(side.worktree!), false, "its copy is put away with it");
  assert.equal(h.git(h.root, "branch", "--list", side.branch!).trim(), "", "and its branch, merged into the lane");

  h.agents.get(quotes.peer!)!.archivedAt = new Date().toISOString();
  await h.tick();
  assert.equal(existsSync(quotes.worktree!), false, "the round puts away a copy whose Peer the Human archived");

  const last = await mergedBeside(h, lead, "Tail", "e.txt");
  await acceptWork(h, lead, peer, "L1-T1");
  h.agents.get(lead)!.status = "idle";
  h.agents.get(last.peer!)!.status = "running";
  const landed = await h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  assert.equal(h.git(h.root, "branch", "--list", lane.branch).trim(), "", "the lane branch goes at once");
  assert.equal(landed.ok, true, landed.text);
  assert.ok(existsSync(last.worktree!), "a kept Peer's copy is not taken from under its turn");
  h.agents.get(last.peer!)!.status = "idle";
  await h.endTurn(last.peer!, "done");
  assert.equal(existsSync(last.worktree!), false);
  assert.equal(h.git(h.root, "branch", "--list", last.branch!).trim(), "", "its work is in the landed lane");
});

test("a Lead reseats a task: its Peer goes, a fresh one takes the same branch and copy, briefed from the record the desk kept", async () => {
  const { h, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  const copy = h.ledger().lanes.L1!.worktree!;
  h.commit(copy, "a.txt", "half\n");
  await h.call(peer, "peer", "done", { outcome: "partial", summary: "Parsed the file; the totals are still wrong." });
  await h.idle(peer);
  await h.call(lead, "lead", "rework", { task: "L1-T1", text: "Totals must count refunds as negative." });
  await h.call(peer, "peer", "done", { outcome: "partial", summary: "Refunds now subtract, but tax is doubled." });
  await h.idle(peer);
  const reseat = (args: Record<string, unknown>) => h.call(lead, "lead", "reseat", args);
  assert.match((await reseat({ task: "L1-T9", why: "x" })).text, /L1-T9 is not a task in your lane/);
  const done = await reseat({ task: "L1-T1", why: "It keeps circling the same two bugs." });
  assert.equal(done.ok, true, done.text);
  const task = h.ledger().tasks["L1-T1"]!;
  const fresh = task.peer!;
  assert.notEqual(fresh, peer);
  assert.ok(h.agents.get(peer)!.archivedAt, "the Peer it had goes: one at a time on a task");
  assert.equal(h.agents.get(fresh)!.cwd, h.agents.get(peer)!.cwd, "the same copy");
  assert.equal(h.git(copy, "branch", "--show-current").trim(), task.branch, "on the same branch");
  assert.equal(task.status, "rework");
  const brief = h.agents.get(fresh)!.prompt ?? "";
  assert.match(brief, /^TASK L1-T1: Clean build/m);
  assert.match(
    brief,
    /You take over L1-T1 from the Peer that worked it before you: It keeps circling the same two bugs\./,
  );
  assert.match(
    brief,
    /Parsed the file; the totals are still wrong\.[^]*Totals must count refunds as negative\.[^]*Refunds now subtract, but tax is doubled\./,
  );
  assert.doesNotMatch(brief, /\bseat\b|incident/i);
  assert.match(done.text, new RegExp(`^L1-T1 has a fresh Peer, ${fresh}, on ${task.branch}`));

  Object.assign(h.agents.get(fresh)!, { archivedAt: new Date().toISOString(), status: "closed" });
  const again = await reseat({ task: "L1-T1", why: "Its Peer is gone." });
  assert.equal(again.ok, true, `a Peer gone is replaced the same way: ${again.text}`);
  assert.notEqual(h.ledger().tasks["L1-T1"]!.peer, fresh);
});

test("a task reseated after its Peer was gone holds the lane's copy like any other, even once its fresh Peer stalls", async () => {
  const { h, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  Object.assign(h.agents.get(peer)!, { archivedAt: new Date().toISOString(), status: "closed" });
  await h.tick();
  const gone = h.ledger().tasks["L1-T1"]!;
  assert.deepEqual([gone.status, gone.peerGone], ["stalled", true]);
  const done = await h.call(lead, "lead", "reseat", { task: "L1-T1", why: "Its Peer is gone." });
  assert.equal(done.ok, true, done.text);
  const fresh = h.ledger().tasks["L1-T1"]!.peer!;
  for (const words of ["Looking at it.", "Still looking."]) {
    await h.beginTurn(fresh);
    await h.endTurn(fresh, words);
  }
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "stalled", "its fresh Peer went quiet");
  await h.call(lead, "lead", "add_tasks", { tasks: [task("u", "Next")] });
  const next = h.ledger().tasks["L1-T2"]!;
  assert.notEqual(next.status, "running", "the copy is still L1-T1's, whose fresh Peer is there");
  assert.equal(next.peer, undefined);
});

test("a seat Paseo made though its create timed out is taken on, never made twice", async () => {
  const { h, lane } = await laneWithPeer();
  type Create = (options: { title: string }) => Promise<unknown>;
  const paseo = h.paseo as { workspaces: { ref: (id: string) => { agents: { create: Create } } } };
  const ref = paseo.workspaces.ref;
  paseo.workspaces.ref = (id) => {
    const workspace = ref(id);
    const create = workspace.agents.create;
    workspace.agents.create = async (options) => {
      await create(options);
      throw new Error("timed out waiting for the agent to start");
    };
    return workspace;
  };
  const added = await h.call(lane.lead!, "lead", "add_tasks", {
    tasks: [task("b", "Beside", "b.txt", { parallel: true })],
  });
  assert.equal(added.ok, true, added.text);
  const made = [...h.agents.values()].filter((agent) => agent.title.includes("L1-T2"));
  assert.equal(made.length, 1, "one Peer on the task");
  assert.deepEqual([h.ledger().tasks["L1-T2"]!.status, h.ledger().tasks["L1-T2"]!.peer], ["running", made[0]!.id]);
});
