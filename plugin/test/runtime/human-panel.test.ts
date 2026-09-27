import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { configFile } from "../../server/desk/project/project.ts";
import { contracts } from "../../shared/rpc.ts";
import { settle } from "./fake-timeline.ts";
import type { Pending } from "./fake-paseo.ts";
import { harness, laneWithPeer } from "./harness.ts";
import { laneWith } from "./landable.ts";
import { tempDir } from "../tempdir.ts";

type Harness = ReturnType<typeof harness>;

const packet = (extra: Record<string, unknown> = {}) => ({
  question: "Delete old invoices, or keep them archived?",
  why: "It decides whether customers' records can come back.",
  options: [
    { label: "Delete", effect: "Invoices older than 7 years are gone for good." },
    { label: "Archive", effect: "They move to cold storage and can be restored." },
  ],
  recommend: "Archive",
  reason: "Nothing is lost.",
  ifSilent: "The lane archives them.",
  class: "reversible",
  ...extra,
});

/** The Flow tab as the panel reads it, `open` naming the lanes it shows the tasks of. */
async function flowOf(h: Harness, open: string[] = [], since?: string) {
  const read = await h.rpc(contracts.flow, { project: h.project.slug, open, since });
  assert.ok(!("error" in read));
  return read;
}

async function drawn(h: Harness, open: string[] = []) {
  const read = await flowOf(h, open);
  assert.ok("lanes" in read);
  return read;
}

test("a question for the Human is a card in the Supervisor's chat that settles where it stands, and a restart posts again only what still waits", async () => {
  const { h, sup } = await laneWithPeer({ hitl: { on: true } });
  h.machineSettings({ hitl: { questionsPerDay: 10 } });
  await h.call(sup, "supervisor", "ask_human", packet({ lane: "L1" }));
  await h.call(sup, "supervisor", "ask_human", packet({ question: "Keep the old endpoint?" }));
  const questions = async () =>
    (await h.cards())
      .filter((card) => card.kind === "question")
      .map((card) => {
        const { question, settled } = card.data as { question: { id: string }; settled: { text: string } | null };
        return [card.to, question.id, settled?.text ?? "waits"];
      });
  await h.tick();
  assert.deepEqual(
    h
      .timelineOf(sup)
      .cards()
      .filter((card) => card.kind === "question")
      .map((card) => card.id),
    [`${h.project.slug}:H1`, `${h.project.slug}:H2`],
    "the round posts them, with no panel open",
  );
  assert.deepEqual(await questions(), [
    [sup, "H1", "waits"],
    [sup, "H2", "waits"],
  ]);
  await h.rpc(contracts.questionAnswer, { project: h.project.slug, question: "H1", choice: "Archive", note: "" });
  assert.deepEqual(
    await questions(),
    [
      [sup, "H1", "You chose Archive"],
      [sup, "H2", "waits"],
    ],
    "answered, its card turns into one line in place, with the other card after it as before",
  );
  await h.call(sup, "supervisor", "withdraw_question", { question: "H2", why: "the lane no longer touches it" });
  await h.tick();
  assert.deepEqual((await questions())[1], [sup, "H2", "Withdrawn: the lane no longer touches it"]);

  await h.call(sup, "supervisor", "ask_human", packet({ question: "Rename it?" }));
  await questions();
  // Paseo forgets a plugin's rows when its daemon restarts, and the plugin starts again with it.
  const chat = h.timelineOf(sup);
  chat.rows = chat.rows.filter((row) => row.item.type !== "plugin");
  h.restart();
  assert.deepEqual(await questions(), [[sup, "H3", "waits"]], "only what still waits comes back, and nothing settled");
});

