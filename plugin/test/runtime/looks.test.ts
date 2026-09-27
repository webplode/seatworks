import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { stateRoot } from "../../server/core/paths.ts";
import type { Judge, Question } from "../../server/core/ports.ts";
import { settle } from "./fake-timeline.ts";
import { type harness, laneWithPeer } from "./harness.ts";
import { book } from "./noticed.ts";

const KEY = "a-key-for-tests-only";
type Harness = ReturnType<typeof harness>;
type Asked = { state: Record<string, unknown>; questions: Record<string, Question> };

/**
 * A brain that answers each pattern by its id in `says`, and 0.05 to the rest, only where the words it reads hold `about`;
 * and what it was asked.
 */
function brain(says: Record<string, number>, why: Record<string, string> = {}, about = /./) {
  const asked: Asked[] = [];
  const judge: Judge = {
    async ask(state, questions) {
      asked.push({ state, questions });
      const hit = about.test(JSON.stringify(state));
      const answers = Object.fromEntries(
        Object.keys(questions).map((id) => [id, { likely: hit ? (says[id] ?? 0.05) : 0.05 }]),
      );
      return { answers, model: "vendor/model-1", why };
    },
  };
  return { asked, judge };
}

/** The machine settings read by `mode`'s brains, the sensor with its key. */
function brains(mode: "sensor" | "seat" | "both"): void {
  const file = join(stateRoot(), "settings.json");
  const settings = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  writeFileSync(
    file,
    JSON.stringify({ ...settings, attention: { brain: mode, sensor: "jev" }, sensor: { jev: { key: KEY } } }),
  );
}

/** Every look the desk was handed since this was called, each awaited to its end. */
function looksOf(h: Harness, t: TestContext): () => Promise<void> {
  const spy = t.mock.method(h.runtime.desk, "look");
  return async () => {
    await settle();
    await Promise.all(spy.mock.calls.flatMap((call) => call.result ?? []));
  };
}

test("the watch's eye reads a seat's new words at its turn's end and while it runs, the sensor asks each its patterns, and a yes opens an incident told to whoever supervises", async (t) => {
  const sensed = brain({ "stand-in": 0.95 }, {}, /stub|placeholder/);
  const { h, sup, peer, timeline } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("sensor");
  const looked = looksOf(h, t);
  timeline.beat("turn_started", "t1");
  timeline.add({ type: "reasoning", text: "The parser is missing, so I'll build a stub for it." }, "t1");
  timeline.add({ type: "assistant_message", text: "Working on the cart.", messageId: "m1" }, "t1");
  timeline.beat("turn_completed", "t1");
  await looked();
  const thought = sensed.asked.find(
    (entry) => entry.state.text === "The parser is missing, so I'll build a stub for it.",
  )!;
  assert.ok(thought, "its thinking is read");
  assert.deepEqual([thought.state.goal, thought.state.acceptance], ["g", ["a"]], "beside what its work asks of it");
  assert.ok("stand-in" in thought.questions && !("big-decision" in thought.questions), "only what watches a Peer");
  const found = Object.values(book(h)).find((item) => item.kind === "stand-in")!;
  assert.deepEqual(
    [found.told !== undefined, found.quote, found.facts],
    [
      true,
      "The parser is missing, so I'll build a stub for it.",
      ["stand-in", "seen by Jev, 0.95 sure, in its thought"],
    ],
  );
  await h.idle(sup);
  assert.match(
    h.heard(sup).join("\n"),
    /INCIDENT I2 \(stand-in, attend\) on the Peer on L1-T1[^]*What was seen: The parser is missing, so I'll build a stub for it\./,
    "it reaches whoever supervises at once",
  );
  const asked = sensed.asked.length;

  timeline.beat("turn_started", "t2");
  timeline.add({ type: "reasoning", text: "A placeholder will do for the refund path." }, "t2");
  // Still being written, the last words wait for the next look; what came before them does not.
  timeline.add({ type: "assistant_message", text: "Checking the refu", messageId: "m2" }, "t2");
  await settle();
  await h.tick(Date.now() + 6 * 60_000);
  await looked();
  const running = sensed.asked.slice(asked).map((entry) => entry.state.text);
  assert.deepEqual(
    running,
    ["A placeholder will do for the refund path."],
    "a turn still running is looked at every few minutes",
  );
  assert.equal(
    book(h).I2!.later,
    "A placeholder will do for the refund path.",
    "seen again, it is kept beside what was told",
  );
  assert.doesNotMatch(h.heard(peer).join("\n"), /INCIDENT/);
  const asking = await h.call(sup, "supervisor", "message", {
    to: "L1-T1",
    text: 'You thought "The parser is missing, so I\'ll build a stub for it." What does the parser need?',
  });
  assert.equal(asking.ok, true, `the seat's own words are the Supervisor's to quote back: ${asking.text}`);

  assert.equal((await h.call(sup, "supervisor", "mark_incident", { id: "I2", verdict: "noise" })).ok, true);
  timeline.beat("turn_started", "t3");
  timeline.add({ type: "reasoning", text: "Another placeholder, for the tax table this time." }, "t3");
  timeline.beat("turn_completed", "t3");
  await looked();
  assert.deepEqual(
    Object.values(book(h)).flatMap((item) => (item.brain ? [[item.id, item.count]] : [])),
    [["I2", 3]],
    "a pattern marked noise stays settled for its seat's task, in whatever words the next look finds it",
  );
});

