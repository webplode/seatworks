import assert from "node:assert/strict";
import { test } from "node:test";
import { reported } from "../console.ts";
import { settle } from "./fake-timeline.ts";
import { laneWithPeer } from "./harness.ts";
import { book, hookAgent, noticesOf } from "./noticed.ts";

test("a seat is followed once while it is seated and watched, let go when it goes, and followed again after a failed join or a lost stream", async (t) => {
  const said = reported(t);
  const { h, sup, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  const followed = (id: string) => h.timelineOf(id).subscriptions;
  assert.deepEqual([lead, peer, sup].map(followed), [1, 1, 0], "Leads and Peers are watched; a Supervisor is not");
  await h.runtime.created(hookAgent(h, peer));
  const reviewer = h.add("sw3-reviewer-claude/claude-opus-5", h.root, "rev");
  await h.tick();
  assert.deepEqual(
    [followed(peer), followed(reviewer)],
    [1, 0],
    "followed once however often it is seen; a Reviewer not",
  );

  const slow = h.add("sw3-peer-claude/claude-opus-5", h.root, "slow");
  let open = () => {};
  h.timelineOf(slow).ready = new Promise((resolve) => (open = resolve));
  await h.runtime.created(hookAgent(h, slow));
  await h.runtime.archived(hookAgent(h, slow));
  open();
  await settle();
  assert.equal(h.timelineOf(slow).listeners.size, 0, "a seat archived while it is being joined leaves nothing behind");
  await h.tick();
  assert.equal(followed(slow), 2, "and is followed again if it comes back");

  const broken = h.add("sw3-peer-claude/claude-opus-5", h.root, "broken");
  h.timelineOf(broken).refetch = async () => ({ epoch: "e", entries: [], error: "no such agent" });
  await h.tick();
  await settle();
  await h.tick();
  assert.equal(followed(broken), 2, "a join that failed is not held as followed, and is tried again next round");
  assert.match(said(), new RegExp(`${broken} could not be watched`));

  h.agents.get(slow)!.archivedAt = new Date().toISOString();
  await h.tick();
  assert.equal(h.timelineOf(slow).listeners.size, 0, "a seat the round no longer sees is let go");

  h.timelineOf(lead).fail("socket closed");
  await settle();
  await h.tick();
  assert.equal(followed(lead), 2, "a stream Paseo released is followed again the next round");
  assert.match(said(), new RegExp(`${lead} is no longer watched: socket closed`));
});

test("a Peer's turn as the watch reads it, and who hears of it", async (t) => {
  const { h, sup, lane, peer, timeline } = await laneWithPeer();
  const lead = lane.lead!;
  await h.call(sup, "supervisor", "set_project", { gate: "npm test", gateOn: "lane" });
  const noticed = noticesOf(h, t);
  const call = (callId: string, name: string, status: string, detail: Record<string, unknown>, error?: unknown) =>
    timeline.add({ type: "tool_call", callId, name, status, detail, ...(error ? { error } : {}) }, "t1");
  timeline.beat("turn_started", "t1");
  timeline.add({ type: "user_message", text: "Clean the build" }, "t1");
  // A refused hand-back, as a Peer's call to the team server records it.
  const refusal =
    'MCP tool \'done\' returned an error: [\n  {\n    "type": "text",\n    "text": "This task is already merged; there is nothing to hand back."\n  }\n]';
  call("r1", "mcp__team__done", "failed", { type: "plain_text", label: "done", text: refusal }, { message: "failed" });
  call("c1", "Bash", "failed", { type: "shell", command: "cat ./missing.txt", output: "" });
  await settle();
  await noticed();
  assert.deepEqual(
    h.events("watch.fact").map((event) => [event.fact, event.quote]),
    [["call-failed", "Bash: cat ./missing.txt"]],
    "a refusal from the desk reaches no one as a failed call, while a command that failed does",
  );
  assert.deepEqual(h.events("incident.open"), [], "a failed call is a note: evidence, opening no incident");

  call("c2", "Bash", "running", { type: "unknown", input: {}, output: null });
  call("c2", "Bash", "running", { type: "shell", command: "rm -rf build node_modules" });
  await settle();
  await noticed();
  await h.idle(sup);
  const told = h.agents.get(sup)!.sent.join("\n");
  assert.match(told, /INCIDENT I1 \(destructive, page\) on the Peer on L1-T1 \(Clean build\)/);
  assert.match(told, /What was seen: rm -rf build node_modules/);
  assert.match(told, /not a verdict/);
  assert.ok(!timeline.rows.some((row) => row.item.status === "completed"), "the call it warns about is still running");
  assert.deepEqual(
    h.runtime.outbox.letters().filter((letter) => letter.to === peer),
    [],
    "nothing the watch concluded is even queued for the seat it watches",
  );
  await h.idle(peer);
  const watched = h.agents.get(peer)!;
  assert.deepEqual(
    [...watched.sent, ...watched.steered].filter((text) => /INCIDENT|destructive|rm -rf|incident/i.test(text)),
    [],
    "nor reaches it when its turn ends",
  );
  const asked = await h.call(sup, "supervisor", "message", { to: "L1-T1", text: "Why rm -rf build node_modules?" });
  assert.equal(asked.ok, true, "the command it ran is its own words, which whoever supervises may name back to it");
  assert.ok(
    watched.labels["paseo.parent-agent-id"],
    "a seat the desk starts under another has a parent, so Paseo never pushes its reply to the Human's phone",
  );

  call("c3", "Bash", "running", { type: "shell", command: "rm -rf dist" });
  const edit = {
    type: "edit",
    filePath: "src/a.ts",
    oldString: "const x = f();",
    newString: "// @ts-ignore\nconst x = f();",
  };
  call("c4", "Edit", "completed", edit);
  await settle();
  await noticed();

  await h.tick(Date.now() + 31 * 60_000);
  await noticed();
  await h.idle(lead);
  await h.idle(sup);
  assert.match(
    h.agents.get(sup)!.sent.join("\n"),
    /INCIDENT I\d+ \(long-turn, attend\)/,
    "a turn that runs long is told to whoever supervises, W's only reader",
  );
  assert.doesNotMatch(h.agents.get(lead)!.sent.join("\n"), /INCIDENT/);

  await h.call(peer, "peer", "done", { outcome: "complete", summary: "Cleaned" });
  for (const id of ["m1", "m2", "m3"])
    timeline.add({ type: "assistant_message", text: "Let me look at the build again.", messageId: id }, "t1");
  timeline.beat("turn_completed", "t1");
  await settle();
  await noticed();
  const [stuck, unchecked] = ["stuck", "unverified"].map((kind) =>
    Object.values(book(h)).find((item) => item.kind === kind)!,
  );
  assert.ok(
    Number(stuck!.id.slice(1)) < Number(unchecked!.id.slice(1)),
    "the loop is ranked above the unchecked claim, so it opens first",
  );
  assert.deepEqual([stuck!.told !== undefined, unchecked!.told !== undefined], [true, true], "and both are told");
});

test("a failure goes unrecovered after as many steps as the settings say", async (t) => {
  const { h, timeline } = await laneWithPeer({ attention: { recoverWithin: 2 } });
  const noticed = noticesOf(h, t);
  const run = (callId: string, command: string, status: string) =>
    timeline.add(
      { type: "tool_call", callId, name: "Bash", status, detail: { type: "shell", command, output: "" } },
      "t1",
    );
  timeline.beat("turn_started", "t1");
  timeline.add({ type: "user_message", text: "Fix the build" }, "t1");
  run("c1", "make build", "failed");
  run("c2", "ls", "completed");
  run("c3", "cat Makefile", "completed");
  await settle();
  await noticed();
  assert.deepEqual(
    h.events("watch.fact").flatMap((event) => (event.fact === "no-recovery" ? [event.quote] : [])),
    ["2 steps since `make build` failed, and neither it nor the gate has passed since"],
  );
});