test("a question waits in the Human's queue, and their answer, on the panel or in the Supervisor's chat, goes on record and to whoever asked", async () => {
  const { h, sup, lane } = await laneWithPeer({ hitl: { on: true } });
  h.machineSettings({ hitl: { questionsPerDay: 10 } });
  const ask = (extra: Record<string, unknown>) => h.call(sup, "supervisor", "ask_human", packet(extra));
  const record = (question: string, choice: string, quote: string) =>
    h.call(sup, "supervisor", "record_human_answer", { question, choice, quote });
  const answer = (question: string, choice: string, note = "") =>
    h.rpc(contracts.questionAnswer, { project: h.project.slug, question, choice, note });
  assert.match(
    (await ask({ recommend: "Shred" })).text,
    /recommend names none of the options: give one of Delete, Archive\./,
  );
  const cancel = [
    { label: "Delete", effect: "x" },
    { label: "cancel", effect: "y" },
  ];
  assert.match((await ask({ options: cancel, recommend: "Delete" })).text, /none called decline or cancel/);
  assert.match((await ask({ options: cancel.slice(0, 1), recommend: "Delete" })).text, /options takes at least 2/);

  assert.match(
    (await ask({ lane: "L1", class: "irreversible" })).text,
    /^Asked the Human as H1; it waits in their question queue\. Nothing it decides goes ahead until they answer: its Lead is told to keep off it and carry on with the rest\. Holding the whole lane is yours, with hold_lane\./,
  );
  assert.equal(h.ledger().lanes.L1!.onHold, undefined, "only what it decides waits, not the whole lane");
  assert.match(
    h.heard(lane.lead!).join("\n"),
    /DECISION PENDING H1, the Human's to make: Delete old invoices, or keep them archived\?\n\nNothing it decides goes ahead until they answer; what it does not touch goes on\.\n\nNext: Keep the lane off what it decides, and carry on with the rest; you hear when it is settled, and the Supervisor tells you how the lane goes on\./,
  );
  assert.match(
    (await h.call(sup, "supervisor", "status", {})).text,
    /## Questions for the Human\n\n- H1 \(irreversible, L1\), open 0 min: Delete old invoices, or keep them archived\? Recommended: Archive\. While silent: The lane archives them/,
  );
  const flow = await drawn(h);
  assert.deepEqual(
    flow.questions.map((question) => [
      question.id,
      question.class,
      question.lane,
      question.recommend,
      question.options.map((option) => option.label),
    ]),
    [["H1", "irreversible", "L1", "Archive", ["Delete", "Archive"]]],
  );
  assert.equal(flow.lanes[0]!.onHold, undefined);

  assert.match(
    (await record("H1", "Delete", "delete them all")).text,
    /The Human's own words "delete them all" are not in this chat/,
  );
  h.timelineOf(sup).add({ type: "user_message", text: "Hmm.  Archive them,\nplease.", clientMessageId: "app-1" });
  h.timelineOf(sup).add({ type: "user_message", text: "SEEN L1-T1 hand back", clientMessageId: "sw3-handback-1" });
  h.timelineOf(sup).add({ type: "user_message", text: "LANDED L1: delete the old invoices" });
  assert.match((await record("H1", "Delete", "seen l1-t1 hand back")).text, /are not in this chat/);
  assert.match((await record("H1", "Delete", "delete the old invoices")).text, /are not in this chat/);

  assert.deepEqual(await answer("H1", "Keep"), {
    error: "Keep is none of H1's options: Delete, Archive, or decline or cancel.",
  });
  assert.deepEqual(await answer("h1", "Archive", "and keep a list of them"), {
    answered: "H1 is answered: Archive. The Supervisor has it.",
  });
  const answered = h.ledger().questions.H1!;
  assert.deepEqual(
    [answered.status, answered.answer?.by, answered.answer?.text],
    ["answered", "panel", "and keep a list of them"],
  );
  assert.match(
    h.heard(sup).join("\n"),
    /HUMAN ANSWERED H1 \(Delete old invoices, or keep them archived\?\), on the panel: Archive\.\n\nTheir note, their own words:\nand keep a list of them\n\nNext: Tell the Lead of L1 their choice and how the lane goes on, and write it into CONTEXT\.md if it settles the concept\./,
  );
  const settled = (id: string, how: string) =>
    new RegExp(
      `SETTLED ${id}, the decision your lane kept off: ${how}\\.\\n\\nNext: Nothing now: the Supervisor tells you how the lane goes on\\.`,
    );
  assert.match(h.heard(lane.lead!).join("\n"), settled("H1", "the Human answered it"), "its word, never their words");
  assert.doesNotMatch(h.heard(lane.lead!).join("\n"), /keep a list/);
  assert.match((await record("H1", "decline", "archive them, please")).text, /H1 is already answered\./);
  assert.match(
    (await record("H1", "decline", "archive")).text,
    /are not in this chat/,
    "a scrap of a message is no one's words",
  );

  await ask({ lane: "L1", class: "irreversible" });
  assert.match(
    (await record("h2", "Archive", "archive them, please!")).text,
    /^H2 is answered: Archive\. The Lead of L1 hears only that it is settled: tell it how the lane goes on\./,
  );
  assert.match(h.heard(lane.lead!).join("\n"), settled("H2", "the Human answered it"));
  assert.deepEqual(
    [h.ledger().questions.H2!.answer?.by, h.ledger().questions.H2!.answer?.quote],
    ["chat", "Hmm.  Archive them,\nplease."],
    "what they wrote goes on record whole",
  );
  await ask({});
  assert.deepEqual(await answer("H3", "decline"), { answered: "H3 is declined. The Supervisor has it." });
  assert.match(
    h.heard(sup).join("\n"),
    /HUMAN ANSWERED H3 \([^)]*\), on the panel: they declined to decide it\.\n\nNext: The call is yours now: decide it and carry that where it applies\./,
  );
  await ask({ question: "Rename the product?" });
  assert.deepEqual(await answer("H4", "cancel"), { answered: "H4 is canceled. The Supervisor has it." });
  assert.match(
    h.heard(sup).join("\n"),
    /HUMAN ANSWERED H4 \(Rename the product\?\), on the panel: they took it off their queue\.\n\nNext: It is off their queue: go on without it, or ask again if it still matters\./,
  );
  await ask({ question: "Move the database?", lane: "L1", class: "irreversible" });
  const withdraw = (question: string) =>
    h.call(sup, "supervisor", "withdraw_question", { question, why: "the lane no longer touches it" });
  assert.equal(
    (await withdraw("H5")).text,
    "H5 is off the Human's queue; they read why on its card in your chat. The Lead of L1 hears only that it is settled: tell it how the lane goes on.",
  );
  assert.match(h.heard(lane.lead!).join("\n"), settled("H5", "it was withdrawn"));
  assert.match((await withdraw("H5")).text, /^H5 is already canceled\./);
  const report = await h.report();
  assert.ok("withdrawn" in report);
  assert.deepEqual(
    report.withdrawn.map((item) => [item.title, item.detail]),
    [["H5 · Move the database?", "withdrawn by the Supervisor: the lane no longer touches it"]],
  );
  assert.deepEqual(
    report.chat.map((item) => [item.title, item.detail]),
    [
      [
        "H2 · Delete old invoices, or keep them archived?",
        "Archive, put on record from their words: Hmm. Archive them, please.",
      ],
    ],
    "what the Supervisor put on record from the chat, beside what they wrote, for them to check",
  );
  const answers = report.numbers.find((row) => row.title === "Your answers");
  assert.deepEqual(
    [answers?.value, answers?.detail],
    ["2 of 2 took the recommendation", "median 0 min to answer"],
    "how often their answer was the one recommended, and how fast they gave it",
  );
  assert.deepEqual((await drawn(h)).questions, []);
});

