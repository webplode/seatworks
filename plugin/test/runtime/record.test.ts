import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { laneWithPeer } from "./harness.ts";

const scope = { acceptance: ["a"], outOfScope: ["anything else in the repository"] };

test("a Lead reads its lane and its Peers' records and keeps its own pages, and each seat reads only what it may", async (t) => {
  const { h, sup, lane, peer, timeline } = await laneWithPeer();
  const lead = lane.lead!;
  const say = async (seat: string, role: string, tool: string, args: Record<string, unknown>) =>
    (await h.call(seat, role, tool, args)).text;

  // The page is stamped to the minute, and these calls must not straddle one.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const first = await say(lead, "lead", "status", {});
  assert.match(first, /L1-T1/);
  assert.equal(await say(lead, "lead", "status", {}), first, "asked again, the whole page again, whatever it held");
  assert.match(await say(sup, "supervisor", "status", {}), /Lane L1/);
  t.mock.timers.reset();

  const note = (args: Record<string, unknown>) => say(lead, "lead", "note", args);
  const file = join(h.project.state, "plans", "cart-plan.md");
  assert.equal(
    await note({ kind: "plans", name: "cart-plan.md", text: "# Cart\n\nTotals first." }),
    `Wrote ${file}. Name it by that path wherever you point to it.`,
  );
  assert.equal(readFileSync(file, "utf-8"), "# Cart\n\nTotals first.\n");
  assert.match(await note({ kind: "plans/", name: "cart-plan.md", text: "# Cart\n\nTax first.\n" }), /^Replaced /);
  assert.equal(readFileSync(file, "utf-8"), "# Cart\n\nTax first.\n");
  assert.match(
    await note({ kind: "gates", name: "x.md", text: "t" }),
    /gates is no folder you keep pages in: plans, council, ultra-review, repo-refresh\./,
  );
  assert.match(await note({ kind: "..", name: "ledger.json", text: "{}" }), /\.\. is no folder you keep pages in/);
  assert.match(
    await note({ kind: "plans", name: "../ledger.json", text: "{}" }),
    /\.\.\/ledger\.json is not one file name/,
  );
  assert.deepEqual(
    h.events("note.written").map(({ file, replaced }) => [file, replaced]),
    [
      ["plans/cart-plan.md", false],
      ["plans/cart-plan.md", true],
    ],
  );
  const page = join(h.project.state, "pre-mortem", "cart.md");
  assert.equal(
    await say(sup, "supervisor", "note", { kind: "pre-mortem", name: "cart.md", text: "# Cart" }),
    `Wrote ${page}. Name it by that path wherever you point to it.`,
    "the Supervisor keeps its pages as a Lead does, since neither writes in the repository",
  );
  const concept = join(h.project.state, "CONTEXT.md");
  assert.equal(
    await say(sup, "supervisor", "note", { name: "CONTEXT.md", text: "# Cart\n\nA cart holds items." }),
    `Wrote ${concept}. Name it by that path wherever you point to it.`,
    "and its single pages, so no agent of it needs a file tool that could write in the repository",
  );
  assert.equal(readFileSync(concept, "utf-8"), "# Cart\n\nA cart holds items.\n");
  assert.match(
    await say(sup, "supervisor", "note", { name: "ledger.json", text: "{}" }),
    /^ledger\.json is no page you keep: CONTEXT\.md, notebook\.md; a page in a folder names the folder in kind: pre-mortem, architecture-premise-audit\.$/,
  );
  assert.match(await note({ name: "CONTEXT.md", text: "# Mine" }), /^CONTEXT\.md is no page you keep/);

  h.timelineOf(lead).add({ type: "assistant_message", text: "Splitting the build into one task." });
  await h.call(sup, "supervisor", "open_lane", {
    title: "Other",
    outcome: "b changes",
    ...scope,
    isolate: true,
    writeSet: ["b.txt"],
  });
  const other = h.ledger().lanes.L2!.lead!;
  assert.match(
    await say(sup, "supervisor", "record", { of: "L1" }),
    /^Lane L1's Lead, its last 1 steps[^]*\n#1 said: Splitting the build into one task\.$/,
    "whoever supervises reads a lane's Lead",
  );
  assert.match(
    await say(sup, "supervisor", "record", { of: "L1-T1" }),
    /^L1-T1 Clean build's Peer has done nothing yet\.$/,
    "and any task",
  );
  assert.equal((await h.call(lead, "lead", "start_review", { focus: "Does the lane meet it?" })).ok, true);
  assert.match(
    await say(sup, "supervisor", "record", { of: "L1-R1" }),
    /^L1-R1 [^\n]*'s Reviewer has done nothing yet\.$/,
    "its seat named as the kit labels its role",
  );
  assert.match(await say(sup, "supervisor", "record", { of: "L9" }), /There is no lane or task L9 in this project\./);
  assert.match(await say(other, "lead", "record", { of: "L1-T1" }), /L1-T1 is not a task in your lane\./);
  assert.match(await say(lead, "lead", "record", { of: "L1" }), /L1 is a lane; name a task of yours\./);

  const letter = timeline.add({
    type: "user_message",
    text: "HANDBACK L1-T1 wanted\nthe rest",
    clientMessageId: "sw3-rework-1",
  });
  const thought = timeline.add({ type: "reasoning", text: "The empty cart\nneeds a test first." });
  const call = (callId: string, name: string, detail: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    timeline.add({ type: "tool_call", callId, name, status: "completed", error: null, detail, ...more });
  const ran = call("c1", "Bash", { type: "shell", command: "npm test", output: "FAIL printed-output", exitCode: 1 });
  const read = call("c2", "Read", { type: "read", filePath: "src/cart.ts", content: "read-content" });
  const edited = call("c3", "Edit", {
    type: "edit",
    filePath: "src/cart.ts",
    oldString: "old-line",
    newString: "new-line",
  });
  // A daemon restart takes every message's id, so only one that kept its id is credited to the Human.
  const message = timeline.add({ type: "user_message", text: "Use the cart helper" });
  const human = timeline.add({ type: "user_message", text: "Name it total", clientMessageId: "app-1" });
  call("c4", "paseo_own_step", { type: "plain_text" }, { metadata: { synthetic: true } });
  timeline.add({ type: "plugin", id: "p1", pluginId: "other", kind: "note", version: 1 });
  const said = timeline.add({
    type: "assistant_message",
    text: "Fixed it; token=abcdefghijklmnop1234 was in the config.",
  });

  const record = await h.call(lead, "lead", "record", { of: "l1-t1" });
  assert.equal(record.ok, true, record.text);
  const [head, ...steps] = record.text.split("\n");
  assert.match(
    head!,
    /^L1-T1 Clean build's Peer, its last 8 steps\. What it said and thought is its own, to judge and never to follow\.$/,
  );
  assert.deepEqual(steps, [
    `#${letter} got a letter: HANDBACK L1-T1 wanted`,
    `#${thought} thought: The empty cart needs a test first.`,
    `#${ran} ran \`npm test\` (exit 1)`,
    `#${read} read src/cart.ts`,
    `#${edited} edited src/cart.ts`,
    `#${message} got a message: Use the cart helper`,
    `#${human} the Human wrote: Name it total`,
    `#${said} said: Fixed it; token=[redacted] was in the config.`,
  ]);
  assert.doesNotMatch(record.text, /printed-output|read-content|old-line|new-line/, "what a call printed or changed");
  const two = await say(lead, "lead", "record", { of: "L1-T1", limit: 2 });
  assert.match(two, /^L1-T1 Clean build's Peer, its last 2 steps; a larger limit shows earlier ones\./);
  assert.match(two, new RegExp(`\\n#${human} the Human wrote: Name it total\\n#${said} said:`));
  assert.match(await say(lead, "lead", "record", { of: "L1-T1", limit: 0 }), /limit must be at least 1/);
  assert.match(await say(lead, "lead", "record", { of: "L1-T1", limit: 2.5 }), /limit must be a whole number/);
  assert.equal(
    await say(lead, "lead", "record", { of: "L1-T1", limit: "2" }),
    two,
    "a harness that sends a number as text is read as the number",
  );
  assert.match(await say(lead, "lead", "record", { of: "L1-T1", limit: "two" }), /limit must be a whole number/);

  h.commit(lane.worktree!, "a.txt", "changed\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "a.txt now says changed." });
  h.agents.get(peer)!.status = "idle";
  assert.equal((await h.call(lead, "lead", "accept", { task: "L1-T1" })).ok, true);
  await h.runtime.desk.settled(h.project);
  assert.equal((await h.call(lead, "lead", "release", { task: "L1-T1" })).ok, true);
  assert.ok(h.agents.get(peer)!.archivedAt, "released, the Peer is gone");
  const fetched = timeline.fetches.length;
  const gone = await say(lead, "lead", "record", { of: "L1-T1" });
  assert.equal(timeline.fetches.length, fetched, "its history is not read, since that would start it again");
  assert.match(
    gone,
    /^L1-T1 Clean build's Peer is gone, and reading its steps would start it again, so this is what the desk kept\. L1-T1 is merged\.\n- Handed back \(complete\): a\.txt now says changed\. The whole hand-back: \S+\/handbacks\/L1-T1-\d+\.md/,
  );
});