test("with both brains the sensor sifts and the Watcher seat judges only what it said yes to, in the words its why quotes", async (t) => {
  const sensed = brain({ turning: 0.9, struggling: 0.5, "stand-in": 0.05 });
  const seat = brain(
    { turning: 0.9 },
    { turning: 'It writes "scrap the queue and poll instead" with no reason given.' },
  );
  const { h, peer, timeline } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("both");
  t.mock.method(h.runtime.desk.watcher, "judge", () => seat.judge);
  const looked = looksOf(h, t);
  timeline.beat("turn_started", "t1");
  const failing = { type: "shell", command: "node poll.js", exitCode: 1 };
  timeline.add({ type: "tool_call", callId: "c1", name: "Bash", status: "completed", detail: failing }, "t1");
  timeline.add({ type: "reasoning", text: "Scrap the queue and poll instead." }, "t1");
  timeline.beat("turn_completed", "t1");
  await looked();
  assert.equal(seat.asked.length, 1);
  assert.deepEqual(
    Object.keys(seat.asked[0]!.questions),
    ["turning"],
    "the one it said yes to, not one it was unsure of nor one it cleared",
  );
  assert.deepEqual(seat.asked[0]!.state.items, ["[thought] Scrap the queue and poll instead."]);
  assert.deepEqual(seat.asked[0]!.state.facts, ["call-failed", "desk-unreached"], "beside what the code saw meanwhile");
  const found = Object.values(book(h)).find((item) => item.kind === "turning")!;
  assert.deepEqual(
    [found.seat, found.quote, found.facts[1]],
    [peer, 'It writes "scrap the queue and poll instead" with no reason given.', "judged by the Watcher seat"],
  );
});