test("Orders reads back the Human's standing orders and the project's concept, and says when the orders cannot be read", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const orders = () => h.rpc(contracts.orders, { project: h.project.slug });
  await h.call(sup, "supervisor", "set_project", { askFirst: ["src/auth"], laneHome: "isolate" });
  writeFileSync(join(h.project.state, "CONTEXT.md"), "# Invoices\n\nAn invoice is never edited.\n");
  const read = await orders();
  assert.ok("askFirst" in read);
  assert.deepEqual(
    [read.fault, read.askFirst, read.laneHome, read.ownRules, read.riskRules.length],
    [null, ["src/auth"], "In a copy of their own; yours is left alone.", false, 1],
  );
  assert.match(read.riskRules[0]!.reviewQuestion, /second time/);
  assert.deepEqual([read.concept?.text, read.concept?.more], ["# Invoices\n\nAn invoice is never edited.\n", false]);
  await h.call(sup, "supervisor", "set_project", { riskRules: [] });
  const own = await orders();
  assert.ok("askFirst" in own && own.ownRules && own.riskRules.length === 0);
  writeFileSync(configFile(h.project.state), "{ not json");
  const broken = await orders();
  assert.ok("askFirst" in broken);
  assert.match(broken.fault ?? "", /project\.json is there but could not be read/);
  assert.deepEqual(await h.rpc(contracts.orders, { project: "nope" }), {
    error: "No project named nope has been seen on this machine.",
  });
});

