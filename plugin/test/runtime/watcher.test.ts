import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stateRoot } from "../../server/core/paths.ts";
import { settle } from "./fake-timeline.ts";
import { type harness, heldRound, laneWithPeer, nobodySeated } from "./harness.ts";
import { contracts } from "../../shared/rpc.ts";
import { book, hookAgent, notice } from "./noticed.ts";

type Harness = ReturnType<typeof harness>;

/** The machine settings, with the watch read by the Watcher seat alone, or by no brain. */
function judgedBy(brain: "seat" | "off"): void {
  const file = join(stateRoot(), "settings.json");
  const settings = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...settings, attention: { brain } }));
}

const kept = (state: string) => {
  const file = join(state, "assessments.log");
  return existsSync(file)
    ? readFileSync(file, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
};

/** Resolves once `check` holds, as the desk's own awaits run their course; fails after two seconds. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    assert.ok(tries < 200, `never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await settle();
}

const watchersOf = (h: Harness) =>
  [...h.agents.values()].filter((agent) => agent.provider.startsWith("sw3-watcher-") && !agent.archivedAt);

/** The case id a letter or prompt asks about, the last one it names. */
const caseIn = (text: string) => [...text.matchAll(/CASE (C\w+) about/g)].at(-1)![1]!;

/** The questions the last case in `text` asks, by name. */
const questionsIn = (text: string) =>
  [...text.slice(text.lastIndexOf("Questions:")).matchAll(/^([a-z][\w-]*): /gm)].map((match) => match[1]!);

/** A lane with a Peer that thinks at each turn, the watch judged by the Watcher: each turn's end is a case. */
async function watched() {
  const { h, sup, lane, peer, timeline } = await laneWithPeer();
  judgedBy("seat");
  let turns = 0;
  const thinks = (thought: string, stream = timeline, ...calls: Record<string, unknown>[]) => {
    const id = `t${++turns}`;
    stream.beat("turn_started", id);
    stream.add({ type: "user_message", text: "Go on.", clientMessageId: `sw3-message-${id}` }, id);
    stream.add({ type: "reasoning", text: thought }, id);
    for (const call of calls) stream.add(call, id);
    stream.beat("turn_completed", id);
  };
  const judge = (by: string, text: string, says: string, why = "Nothing shows it.") =>
    h.call(by, "watcher", "judge", {
      case: caseIn(text),
      answers: questionsIn(text).map((question) => ({ question, says, why })),
    });
  return { h, sup, lane, peer, thinks, judge };
}

test("the Watcher's life: seated for a case, answering by the rules, kept while needed, let go after", async (t) => {
  const { h, sup, thinks, judge } = await watched();
  const role = h.runtime.kit.roles.find((entry) => entry.role === "watcher")!;
  const label = role.label;
  role.label = "Case reader";
  t.after(() => void (role.label = label));
  thinks("The parser is missing, so I'll build a stub for it.");
  await until(() => watchersOf(h).length === 1, "a Watcher is seated for the case");
  const [watcher] = watchersOf(h);
  assert.equal(watcher!.title, "Case reader", "titled as its role is named");
  assert.equal(watcher!.labels["paseo.parent-agent-id"], sup, "under the Supervisor, so Paseo never pushes its reply");
  assert.equal(watcher!.cwd, h.project.root);
  assert.match(
    watcher!.prompt!,
    /^CASE C\w+ about L1-T1: questions on the fields below\.\n\nseat:\nthe Peer on L1-T1 \(Clean build\)\n\ngoal:\ng\n[^]*items:\n- \[thought\] The parser is missing, so I'll build a stub for it\.\n\nfacts:\n- desk-unreached\n\nQuestions:\nstruggling: [^\n]+\n {3}yes: [^\n]+\n {3}no: [^\n]+\n[^]*\n\nNext: judge C\w+: /,
  );
  const first = watcher!.prompt!;
  const asked = questionsIn(first);
  assert.ok(asked.includes("stand-in") && !asked.includes("pre-solves"), "the patterns that watch a Peer");
  const all = asked.map((question) => ({ question, says: "no", why: "Nothing shows it." }));
  const said = (answers: { question: string; says: string; why: string }[], id = caseIn(first), by = watcher!.id) =>
    h.call(by, "watcher", "judge", { case: id, answers });
  assert.match((await said(all, "C0")).text, /C0 is not waiting for an answer/);
  assert.match(
    (await said([{ ...all[0]!, question: "summary" }, ...all.slice(1)])).text,
    new RegExp(`^Nothing was recorded: answer ${asked[0]} once; summary is no question of C\\w+\\.$`),
  );
  assert.match((await said([...all, all[0]!])).text, new RegExp(`answer ${asked[0]} once`));
  assert.match(
    (await said([{ ...all[0]!, says: "probably" }, ...all.slice(1)])).text,
    new RegExp(`${asked[0]} takes yes, no, unsure`),
  );
  assert.match((await said([{ ...all[0]!, why: " " }, ...all.slice(1)])).text, new RegExp(`give ${asked[0]} a why`));
  assert.match((await said([...all, { ...all[0]!, question: "toString" }])).text, /toString is no question of C\w+/);
  const other = h.add("sw3-watcher-claude/claude-opus-5", h.root, "another Watcher");
  assert.match((await said(all, caseIn(first), other)).text, /was sent to another Watcher/);
  h.agents.get(other)!.archivedAt = new Date().toISOString();
  await settle();
  assert.deepEqual(kept(h.project.state), [], "nothing is kept of a refused answer");
  const answered = await judge(watcher!.id, first, "Yes", "It says it will build a stub for the parser.");
  assert.equal(answered.ok, true, answered.text);
  await settle();
  const [line] = kept(h.project.state);
  assert.deepEqual(
    [line!.by, line!.model, line!.answers, line!.why],
    [
      "watcher",
      watcher!.provider,
      Object.fromEntries(asked.map((question) => [question, { likely: 1 }])),
      Object.fromEntries(asked.map((question) => [question, "It says it will build a stub for the parser."])),
    ],
    "what it answers is kept beside the case",
  );
  assert.match((await said(all)).text, /is not waiting for an answer/, "a case is answered once");

  const mailed = () => h.heard(watcher!.id).join("\n");
  thinks("The refund path works too.");
  await h.idle(watcher!.id);
  await until(() => /The refund path works too/.test(mailed()), "the next case is mailed to it");
  assert.match(mailed(), /CASE C\w+ about L1-T1[^]*The refund path works too\./);
  assert.equal(watchersOf(h).length, 1, "the next case goes to the same Watcher");
  assert.equal((await judge(watcher!.id, mailed(), "unsure")).ok, true);
  await settle();
  assert.deepEqual(
    Object.values(kept(h.project.state).at(-1)!.answers as Record<string, unknown>)[0],
    { likely: 0.5 },
    "unsure is the middle",
  );

  h.projectSettings({ attention: { watcherAnswerMinutes: 5 } });
  thinks("Rounded, third time.");
  await until(() => /third time/.test(mailed()), "the third case is sent");
  await h.idle(watcher!.id);
  await h.tick(Date.now() + 6 * 60_000);
  await settle();
  assert.equal(
    kept(h.project.state).at(-1)!.unasked,
    "no answer within 5 minutes",
    "a case left unanswered past the owner's time is given up",
  );
  assert.equal(watcher!.archivedAt, null, "while a lane is open and the watch is judged by it, the Watcher stays");

  thinks("Rounded, fourth time.");
  await until(() => /fourth time/.test(mailed()), "the fourth case is sent");
  judgedBy("off");
  await h.tick();
  assert.equal(watcher!.archivedAt, null, "judged by something else, it stays while its case waits");
  assert.equal((await judge(watcher!.id, mailed(), "no")).ok, true);
  await h.tick();
  assert.ok(watcher!.archivedAt, "and is let go once none does");

  judgedBy("seat");
  thinks("Rounded, fifth time.");
  await until(() => watchersOf(h).length === 1, "a Watcher is seated again");
  const [renewed] = watchersOf(h);
  assert.equal((await judge(renewed!.id, renewed!.prompt!, "no")).ok, true);
  renewed!.status = "idle";
  assert.equal((await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "not wanted after all" })).ok, true);
  await h.tick();
  assert.ok(renewed!.archivedAt, "with no lane open, no case can come, and the idle Watcher is let go");
});