test("a Lead's brief is judged once, at the add_tasks that wrote it, on what the call says, and a brain off reads nothing", async (t) => {
  const sensed = brain({ "pre-solves": 0.9 }, {}, /src\/cart\.ts/);
  const { h, lane } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("sensor");
  const looked = looksOf(h, t);
  const lead = lane.lead!;
  const brief = { key: "b", title: "Totals", goal: "totals add up", acceptance: ["a"], outOfScope: ["the rest"] };
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ ...brief, hints: ["src/cart.ts"], context: "Edit src/cart.ts, add a sum()." }],
  });
  const stream = h.timelineOf(lead);
  stream.beat("turn_started", "l1");
  stream.add({ type: "assistant_message", text: "Laid out the totals task in src/cart.ts.", messageId: "l-m1" }, "l1");
  stream.beat("turn_completed", "l1");
  await looked();
  const asked = () => sensed.asked.filter((entry) => "pre-solves" in entry.questions);
  const read = asked().find((entry) => /src\/cart\.ts/.test(String(entry.state.text)))!;
  assert.match(
    String(read.state.text),
    /goal: totals add up[^]*hints:\n\s+- src\/cart\.ts[^]*context: Edit src\/cart\.ts, add a sum\(\)\./,
    "the brief as the call wrote it",
  );
  assert.ok(
    asked().every((entry) => !String(entry.state.text).startsWith("Laid out")),
    "its words are not asked what only its brief can show",
  );
  assert.ok(!("stand-in" in read.questions), "what watches a Lead, not a Peer");
  assert.ok(Object.values(book(h)).find((item) => item.kind === "pre-solves")?.told);

  const judged = asked().length;
  stream.beat("turn_started", "l2");
  stream.add({ type: "assistant_message", text: "Still src/cart.ts; waiting on it.", messageId: "l-m2" }, "l2");
  stream.beat("turn_completed", "l2");
  await looked();
  assert.equal(asked().length, judged, "a look with no decision in it asks nothing of the decision's patterns");

  const before = sensed.asked.length;
  h.machineSettings({ attention: { brain: "off" } });
  stream.beat("turn_started", "l3");
  stream.add({ type: "assistant_message", text: "Waiting on the hand-back.", messageId: "l-m3" }, "l3");
  stream.beat("turn_completed", "l3");
  await looked();
  assert.equal(sensed.asked.length, before, "with the brain off, nothing is asked");
});

test("a review briefed to report only certainties is judged at start_review against the Lead's own doubt, as evidence on the code's fact", async (t) => {
  const sensed = brain({ "steered-review": 0.9 }, {}, /drain change/);
  const seat = brain(
    { "steered-review": 0.9 },
    { "steered-review": 'It fears "a race in the drain" and asks for certainties.' },
  );
  const { h, sup, lane } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("both");
  t.mock.method(h.runtime.desk.watcher, "judge", () => seat.judge);
  const looked = looksOf(h, t);
  const lead = lane.lead!;
  const stream = h.timelineOf(lead);
  const review = async (id: string, focus: string, patrolled = true) => {
    stream.beat("turn_started", id);
    stream.add({ type: "reasoning", text: `The drain change may race under concurrent requests (${id}).` }, id);
    stream.add({ type: "assistant_message", text: `Starting review ${id}.`, messageId: id }, id);
    await h.call(lead, "lead", "start_review", { focus });
    if (patrolled) await h.tick();
    stream.beat("turn_completed", id);
    await looked();
  };
  await review("l1", "Review the lane as a whole.");
  assert.equal(sensed.asked.filter((entry) => "steered-review" in entry.questions).length, 0, "an open brief is not");

  await review("l2", "Second round. Report only what you are sure of.");
  const read = sensed.asked.find(
    (entry) => "steered-review" in entry.questions && String(entry.state.text).startsWith("focus:"),
  )!;
  const judged = seat.asked.find((entry) => "steered-review" in entry.questions)!;
  assert.match(String(read.state.text), /^focus: Second round\. Report only what you are sure of\.$/);
  assert.deepEqual(
    judged.state.items,
    [
      "[thought] The drain change may race under concurrent requests (l2).",
      "[call] focus: Second round. Report only what you are sure of.",
    ],
    "the words the sensor flagged since its last decision, beside the call",
  );
  assert.equal(judged.state.call, "start_review");
  const certain = Object.values(book(h)).filter((item) => item.kind === "certainty-only");
  assert.equal(certain.length, 1);
  assert.match(certain[0]!.evidence?.join() ?? "", /steered-review: It fears "a race in the drain"/);
  assert.match(
    (await h.call(sup, "supervisor", "incidents", {})).text,
    /certainty-only[^\n]*; also read: steered-review: It fears "a race in the drain"/,
    "whoever supervises reads it beside the fact",
  );
  assert.equal(Object.values(book(h)).filter((item) => item.kind === "steered-review").length, 0, "not a second");

  await h.call(sup, "supervisor", "mark_incident", { id: certain[0]!.id, verdict: "useful" });
  await review("l3", "Third round: only confirmed bugs, no speculation.", false);
  assert.equal(
    Object.values(book(h)).filter((item) => item.kind === "steered-review").length,
    1,
    "with no incident of the fact open, as before the patrol raises it, it opens its own",
  );
});