test("the Report tells from the record what needs the Human, widest stop first, what went ahead, what landed, and what could not be undone", async () => {
  const { h, sup, lane, peer, timeline } = await laneWithPeer({ hitl: { on: true } });
  await h.call(sup, "supervisor", "ask_human", packet({ lane: "L1", class: "irreversible" }));
  await h.call(sup, "supervisor", "ask_human", packet({ question: "Dates as ISO?" }));
  await h.call(sup, "supervisor", "ask_human", packet({ question: "Rename the product?", class: "irreversible" }));
  for (const [seat, title] of [
    [peer, "Bash: npm install"],
    [lane.lead!, "Bash: rm -rf build"],
  ] as const) {
    const asked: Pending = { id: `p-${seat}`, kind: "tool", name: "Bash", title };
    h.agents.get(seat)!.pending.push(asked);
    await h.permission(seat, asked);
  }
  timeline.beat("turn_started", "t1");
  const push = { type: "shell", command: "git push --force origin main" };
  timeline.add({ type: "tool_call", callId: "c1", name: "Bash", status: "running", detail: push }, "t1");
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const report = await h.report();
  assert.ok("needs" in report);
  assert.deepEqual(
    report.needs.map((item) => [item.title, item.detail]),
    [
      ["L1 · Lead · Build waits for your permission: Bash: rm -rf build", "stops the Lead of L1"],
      ["H1 · Delete old invoices, or keep them archived?", "irreversible · L1 · stops what it decides"],
      ["H3 · Rename the product?", "irreversible · stops what it decides"],
      ["L1-T1 · Peer · Clean build waits for your permission: Bash: npm install", "stops the Peer on L1-T1"],
    ],
    "what stops the most comes first",
  );
  assert.deepEqual(
    report.ahead.map((item) => [item.title, item.detail]),
    [["H2 · Dates as ISO?", "reversible · went ahead on Archive"]],
  );
  assert.deepEqual(
    report.beyond.map((item) => [item.title, item.detail]),
    [["I1 · git push --force origin main", "the Peer on L1-T1 (Clean build) · not marked"]],
  );
  assert.deepEqual(
    report.numbers.map((row) => [row.title, row.value]),
    [
      ["Questions today", "3 of 3"],
      ["Landings", "0 landed"],
      ["Incidents", "1"],
      ["Your answers", "none yet"],
      ["Findings re-checked", "none yet"],
      ["Reviews", "none yet"],
      ["Challenges", "none yet"],
      ["Asks sent up", "0"],
      ["Spend", "not reported"],
    ],
  );

  const landing = harness();
  const boss = landing.add("sw3-supervisor-claude/claude-opus-5", landing.root, "sup");
  await landing.call(boss, "supervisor", "set_project", { gate: "true" });
  await landing.call(boss, "supervisor", "open_lane", {
    title: "Cart",
    outcome: "a cart",
    acceptance: ["a"],
    outOfScope: ["the rest"],
  });
  landing.commit(landing.ledger().lanes.L1!.worktree!, "a.txt", "cart\n");
  assert.equal((await landing.call(boss, "supervisor", "land_lane", { lane: "L1" })).ok, true);
  const landed = await landing.report();
  assert.ok("landed" in landed);
  assert.deepEqual(
    landed.landed.map((item) => [item.title, item.detail]),
    [["L1 Cart", "on main"]],
  );
  assert.equal(landed.window.from, null, "never read, it runs over the whole record");

  const until = landed.window.until;
  assert.deepEqual(await landing.rpc(contracts.reportSeen, { project: landing.project.slug, until }), { seen: until });
  const reports = async () => (await landing.cards()).filter((card) => card.kind === "report");
  assert.equal((await reports()).length, 1, "a window read with nothing new in it posts no second card");
  assert.deepEqual(
    await landing.rpc(contracts.reportSeen, { project: landing.project.slug, until: until - 60_000 }),
    { seen: until },
    "an older page marked read later never takes the window back",
  );
});