test("cases at once seat one Watcher, and a case is given up only when nobody can take it, never by a round that could not yet see its Watcher", async (t) => {
  const { h, sup, lane, thinks } = await watched();
  h.agents.get(sup)!.archivedAt = new Date().toISOString();
  thinks("Rounded.");
  await until(() => kept(h.project.state).length === 1, "the case is kept");
  assert.deepEqual(watchersOf(h), [], "with no Supervisor seated no Watcher is seated");
  assert.match(String(kept(h.project.state)[0]!.unasked), /no Supervisor is seated/);

  h.agents.get(sup)!.archivedAt = null;
  // The Peer's turn and its Lead's end together, each with a fact the code raised: three cases, the Lead's look and the
  // brief it laid out beside the Peer's, for one Watcher.
  thinks("Half of it is done.");
  const write = { type: "write", filePath: "src/cart.js", content: "x" };
  thinks("The Peer is halfway there.", h.timelineOf(lane.lead!), {
    type: "tool_call",
    callId: "w",
    name: "Write",
    status: "completed",
    detail: write,
  });
  const cases = () => {
    const [watcher] = watchersOf(h);
    if (!watcher) return 0;
    return [watcher.prompt ?? "", ...h.heard(watcher.id)].join("\n").match(/^CASE /gm)?.length ?? 0;
  };
  await until(() => cases() === 3, "every case reaches one Watcher");
  assert.equal(watchersOf(h).length, 1);
  const read = await h.call(watchersOf(h)[0]!.id, "watcher", "record", { of: "L1-T1" });
  assert.equal(read.ok, true, read.text);
  nobodySeated(h);
  await h.tick();
  await settle();
  assert.deepEqual(
    kept(h.project.state)
      .slice(1)
      .map((line) => line.unasked),
    Array(3).fill("the Watcher it was sent to is gone"),
    "with nobody seated, a case whose Watcher has gone is given up by the next round",
  );

  const slow = await watched();
  type Create = (options: { config: { provider: string } }) => Promise<unknown>;
  const workspaces = (slow.h.paseo as { workspaces: { ref: (id: string) => { agents: { create: Create } } } })
    .workspaces;
  const ref = workspaces.ref;
  let seat = () => {};
  const seated = new Promise<void>((resolve) => (seat = resolve));
  t.mock.method(workspaces, "ref", (id: string) => {
    const real = ref(id);
    const create: Create = async (options) => {
      if (options.config.provider.startsWith("sw3-watcher-")) await seated;
      return real.agents.create(options);
    };
    return { ...real, agents: { create } };
  });
  slow.thinks("Rounded.");
  await settle();
  await slow.h.tick(Date.now() + 16 * 60_000);
  seat();
  await until(() => watchersOf(slow.h).length === 1, "the Watcher is seated at last");
  const [late] = watchersOf(slow.h);
  assert.equal((await slow.judge(late!.id, late!.prompt!, "no")).ok, true, "its time runs from when it was sent");
  await settle();
  assert.equal(kept(slow.h.project.state).length, 1);
  assert.equal(kept(slow.h.project.state)[0]!.unasked, undefined);

  late!.archivedAt = new Date().toISOString();
  await slow.h.runtime.archived(hookAgent(slow.h, late!.id));
  const { round, release } = await heldRound(slow.h, t);
  slow.thinks("Rounded again.");
  await until(() => watchersOf(slow.h).length === 1, "a new Watcher is seated while the round is held");
  release();
  await round;
  const [next] = watchersOf(slow.h);
  const answered = await slow.judge(next!.id, next!.prompt!, "no");
  assert.equal(
    answered.ok,
    true,
    `a round whose listing was read before its Watcher was seated gave it up: ${answered.text}`,
  );
});