test("a decision about how the system is built is judged at the Lead's report, the report beside the words that led to it", async (t) => {
  const sensed = brain({ "big-decision": 0.9 }, {}, /array on the order/);
  const seat = brain({});
  const { h, lane } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("both");
  t.mock.method(h.runtime.desk.watcher, "judge", () => seat.judge);
  const looked = looksOf(h, t);
  const lead = lane.lead!;
  const stream = h.timelineOf(lead);
  const turn = async (id: string, item: Record<string, unknown>) => {
    stream.beat("turn_started", id);
    stream.add(item, id);
    stream.beat("turn_completed", id);
    await looked();
  };
  await turn("l0", { type: "assistant_message", text: "Laid out L1-T1.", messageId: "l-m0" });
  await turn("l1", { type: "reasoning", text: "Refunds go in an array on the order." });
  assert.equal(sensed.asked.filter((entry) => "big-decision" in entry.questions).length, 0, "not in a look");

  await h.call(lead, "lead", "report", { summary: "Refunds work.", ready: false });
  await turn("l2", { type: "assistant_message", text: "Reported.", messageId: "l-m2" });
  assert.deepEqual(
    sensed.asked.filter((entry) => "big-decision" in entry.questions).map((entry) => entry.state.text),
    ["Refunds go in an array on the order.", "Reported."],
    "the sensor asks each of the words since, never the report",
  );
  const judged = seat.asked.find((entry) => "big-decision" in entry.questions)!;
  assert.equal(judged.state.call, "report");
  assert.deepEqual(judged.state.items, [
    "[thought] Refunds go in an array on the order.",
    "[call] summary: Refunds work.\nready: false",
  ]);
});

test("after a restart the eye reads only new words, and still judges a decision that was waiting for its next look", async (t) => {
  const sensed = brain({ "big-decision": 0.9 }, {}, /Survive restart/);
  const { h, lane, timeline } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("sensor");
  const lead = h.timelineOf(lane.lead!);
  const turn = (stream: typeof timeline, id: string, item: Record<string, unknown>) => {
    stream.beat("turn_started", id);
    stream.add({ type: "user_message", text: "Go on.", clientMessageId: `sw3-message-${id}` }, id);
    stream.add(item, id);
    stream.beat("turn_completed", id);
  };
  turn(timeline, "t1", { type: "reasoning", text: "First I read the cart module." });
  turn(lead, "l1", { type: "assistant_message", text: "Laid out the first task.", messageId: "l-m1" });
  await looksOf(h, t)();
  const read = () => sensed.asked.map((entry) => String(entry.state.text));
  assert.ok(read().includes("First I read the cart module."));
  const reported = await h.call(lane.lead!, "lead", "report", { summary: "Survive restart.", ready: false });
  assert.equal(reported.ok, true, reported.text);

  h.restart();
  await h.tick();
  const looked = looksOf(h, t);
  const before = sensed.asked.length;
  turn(timeline, "t2", { type: "reasoning", text: "Now the totals." });
  turn(lead, "l2", { type: "assistant_message", text: "Waiting on the hand-back.", messageId: "l-m2" });
  await looked();
  assert.deepEqual(
    [
      ...new Set(
        read()
          .slice(before)
          .filter((text) => text !== "summary: Survive restart.\nready: false"),
      ),
    ].sort(),
    ["Now the totals.", "Waiting on the hand-back."],
    "what the history replays was read before the restart; a new word may belong to both its look and its decision",
  );
  const decision = sensed.asked.find(
    (entry) => entry.state.text === "summary: Survive restart.\nready: false" && "withholds-gap" in entry.questions,
  );
  assert.ok(decision, "the pending report is judged after the restart");
  assert.match(String(decision.state.text), /summary: Survive restart/);
});