test("with the Human out of the loop, the Report lists what was decided for them, and only the Supervisor's own wait needs them", async () => {
  const { h, sup, lane, land } = await laneWith({ "a.txt": "cart\n" });
  const remote = tempDir("sw3-remote-");
  h.git(remote, "init", "-q", "--bare");
  h.git(h.root, "remote", "add", "origin", remote);
  h.git(h.root, "config", "branch.main.remote", "origin");
  h.git(h.root, "config", "branch.main.merge", "refs/heads/main");
  const asked: Pending = { id: "p-1", kind: "tool", name: "Bash", title: "Bash: npm install" };
  h.agents.get(lane.lead!)!.pending.push(asked);
  await h.permission(lane.lead!, asked);
  const permitted = { from: "L1", request: "p-1", allow: true, why: "it stays in its copy" };
  assert.equal((await h.call(sup, "supervisor", "permit", permitted)).ok, true);
  await h.call(sup, "supervisor", "set_project", { gate: "false" });
  assert.equal((await land()).ok, false);
  const over = { lane: "L1", overGate: true, reason: "the gate is broken, not the cart" };
  assert.equal((await h.call(sup, "supervisor", "land_lane", over)).ok, true);
  assert.equal((await h.call(sup, "supervisor", "push", { tag: "v1.0.0", message: "the cart" })).ok, true);
  const grilling: Pending = { id: "q-1", kind: "question", name: "AskUserQuestion", title: "Who is the cart for?" };
  h.agents.get(sup)!.pending.push(grilling);
  await h.permission(sup, grilling);

  const report = await h.report();
  assert.ok("decided" in report);
  assert.deepEqual(
    report.decided.map((item) => [item.title, item.detail]),
    [
      ["Allowed a permission for the Lead of L1", "by the Supervisor"],
      ["L1 landed over a red gate", "by the Supervisor: the gate is broken, not the cart"],
      ["Pushed main to origin, tagged v1.0.0", "by the Supervisor"],
    ],
  );
  assert.deepEqual(
    report.needs.map((item) => [item.title, item.detail]),
    [["sup waits for your answer: Who is the cart for?", "stops the Supervisor"]],
    "a seat's permission is the Supervisor's to give while the Human is out of the loop",
  );
});