test("a case's time runs from when its Watcher got it, and one it never got is given up at twice that", async (t) => {
  const { h, thinks, judge } = await watched();
  thinks("The parser is missing, so I'll build a stub for it.");
  await until(() => watchersOf(h).length === 1, "a Watcher is seated for the case");
  const [watcher] = watchersOf(h);
  assert.equal((await judge(watcher!.id, watcher!.prompt!, "no")).ok, true);
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const at = async (minutes: number) => {
    t.mock.timers.setTime(start + minutes * 60_000);
    await h.tick(start + minutes * 60_000);
    await settle();
  };
  const held = () => h.runtime.outbox.pending(watcher!.id);

  // Held behind a long turn: what counts is when it arrives, not when it was posted.
  watcher!.status = "running";
  thinks("Second pass at the parser.");
  await until(() => held().length === 1, "the case waits in the outbox");
  await at(16);
  assert.equal(kept(h.project.state).length, 1, "past its time since it was posted, it still waits");
  await h.idle(watcher!.id);
  assert.equal(held().length, 0, "until its Watcher gets it");
  await at(30);
  const second = h.heard(watcher!.id).join("\n");
  assert.equal((await judge(watcher!.id, second, "no")).ok, true, "and is answered within its time since it came");

  watcher!.status = "running";
  thinks("Third pass at the parser.");
  await until(() => held().length === 1, "the next case waits in the outbox");
  await at(59);
  assert.equal(kept(h.project.state).length, 2, "short of twice its time, it waits");
  await at(61);
  assert.equal(kept(h.project.state).at(-1)!.unasked, "never reached the Watcher", "past it, it is given up");
});