test("what a look reads and an incident quotes is cut where the owner says, and a pattern the catalog calls a note is kept, never booked", async (t) => {
  const sensed = brain({ "stand-in": 0.95, wrapper: 0.95 });
  const { h, timeline } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("sensor");
  h.projectSettings({ attention: { lookItemChars: 40, quoteChars: 20 } });
  const wrapper = h.runtime.kit.patterns.wrapper!;
  t.after(() => void delete wrapper.level);
  wrapper.level = "note";
  const looked = looksOf(h, t);
  timeline.beat("turn_started", "t1");
  timeline.add({ type: "reasoning", text: "The parser is missing, so I will build a stub and wrap it later." }, "t1");
  timeline.beat("turn_completed", "t1");
  await looked();
  assert.deepEqual(
    sensed.asked.map((entry) => String(entry.state.text).split("\n")[0]),
    ["The parser is missing, so I will build a"],
    "the brains read each item cut to the owner's length",
  );
  assert.deepEqual(
    Object.values(book(h)).flatMap((item) => (item.brain ? [[item.kind, item.quote]] : [])),
    [["stand-in", "The parser is missin\n[… 43 more characters]"]],
    "a quote too, and a note is no incident",
  );
});

test("a gap the words name is found at the hand-back only when the hand-back itself leaves it out", async (t) => {
  const sensed = brain({ "withholds-gap": 0.9 }, {}, /still fails/);
  const { h, peer, lane, timeline } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("sensor");
  const looked = looksOf(h, t);
  const asked = () => sensed.asked.filter((entry) => "withholds-gap" in entry.questions);
  const turn = async (id: string, thought: string, summary?: string) => {
    timeline.beat("turn_started", id);
    timeline.add({ type: "user_message", text: "Go on.", clientMessageId: `sw3-message-${id}` }, id);
    timeline.add({ type: "reasoning", text: thought }, id);
    if (summary) await h.call(peer, "peer", "done", { outcome: "complete", summary });
    timeline.beat("turn_completed", id);
    await looked();
  };
  await turn("t1", "The refund path still fails; I will leave it for now.");
  assert.equal(asked().length, 0, "before a hand-back there is nothing it could leave out");
  await turn("t2", "The refund path still fails, but the totals are right.", "Totals round half up.");
  assert.deepEqual(
    asked().map((entry) => entry.state.text),
    [
      "The refund path still fails; I will leave it for now.",
      "The refund path still fails, but the totals are right.",
      "outcome: complete\nsummary: Totals round half up.",
    ],
    "the words since, and the hand-back itself, each asked the one question",
  );
  const gaps = () => Object.values(book(h)).filter((item) => item.kind === "withholds-gap");
  assert.equal(gaps().length, 1, "the words say it and the hand-back does not");
  assert.equal(gaps()[0]!.quote, "The refund path still fails; I will leave it for now.");

  await h.call(lane.lead!, "lead", "rework", { task: "L1-T1", text: "Fix the refund path." });
  await h.call(h.ledger().lanes.L1!.opener, "supervisor", "mark_incident", { id: gaps()[0]!.id, verdict: "useful" });
  await turn(
    "t3",
    "The refund path still fails on a zero total.",
    "Refunds work; the refund path still fails on zero.",
  );
  assert.equal(gaps().filter((item) => item.open).length, 0, "a hand-back that says so leaves nothing out");
});

test("a seat whose looks carry words but never thinking is recorded once, so what reads thinking is known to be blind to it", async (t) => {
  const sensed = brain({});
  const { h, timeline } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("sensor");
  const looked = looksOf(h, t);
  for (const id of ["t1", "t2", "t3", "t4"]) {
    timeline.beat("turn_started", id);
    timeline.add({ type: "user_message", text: "Go on.", clientMessageId: `sw3-message-${id}` }, id);
    timeline.add({ type: "assistant_message", text: `Working on it, ${id}.`, messageId: id }, id);
    timeline.beat("turn_completed", id);
    await looked();
  }
  assert.deepEqual(
    h.events("watch.thoughtless").map((event) => event.looks),
    [3],
    "three looks with words and no thinking, told once",
  );
});