test("the Flow tab draws the machine as the ledger and Paseo have it, and an unchanged poll costs nothing", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const fresh = await drawn(h);
  assert.deepEqual([fresh.lanes, fresh.asks, fresh.questions, fresh.moreLanes], [[], [], [], 0]);
  const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", outcome: "a cart", ...scope });
  const lead = h.ledger().lanes.L1!.lead!;
  const add = (key: string, extra: Record<string, unknown>) =>
    h.call(lead, "lead", "add_tasks", { tasks: [{ key, title: key, goal: "g", ...scope, ...extra }] });
  await add("One", { hints: ["a.txt"] });
  await add("Two", { holds: ["c.txt"], parallel: true });
  await add("Three", { hints: ["b.txt"], after: ["L1-T2"] });
  await add("Four", { hints: ["b.txt"] });
  const [one, two] = ["L1-T1", "L1-T2"].map((id) => h.ledger().tasks[id]!);
  h.agents
    .get(one!.peer!)!
    .pending.push({ id: "p1", kind: "tool", name: "Write", title: "Write outside the working copy" });

  const shut = await drawn(h);
  const cart = shut.lanes[0]!;
  assert.deepEqual([cart.tasks, cart.taskCount, cart.running, cart.open, cart.copy], [[], 4, 2, false, null]);
  assert.deepEqual([cart.lead?.label, cart.lead?.waiting], ["Lead", []], "a seat named as the kit labels its role");
  assert.deepEqual(await flowOf(h, [], shut.revision), { unchanged: true, revision: shut.revision });
  h.agents.get(two!.peer!)!.archivedAt = new Date().toISOString();
  const opened = await drawn(h, ["L1"]);
  assert.notEqual(opened.revision, shut.revision);
  const tasks = Object.fromEntries(opened.lanes[0]!.tasks.map((task) => [task.id, task]));
  assert.deepEqual(
    ["L1-T1", "L1-T2"].map((id) => [tasks[id]!.mode, tasks[id]!.copy, tasks[id]!.after, tasks[id]!.held]),
    [
      ["lane", null, [], null],
      ["parallel", "S0", [], null],
    ],
  );
  assert.deepEqual(tasks["L1-T3"]!.after, ["L1-T2"]);
  assert.equal(
    tasks["L1-T4"]!.held,
    "L1-T1 is still writing in the lane's working copy, and it holds one writer at a time. It starts by itself once that clears; amend it, or cut it to drop it.",
  );
  assert.deepEqual(tasks["L1-T1"]!.peer?.waiting, ["Write outside the working copy"]);
  assert.equal(tasks["L1-T2"]!.peer?.status, "gone");
  await h.call(lead, "lead", "start_review", { focus: "the cart as a whole" });
  const review = (await drawn(h, ["L1"])).lanes[0]!.tasks.find((task) => task.kind === "review");
  assert.deepEqual([review?.id, review?.mode, review?.after], ["L1-R1", "lane", []]);

  await h.call(lead, "lead", "ask", {
    kind: "question",
    text: "Which rounding do we use?\nThe spec says nothing.",
    default: "half up",
  });
  assert.deepEqual(
    (await drawn(h)).asks,
    [{ id: "A1", kind: "question", from: "Lead", to: "Supervisor", minutes: 0 }],
    "who asked whom and when, never the seat's words",
  );
  const page = await h.rpc(contracts.status, { project: h.project.slug });
  assert.ok("text" in page);
  assert.match(page.text, /- A1 question from lead \S+ to \S+, open 0 min\.\n/);
  assert.doesNotMatch(page.text, /Which rounding/);
  assert.match((await h.call(sup, "supervisor", "status", {})).text, /open 0 min: Which rounding do we use\?/);
  await h.call(sup, "supervisor", "answer", { ask: "A1", text: "Half up." });
  assert.deepEqual((await drawn(h)).asks, []);

  const apart = { outcome: "x", ...scope, isolate: true };
  await h.call(sup, "supervisor", "open_lane", { title: "Apart", ...apart });
  await h.call(sup, "supervisor", "open_lane", { title: "After", ...apart, after: ["L2"] });
  assert.equal((await drawn(h)).lanes.find((lane) => lane.id === "L2")!.copy, "S2", "S1 is L1-R1's own");
  await h.call(sup, "supervisor", "drop_lane", { lane: "L2", reason: "not now" });
  const after = (await drawn(h)).lanes.find((lane) => lane.id === "L3")!;
  assert.deepEqual([after.status, after.after, after.lead], ["waiting", ["L2"], null]);
  assert.match(after.held ?? "", /Lane L2 closed without landing/);

  await h.call(sup, "supervisor", "open_lane", { title: "Kept", ...apart });
  const kept = h.ledger().lanes.L4!;
  await h.call(kept.lead!, "lead", "add_tasks", {
    tasks: [{ key: "k", title: "Beside", goal: "g", ...scope, holds: ["k.txt"], parallel: true }],
  });
  const beside = h.ledger().tasks["L4-T1"]!;
  h.commit(beside.worktree!, "k.txt", "k\n");
  await h.call(beside.peer!, "peer", "done", { outcome: "complete", summary: "k" });
  h.agents.get(beside.peer!)!.status = "idle";
  await h.call(kept.lead!, "lead", "accept", { task: "L4-T1" });
  await h.runtime.desk.settled(h.project);
  const keptOf = async () => (await drawn(h)).lanes.find((lane) => lane.id === "L4")?.kept.map((seat) => seat.task);
  assert.deepEqual(await keptOf(), ["L4-T1"]);
  await h.call(kept.lead!, "lead", "release", { task: "L4-T1" });
  assert.deepEqual(await keptOf(), []);
  h.agents.get(kept.lead!)!.status = "idle";
  await h.call(sup, "supervisor", "land_lane", { lane: "L4" });
  const closed = (await drawn(h)).lanes.find((lane) => lane.id === "L4")!;
  assert.deepEqual([closed.status, closed.landed, closed.copy], ["closed", true, kept.slot]);
  await h.call(sup, "supervisor", "release", { lane: "L4" });
  assert.equal(
    (await drawn(h)).lanes.find((lane) => lane.id === "L4"),
    undefined,
  );

  h.agents.get(sup)!.archivedAt = new Date().toISOString();
  const next = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup-2");
  await h.call(next, "supervisor", "status", {});
  assert.deepEqual(
    (await drawn(h)).supervisors.map((seat) => [seat.id, seat.status]),
    [[next, "idle"]],
  );
  h.agents.get(next)!.archivedAt = new Date().toISOString();
  assert.deepEqual(
    (await drawn(h)).supervisors.map((seat) => [seat.id, seat.status]),
    [[next, "gone"]],
  );
});

test("what a lane's seats spent, as their agents report it, is kept across an agent starting again and shown on status, Flow and the Report", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const costs = (seat: string, totalCostUsd: number) =>
    Object.assign(h.agents.get(seat)!, { lastUsage: { totalCostUsd } });
  costs(lane.lead!, 0.5);
  costs(peer, 1.25);
  await h.tick();
  costs(peer, 0.25);
  await h.tick();
  const status = (await h.call(sup, "supervisor", "status", {})).text;
  assert.match(
    status,
    /\nSpent \$2\.00 by its seats, as their agents report it\.\n/,
    "1.25 before its agent started again, 0.25 since",
  );
  assert.equal((await drawn(h)).lanes.find((entry) => entry.id === lane.id)!.spent, 2);
  const report = await h.report();
  assert.ok("numbers" in report);
  assert.deepEqual(
    report.numbers.find((row) => row.title === "Spend"),
    {
      title: "Spend",
      value: "$2.00",
      detail: "L1 $2.00, as its seats' agents report it; an agent that reports none is not counted",
    },
  );
});