test("a newer look at the same seat and subject folds into its case still queued, which is taken back unasked", async () => {
  const { h, peer, thinks, judge } = await watched();
  thinks("The parser is missing, so I'll build a stub for it.");
  await until(() => watchersOf(h).length === 1, "a Watcher is seated for the case");
  const [watcher] = watchersOf(h);
  assert.equal((await judge(watcher!.id, watcher!.prompt!, "no")).ok, true);
  const held = () => h.runtime.outbox.pending(watcher!.id);

  watcher!.status = "running";
  thinks("A placeholder will do for the refund path.");
  await until(() => held().length === 1, "the case waits in the outbox");
  const first = caseIn(held()[0]!.text);
  thinks("And a stub for the tax table.");
  await until(() => held().length === 1 && caseIn(held()[0]!.text) !== first, "the newer case takes its place");
  const folded = held()[0]!.text;
  assert.match(
    folded,
    /- \[thought\] A placeholder will do for the refund path\.\n- \[thought\] And a stub for the tax table\./,
  );
  assert.deepEqual(
    h.events("watch.superseded").map((event) => [event.agent, event.subject, event.case, event.into]),
    [[peer, "L1-T1", first, caseIn(folded)]],
  );
  await h.idle(watcher!.id);
  assert.match(
    (await judge(watcher!.id, folded.replace(caseIn(folded), first), "no")).text,
    new RegExp(`${first} is not waiting`),
    "the one taken back takes no answer",
  );
  assert.equal((await judge(watcher!.id, folded, "no")).ok, true, "the folded case is answered");
  await settle();
  assert.equal(
    kept(h.project.state).filter((line) => line.unasked !== undefined).length,
    0,
    "the one taken back is no case left unasked",
  );

  thinks("One more stub, for shipping.");
  await until(() => /for shipping/.test(h.heard(watcher!.id).join("\n")), "a case after it is sent");
  await h.idle(watcher!.id);
  thinks("And the last, for returns.");
  await until(() => /for returns/.test(h.heard(watcher!.id).join("\n")), "and one after that");
  assert.equal(h.events("watch.superseded").length, 1, "a case its Watcher already has is not folded into");
});

test("a newer look folds into the case still queued even while its Watcher reads an older one of the same seat and subject", async () => {
  const { h, peer, thinks } = await watched();
  thinks("The parser is missing, so I'll build a stub for it.");
  await until(() => watchersOf(h).length === 1, "a Watcher is seated for the case");
  const [watcher] = watchersOf(h);
  const reading = caseIn(watcher!.prompt!);
  const held = () => h.runtime.outbox.pending(watcher!.id);

  // It has the first case and has not answered it; the next waits behind its turn.
  watcher!.status = "running";
  thinks("A placeholder will do for the refund path.");
  await until(() => held().length === 1, "the next case waits in the outbox");
  const queued = caseIn(held()[0]!.text);
  thinks("And a stub for the tax table.");
  await until(() => h.events("watch.superseded").length === 1, "the newest folds into the one queued");
  assert.equal(held().length, 1, "one case waits, not two");
  const folded = caseIn(held()[0]!.text);
  assert.deepEqual(
    h.events("watch.superseded").map((event) => [event.agent, event.case, event.into]),
    [[peer, queued, folded]],
    "the queued case is folded, never the one its Watcher is reading",
  );
  assert.notEqual(folded, reading);
});