test("a Lead's look is read beside its lane's directive whole and the Human's settled words", async (t) => {
  const sensed = brain({});
  const { h, lane } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("sensor");
  writeFileSync(join(h.project.state, "CONTEXT.md"), "# Shop\n\n**Cents**: every amount is whole cents.\n");
  const looked = looksOf(h, t);
  const stream = h.timelineOf(lane.lead!);
  stream.beat("turn_started", "l1");
  stream.add({ type: "assistant_message", text: "Totals stay in cents.", messageId: "l-m1" }, "l1");
  stream.beat("turn_completed", "l1");
  await looked();
  const read = sensed.asked.find((entry) => entry.state.text === "Totals stay in cents.")!;
  assert.equal(read.state.directive, "Outcome: a.txt changes\nAcceptance:\n- a", "its lane's outcome and acceptance");
  assert.match(String(read.state.context), /every amount is whole cents/, "and the concept file");
});

test("a report is asked against the few lines of the concept and its directive it shares words with, one line to a question", async (t) => {
  const asked: Asked[] = [];
  const judge: Judge = {
    async ask(state, questions) {
      asked.push({ state, questions });
      const against = (question: Question) => JSON.stringify(question.instructions);
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          { likely: /whole cents/.test(against(question)) && /dollars/.test(String(state.text)) ? 0.9 : 0.05 },
        ]),
      );
      return { answers, model: "vendor/model-1", why: {} };
    },
  };
  const { h, lane } = await laneWithPeer(undefined, { sensor: () => judge });
  brains("sensor");
  const concept = [
    "- Every stored price amount is whole cents.",
    "- A refund never exceeds its order's total.",
    ...["one", "two", "three", "four", "five"].map((n) => `- Stored price rule ${n} holds for every order.`),
  ];
  writeFileSync(join(h.project.state, "CONTEXT.md"), `# Shop\n\n## Behavior\n\n${concept.join("\n")}\n`);
  const looked = looksOf(h, t);
  const stream = h.timelineOf(lane.lead!);
  const turn = async (id: string) => {
    stream.beat("turn_started", id);
    stream.add({ type: "assistant_message", text: "Done.", messageId: id }, id);
    stream.beat("turn_completed", id);
    await looked();
  };
  const brief = { key: "p", title: "Prices", goal: "Store prices as dollars", acceptance: ["a"], outOfScope: ["b"] };
  await h.call(lane.lead!, "lead", "add_tasks", { tasks: [brief] });
  await turn("l1");
  const contradicts = (entry: Asked) =>
    Object.entries(entry.questions)
      .filter(([id]) => id.startsWith("contradicts#"))
      .map(([, question]) => (question.instructions as Record<string, string>).rule);
  assert.deepEqual(asked.flatMap(contradicts), [], "a brief is not asked it");

  await h.call(lane.lead!, "lead", "report", { summary: "Every stored price amount is now in dollars.", ready: false });
  await turn("l2");
  const read = asked.find((entry) => /dollars/.test(String(entry.state.text)) && contradicts(entry).length > 0)!;
  assert.deepEqual(
    contradicts(read),
    [
      "Every stored price amount is whole cents.",
      ...["one", "two", "three", "four"].map((n) => `Stored price rule ${n} holds for every order.`),
    ],
    "the lines sharing the most words first, at most five, and none that shares none",
  );
  const found = Object.values(book(h)).filter((item) => item.kind === "contradicts");
  assert.equal(found.length, 1);
  assert.match(found[0]!.facts.join(), /against: Every stored price amount is whole cents\./);
});

test("the seat judges only what a first stage flagged: the items the sensor flagged, or a look the code raised a fact in", async (t) => {
  const sensed = brain({ "stand-in": 0.95 }, {}, /stub/);
  const seat = brain({});
  const { h, lane, timeline } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("both");
  t.mock.method(h.runtime.desk.watcher, "judge", () => seat.judge);
  const looked = looksOf(h, t);
  timeline.beat("turn_started", "t1");
  timeline.add({ type: "reasoning", text: "Reading the cart module first." }, "t1");
  timeline.add({ type: "assistant_message", text: "I'll build a stub for the parser.", messageId: "m1" }, "t1");
  timeline.beat("turn_completed", "t1");
  await looked();
  assert.deepEqual(
    seat.asked.map((entry) => [Object.keys(entry.questions), entry.state.items]),
    [[["stand-in"], ["[said] I'll build a stub for the parser."]]],
    "the flagged item alone, not the whole look",
  );

  // With no sensor, the code's facts are the first stage.
  h.machineSettings({ attention: { brain: "seat" } });
  const stream = h.timelineOf(lane.lead!);
  const lead = (id: string, ...items: Record<string, unknown>[]) => {
    stream.beat("turn_started", id);
    stream.add({ type: "user_message", text: "Go on.", clientMessageId: `sw3-message-${id}` }, id);
    for (const item of items) stream.add(item, id);
    stream.beat("turn_completed", id);
  };
  const before = seat.asked.length;
  lead("l1", { type: "reasoning", text: "Refunds go in an array on the order." });
  await looked();
  assert.deepEqual(
    seat.asked.slice(before).map((entry) => entry.state.call),
    ["add_tasks"],
    "a look the code raised nothing in is not judged, while a decision made through the desk always is",
  );
  const write = { type: "write", filePath: "src/cart.js", content: "x" };
  lead(
    "l2",
    { type: "reasoning", text: "I will write the cart myself." },
    { type: "tool_call", callId: "w", name: "Write", status: "completed", detail: write },
  );
  await looked();
  assert.equal(seat.asked.length, before + 2, "one the code raised a fact in is");
});

test("with the seat alone reading, a sensor set up is never asked, and the seat judges the decision and the look the code raised a fact in", async (t) => {
  const sensed = brain({ "pre-solves": 0.9, "stand-in": 0.9 });
  const seat = brain({});
  const { h, lane } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("seat");
  t.mock.method(h.runtime.desk.watcher, "judge", () => seat.judge);
  const looked = looksOf(h, t);
  const stream = h.timelineOf(lane.lead!);
  const write = { type: "write", filePath: "src/cart.js", content: "x" };
  stream.beat("turn_started", "l1");
  stream.add({ type: "user_message", text: "Go on.", clientMessageId: "sw3-message-l1" }, "l1");
  stream.add({ type: "reasoning", text: "I will stub the cart myself." }, "l1");
  stream.add({ type: "tool_call", callId: "w", name: "Write", status: "completed", detail: write }, "l1");
  stream.beat("turn_completed", "l1");
  await looked();
  assert.deepEqual(
    sensed.asked.map((entry) => Object.keys(entry.questions)),
    [["instruction_kind"]],
    "the sensor is asked no pattern: only the instruction's kind, which is review's moment, not the watch's",
  );
  assert.deepEqual(seat.asked.map((entry) => entry.state.call ?? "look").toSorted(), ["add_tasks", "look"]);
});

test("in a decision case what the sensor is unsure of goes to the seat too; in a look only what it said yes to", async (t) => {
  const sensed = brain({ "pre-solves": 0.5, struggling: 0.5 });
  const seat = brain({});
  const { h, lane } = await laneWithPeer(undefined, { sensor: () => sensed.judge });
  brains("both");
  t.mock.method(h.runtime.desk.watcher, "judge", () => seat.judge);
  const looked = looksOf(h, t);
  const stream = h.timelineOf(lane.lead!);
  stream.beat("turn_started", "l1");
  stream.add({ type: "user_message", text: "Go on.", clientMessageId: "sw3-message-l1" }, "l1");
  stream.add({ type: "reasoning", text: "Not sure what settled means here." }, "l1");
  stream.beat("turn_completed", "l1");
  await looked();
  assert.deepEqual(
    seat.asked.map((entry) => [entry.state.call ?? "look", Object.keys(entry.questions)]),
    [["add_tasks", ["pre-solves"]]],
    "the brief it was unsure of reaches the seat; the look's thought it was unsure of does not",
  );
});