test("a case folded into a newer one keeps what only it asked", async () => {
  const { h, thinks, judge } = await watched();
  thinks("The parser is missing, so I'll build a stub for it.");
  await until(() => watchersOf(h).length === 1, "a Watcher is seated for the case");
  const [watcher] = watchersOf(h);
  assert.equal((await judge(watcher!.id, watcher!.prompt!, "no")).ok, true);
  const held = () => h.runtime.outbox.pending(watcher!.id);

  // Thinking on and on with no call is going round in circles, which is asked whether the seat admits it was wrong.
  watcher!.status = "running";
  const more = Array.from({ length: 9 }, (_, n) => ({
    type: n % 2 === 0 ? "assistant_message" : "reasoning",
    text: `Still weighing the refund path, take ${n}.`,
  }));
  thinks("A placeholder will do for the refund path.", undefined, ...more);
  await until(() => held().length === 1, "the case waits in the outbox");
  const older = held()[0]!.text;
  assert.ok(questionsIn(older).includes("admits-wrong"));
  thinks("And a stub for the tax table.");
  await until(() => h.events("watch.superseded").length === 1, "the newer folds it in");
  const folded = held()[0]!.text;
  assert.deepEqual(questionsIn(folded).toSorted(), questionsIn(older).toSorted(), "nothing the older asked is lost");
});

test("a case still waiting when the plugin restarts is answered all the same, and found as its look would have", async () => {
  const { h, peer, thinks, judge } = await watched();
  thinks("The parser is missing, so I'll build a stub for it.");
  await until(() => watchersOf(h).length === 1, "a Watcher is seated for the case");
  const [watcher] = watchersOf(h);
  h.restart();
  const answered = await judge(watcher!.id, watcher!.prompt!, "yes", "It says it will build a stub for the parser.");
  assert.equal(answered.ok, true, answered.text);
  await settle();
  assert.equal(kept(h.project.state).at(-1)!.subject, "L1-T1", "its answer is kept");
  const found = Object.values(book(h)).find((item) => item.kind === "stand-in")!;
  assert.deepEqual([found.seat, found.quote], [peer, "It says it will build a stub for the parser."]);

  await h.tick();
  watcher!.status = "running";
  thinks("Rounded, the second time.");
  await until(() => /second time/.test(h.heard(watcher!.id).join("\n")), "the next case is posted");
  h.restart();
  await h.tick(Date.now() + 31 * 60_000);
  await settle();
  assert.equal(kept(h.project.state).at(-1)!.unasked, "never reached the Watcher", "and one kept is given up in time");
});

test("the Team tab counts the cases nobody judged since the Human last read the report, and the incidents told and closed", async (t) => {
  const { h, sup, lane, thinks, judge } = await watched();
  const watch = async () => {
    const flow = await h.rpc(contracts.flow, { project: h.project.slug });
    assert.ok("watch" in flow);
    return flow.watch;
  };
  thinks("The parser is missing, so I'll build a stub for it.");
  await until(() => watchersOf(h).length === 1, "a Watcher is seated for the case");
  const [watcher] = watchersOf(h);
  assert.deepEqual((await watch()).cases, { waiting: 1, expired: 0, dropped: 0, superseded: 0 });
  assert.equal((await judge(watcher!.id, watcher!.prompt!, "no")).ok, true);
  assert.equal((await watch()).cases.waiting, 0, "an answered case waits no more");

  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  watcher!.status = "running";
  thinks("A placeholder will do for the refund path.");
  await until(() => h.runtime.outbox.pending(watcher!.id).length === 1, "the case waits in the outbox");
  thinks("And a stub for the tax table.");
  await until(() => h.events("watch.superseded").length === 1, "the newer folds it in");
  t.mock.timers.setTime(start + 31 * 60_000);
  await h.tick(start + 31 * 60_000);
  await settle();
  const incident = await notice(h, lane.lead!, "lane-idle", "attend", "idle");
  await h.call(sup, "supervisor", "mark_incident", { id: incident.opened[0]!.id, verdict: "noise" });
  const seen = await watch();
  assert.deepEqual(seen.cases, { waiting: 0, expired: 1, dropped: 0, superseded: 1 });
  assert.equal(seen.incidents.closed, 1);

  t.mock.timers.setTime(start + 32 * 60_000);
  await h.rpc(contracts.reportSeen, { project: h.project.slug, until: Date.now() });
  const after = await watch();
  assert.deepEqual([after.cases, after.incidents.closed], [{ waiting: 0, expired: 0, dropped: 0, superseded: 0 }, 0]);
});
