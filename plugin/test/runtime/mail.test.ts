import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stateRoot } from "../../server/core/paths.ts";
import { sentBy } from "../../server/core/sent-by.ts";
import { contracts } from "../../shared/rpc.ts";
import { tempDir } from "../tempdir.ts";
import { harness, laneWithPeer } from "./harness.ts";
import { book } from "./noticed.ts";

type Harness = ReturnType<typeof harness>;

const SUPERVISOR = "sw3-supervisor-claude/claude-opus-5";
const task = (title: string, hint = "a.txt") => ({
  key: "t",
  title,
  goal: "g",
  acceptance: ["a"],
  hints: [hint],
  outOfScope: ["the rest of the repository"],
});
const heard = (h: Harness, id: string) => h.heard(id).join("\n");
const archive = (h: Harness, id: string) =>
  Object.assign(h.agents.get(id)!, { archivedAt: new Date().toISOString(), status: "closed" });

/** A lane opened by a supervising seat, with its Lead and, given a title, one task and its Peer. */
async function lane(h: Harness, sup: string, title: string, work?: string) {
  await h.call(sup, "supervisor", "open_lane", {
    title,
    outcome: "x",
    acceptance: ["a"],
    outOfScope: ["anything else in the repository"],
  });
  const opened = h.ledger().lanes.L1!;
  if (work) await h.call(opened.lead!, "lead", "add_tasks", { tasks: [task(work)] });
  return { lane: opened, lead: opened.lead!, peer: work ? h.ledger().tasks["L1-T1"]!.peer! : "" };
}

/** Whether `check` comes true within `ms`, looked at every 20 ms. */
async function within(ms: number, check: () => boolean): Promise<boolean> {
  for (const end = Date.now() + ms; !check(); await new Promise((resolve) => setTimeout(resolve, 20)))
    if (Date.now() > end) return false;
  return true;
}

test("an ask reaches whoever can answer it, the answer comes back once, and whoever it was put to is told of it", async (t) => {
  const h = harness();
  const sup = h.add(SUPERVISOR, h.root, "sup");
  const { lead } = await lane(h, sup, "Asks");
  await h.idle(lead);
  const asked = await h.call(lead, "lead", "ask", {
    kind: "question",
    text: "Round half up or down?",
    default: "half up",
  });
  assert.equal(asked.ok, true, asked.text);
  await h.idle(sup);
  assert.match(h.agents.get(sup)!.sent.at(-1)!, /ASK A1 \(question\)[\s\S]*half up/);
  assert.equal((await h.call(sup, "supervisor", "answer", { ask: "A1", text: "Half up." })).ok, true);
  await h.idle(lead);
  assert.match(h.agents.get(lead)!.sent.join("\n"), /ANSWER to your ask A1[\s\S]*Half up/);
  // Its first prompt too carries the kinds of its letters in its id, so the watch tells desk mail from a person's words.
  assert.deepEqual(sentBy({ clientMessageId: h.agents.get(lead)!.promptId }), ["brief"]);
  assert.deepEqual(sentBy({ clientMessageId: h.agents.get(lead)!.sentIds.at(-1) }), ["answer"]);
  const again = await h.call(sup, "supervisor", "answer", { ask: "A1", text: "Half down." });
  assert.deepEqual([again.ok, again.text], [false, "Ask A1 is already answered."]);

  await h.call(lead, "lead", "add_tasks", { tasks: [task("Drop it")] });
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  const concept = join(h.project.state, "CONTEXT.md");
  writeFileSync(concept, "# Orders\n\nAn order is never deleted.\n");
  const columns = await h.call(peer, "peer", "ask", {
    question: "Drop the column or keep it nullable?",
    tried: "read the migration",
    bestGuess: "keep it nullable",
  });
  assert.equal(columns.ok, true, columns.text);
  const ask = Object.values(h.ledger().asks).at(-1)!;
  assert.equal(ask.to, lead, "an ask goes upward, to the Lead");
  assert.ok(
    heard(h, lead).includes(`Next: Answer ${ask.id} from ${concept}, the brief and the code;`),
    "the Lead answers from the concept the Human settled, found where it is kept",
  );
  // The Supervisor may answer any ask, and its Lead is told.
  assert.equal((await h.call(sup, "supervisor", "answer", { ask: ask.id, text: "Drop it and migrate." })).ok, true);
  assert.match(heard(h, peer), /Drop it and migrate/, "the Peer gets its answer");
  assert.match(heard(h, lead), new RegExp(`ANSWERED FOR YOU: ${ask.id}`), "the Lead holds the room's state");
  assert.match(heard(h, lead), /Drop it and migrate[^]*accepting it is still yours to judge/);

  const rounding = await h.call(peer, "peer", "ask", {
    question: "Round half up or down?",
    tried: "read the spec",
    bestGuess: "half up",
  });
  assert.equal(rounding.ok, true, rounding.text);
  const waiting = Object.values(h.ledger().asks).at(-1)!.id;
  h.agents.get(lead)!.status = "idle";
  const start = Date.now();
  const waitedOn = () => Object.values(book(h)).filter((item) => item.kind === "ask-waiting");
  await h.tick(start + 14 * 60_000);
  assert.deepEqual(waitedOn(), [], "not before it has waited its while");
  for (const minutes of [16, 32, 48]) await h.tick(start + minutes * 60_000);
  const [fact] = waitedOn();
  assert.deepEqual(
    [waitedOn().length, fact!.seat, fact!.told !== undefined],
    [1, lead, true],
    "an ask left waiting is a fact about its reader the watch tells whoever supervises, once",
  );
  assert.match(fact!.quote, new RegExp(`${waiting} \\(question\\) from L1-T1: Round half up or down\\?`));
  assert.doesNotMatch(
    `${heard(h, lead)}\n${heard(h, sup)}`,
    /STILL OPEN|UNANSWERED/,
    "no clock nags the reader or goes over its head: when to look is the watch's to say",
  );
  assert.match(heard(h, sup), new RegExp(`INCIDENT ${fact!.id} \\(ask-waiting, attend\\) on the Lead of L1`));

  assert.equal(
    (await h.call(lead, "lead", "ask", { kind: "question", text: "Keep the old endpoint?", default: "keep it" })).ok,
    true,
  );
  const endpoint = Object.values(h.ledger().asks).at(-1)!.id;
  archive(h, sup);
  const next = h.add(SUPERVISOR, h.root, "sup-3");
  const leading = h.runtime.kit.roles.find((role) => role.role === "lead")!;
  const label = leading.label;
  t.after(() => void (leading.label = label));
  leading.label = "Captain";
  await h.tick(start + 80 * 60_000);
  assert.match(
    heard(h, next),
    /ASK A\d+ \(question\) from the Captain of L1, whose reader is gone[^]*Keep the old endpoint\?/,
    "an ask to a reader since gone goes to whoever supervises now, its asker named as the kit names its role",
  );
  assert.equal(h.ledger().asks[endpoint]!.to, next);
});

test("with nobody supervising seated, an ask is kept and reaches whoever sits down first", async () => {
  const h = harness();
  const sup = h.add(SUPERVISOR, h.root, "sup");
  const { lead, peer } = await lane(h, sup, "Kept asks", "Parse");
  archive(h, sup);
  const need = await h.call(lead, "lead", "ask", {
    kind: "need",
    text: "Which config file wins?",
    default: "the newest",
  });
  assert.equal(need.ok, true, need.text);
  assert.match(need.text, /Asked as A1[^]*nobody supervising is seated/);
  archive(h, lead);
  const question = await h.call(peer, "peer", "ask", {
    question: "Skip blank lines?",
    tried: "read the parser",
    bestGuess: "skip them",
  });
  assert.equal(question.ok, true, question.text);
  assert.match(question.text, /Asked as A2[^]*nobody can answer now/);
  const back = h.add(SUPERVISOR, h.root, "sup-2");
  await h.tick();
  assert.match(heard(h, back), /ASK A1 \(need\)[^]*Which config file wins\?/);
  assert.match(heard(h, back), /ASK A2 \(question\)[^]*Skip blank lines\?/);
  assert.deepEqual([h.ledger().asks.A1!.to, h.ledger().asks.A2!.to], [back, back]);
});

test("a Peer's silence is counted turn by turn, nudged, then told to its Lead, and a word from it undoes the stall", async () => {
  const h = harness();
  const sup = h.add(SUPERVISOR, h.root, "sup");
  const { lead, peer } = await lane(h, sup, "Quiet", "Work");
  const silent = () => h.ledger().tasks["L1-T1"]!.silent;
  /** One turn of the Peer's, ending with what it said; real turns are seconds apart, so the desk's turn clock moves first. */
  const turn = async (said: string, during?: () => Promise<unknown>) => {
    h.runtime.outbox.turnEnded(peer);
    await new Promise((resolve) => setTimeout(resolve, 3));
    await h.beginTurn(peer);
    await during?.();
    await h.endTurn(peer, said);
  };
  const ask = () =>
    h.call(peer, "peer", "ask", {
      question: "Which file first?",
      tried: "read both",
      bestGuess: "the one the test names",
    });
  h.agents.get(peer)!.status = "idle";

  await turn("still reading");
  assert.equal(silent(), 1);
  assert.match(h.agents.get(peer)!.sent.at(-1)!, /without calling done or ask/);
  assert.match(h.agents.get(peer)!.sent.at(-1)!, /`done` and `ask` are tools of the `team` MCP server/);
  await turn("asked and waiting", ask);
  assert.equal(silent(), 0, "the count is of turns in a row, not a lifetime tally");
  await turn("applying it");
  assert.deepEqual([h.ledger().tasks["L1-T1"]!.status, silent()], ["running", 1], "it asked in between");
  await turn("Still looking.");
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "stalled");
  assert.match(
    heard(h, lead),
    /SILENT L1-T1[\s\S]*Still looking[\s\S]*Next: If its last words hand the work back without calling done, message it to call done; else message it, or cut it and start again\./,
    "accept needs a hand-back on record, so it is not offered",
  );

  // Its Peer is still seated in the lane's copy, so a stalled task still holds it.
  const more = await h.call(lead, "lead", "add_tasks", { tasks: [task("More", "b.txt")] });
  assert.match(more.text, /L1-T2 More: held: L1-T1 is still writing/);
  assert.equal(h.ledger().tasks["L1-T2"]!.peer, undefined);
  await turn("asked", ask);
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "running", "heard from, it runs again");

  // The same instruction twice: letters are keyed by the event, so the second really goes.
  for (let sent = 0; sent < 2; sent++) {
    const rework = await h.call(lead, "lead", "rework", { task: "L1-T1", text: "Commit your work." });
    assert.equal(rework.ok, true, rework.text);
  }
  h.runtime.outbox.turnEnded(peer);
  await h.runtime.outbox.pump(peer);
  assert.equal(
    h.agents
      .get(peer)!
      .sent.join("\n")
      .match(/Commit your work/g)?.length,
    2,
    "both went",
  );

  archive(h, lead);
  await turn("Still nothing.");
  await turn("Nothing yet.");
  assert.match(
    heard(h, sup),
    /SILENT L1-T1[^]*Nothing yet[^]*Next: Its Lead is gone: replace_lead/,
    "with its Lead gone, whoever supervises is told, with the step it can take",
  );
});

test("a Peer that is gone is found past the first page of agents, its Lead told, its copy freed, and its mail shown until given up on", async () => {
  const h = harness();
  const sup = h.add(SUPERVISOR, h.root, "sup");
  // A long-lived daemon: plenty of other agents, more recently active than the Peer about to start.
  for (let index = 0; index < 205; index++) h.add(SUPERVISOR, h.root, `other-${index}`);
  const { lead, peer } = await lane(h, sup, "Gone", "Work");
  assert.ok(h.agents.size > 200, "the seats this lane needs are past the first page");
  await h.tick(Date.now());
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "running", "a seat not on the first page is not a seat that is gone");
  assert.doesNotMatch(heard(h, lead), /was closed or archived/);

  const queued = await h.call(lead, "lead", "message", { to: "L1-T1", text: "Stop: the premise is wrong." });
  assert.match(queued.text, /Queued for the Peer on L1-T1/);
  archive(h, peer);
  await h.tick(Date.now());
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "stalled");
  assert.match(
    heard(h, lead),
    /its agent was closed or archived[\s\S]*Next: Nothing restarts it, and without a hand-back it cannot be accepted: reseat it for a fresh Peer on its branch and copy, which keeps what it committed, or cut it\./,
  );
  const stranded = new RegExp(
    `## Mail with nobody to read it\n\nThe seat each of these was addressed to is gone, and no other seat is sent them\\.\n\n- to ${peer}, waiting 0 min, given up on in 7 days: MESSAGE from your lead`,
  );
  assert.match(readFileSync(join(h.project.state, "status.md"), "utf-8"), stranded, "in the page the round writes");
  assert.match((await h.rpc(contracts.status, { project: h.project.slug })).text, stranded, "and on the panel");

  const more = await h.call(lead, "lead", "add_tasks", { tasks: [task("More", "b.txt")] });
  assert.match(
    more.text,
    /- T is L1-T2 More: running, Peer/,
    "nobody writes in the copy any more, so nothing waits for it",
  );
  archive(h, lead);
  archive(h, h.ledger().tasks["L1-T2"]!.peer!);
  await h.tick(Date.now());
  assert.match(
    heard(h, sup),
    /L1-T2[^]*its agent was closed or archived[^]*Next: Its Lead is gone: replace_lead puts a new Lead on the lane/,
    "with its Lead gone too, whoever supervises is told instead",
  );
});

test("a call that runs longer than a seat can wait is answered once by mail, and the turn it ends is not silence", async (t) => {
  const go = join(tempDir("sw3-slow-"), "go");
  t.after(() => writeFileSync(go, ""));
  const h = harness();
  const sup = h.add(SUPERVISOR, h.root, "sup");
  // The gate waits for the test, so each call is still being worked on for as long as the test needs.
  const gate = `until [ -f ${go} ]; do sleep 0.05; done`;
  await h.call(sup, "supervisor", "set_project", { gate });
  const { lead, lane: opened } = await lane(h, sup, "Slow");
  const call = (id: string, agent: string, role: string, tool: string, args: Record<string, unknown>) =>
    h.runtime.desk.answer({ id, agent, role, tool, args, cwd: h.root, at: Date.now() }, { within: 100 });

  // The bridge waits five minutes but the gate thirty, so a retried call must not start a second gate.
  const report = { summary: "ready to land", ready: true };
  const [first, again] = await Promise.all([
    call("r1", lead, "lead", "report", report),
    call("r2", lead, "lead", "report", report),
  ]);
  assert.match(first.text, /still working on report/);
  assert.match(again.text, /already running/);
  writeFileSync(go, "");
  assert.ok(await within(5000, () => /ANSWER to your report call/.test(heard(h, lead))), "answered as mail");
  assert.equal(readdirSync(join(h.project.state, "gates")).filter((name) => name.startsWith("L1-")).length, 1);
  assert.equal(heard(h, lead).split("ANSWER to your report call").length - 1, 1, "once, for both calls");
  assert.match(heard(h, sup), /REPORT L1/);

  // An answer promised as mail that the outbox cannot take stays promised, so the next start still owns up to it.
  rmSync(go);
  const errors = t.mock.method(console, "error", () => {});
  const post = t.mock.method(h.runtime.outbox, "post", async () => {
    throw new Error("the disk is full");
  });
  assert.match((await call("r3", lead, "lead", "report", report)).text, /still working on report/);
  writeFileSync(go, "");
  const said = () => errors.mock.calls.map((line) => line.arguments.map(String).join(" ")).join("\n");
  assert.ok(await within(5000, () => /could not be mailed/.test(said())), "reported, and the desk goes on");
  const kept = JSON.parse(readFileSync(join(stateRoot(), "intents.json"), "utf-8")) as {
    promised: { agent: string; tool: string }[];
  };
  assert.deepEqual(
    kept.promised.map(({ agent, tool }) => [agent, tool]),
    [[lead, "report"]],
  );
  post.mock.restore();
  errors.mock.restore();

  rmSync(go);
  await h.call(sup, "supervisor", "set_project", { gateOn: "task" });
  await h.call(lead, "lead", "add_tasks", { tasks: [task("Work")] });
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  h.commit(opened.worktree!, "a.txt", "A\n");
  await h.beginTurn(peer);
  assert.match(
    (await call("d1", peer, "peer", "done", { outcome: "complete", summary: "done" })).text,
    /still working on done/,
  );
  h.agents.get(peer)!.status = "idle";
  await h.endTurn(peer, "handed back, ending my turn as told");
  assert.equal(h.ledger().tasks["L1-T1"]!.silent, 0, "a call still being worked on is not silence");
  assert.doesNotMatch(heard(h, peer), /without calling done or ask/);
  writeFileSync(go, "");
  assert.ok(await within(5000, () => h.ledger().tasks["L1-T1"]!.status === "done"));
  assert.match(heard(h, lead), new RegExp(`Gate: ${gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} passed`));
});

test("mail never reaches a running seat inside its turn, whatever its agent: it waits for the turn's end, then comes as one", async (t) => {
  const h = harness();
  // Seats on an agent that could take a message mid-turn and on one that could not are held alike.
  writeFileSync(
    join(h.project.state, "settings.json"),
    JSON.stringify({ roles: { peer: { harness: "omp", model: "glm-5" } } }),
  );
  const sup = h.add(SUPERVISOR, h.root, "sup");
  const { lead, peer } = await lane(h, sup, "Pricing", "Round");
  assert.deepEqual([h.agents.get(lead)!.status, h.agents.get(peer)!.status], ["running", "running"]);

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await h.beginTurn(lead);
  await h.beginTurn(peer);
  t.mock.timers.tick(10 * 60_000);
  for (const text of ["Is the premise right?", "Stop: the premise is wrong."]) {
    const told = await h.call(sup, "supervisor", "message", { to: "L1", text });
    assert.match(told.text, /Queued for the Lead of L1/, "however long its turn has run");
  }
  const toPeer = await h.call(lead, "lead", "message", { to: "L1-T1", text: "Stop: the premise is wrong." });
  assert.match(toPeer.text, /Queued for the Peer on L1-T1/);
  await h.tick();
  for (const seat of [lead, peer])
    assert.deepEqual(
      [h.agents.get(seat)!.steered, h.agents.get(seat)!.sent.filter((text) => /premise/.test(text))],
      [[], []],
      "nothing cuts into a turn it thinks or writes in",
    );
  await h.idle(lead);
  assert.match(
    h.agents.get(lead)!.sent.at(-1)!,
    /^2 messages[^]*Is the premise right\?[^]*Stop: the premise is wrong\./,
    "its queue comes as one message once the turn ends",
  );
});

test("with the Human out of the loop, a Lead's ask nobody answers in time goes back to the Lead to settle, and whoever supervises hears so", async () => {
  const h = harness();
  const sup = h.add(SUPERVISOR, h.root, "sup");
  const { lead } = await lane(h, sup, "Endpoint");
  const start = Date.now();
  await h.call(lead, "lead", "ask", { kind: "question", text: "Keep the old endpoint?", default: "keep it" });
  const id = Object.values(h.ledger().asks).at(-1)!.id;
  h.agents.get(sup)!.status = "running";
  h.projectSettings({ attention: { askLapseMinutes: 20 } });
  writeFileSync(join(h.project.state, "CONTEXT.md"), "# Endpoint\n");
  await h.tick(start + 19 * 60_000);
  assert.equal(h.ledger().asks[id]!.status, "open", "whoever supervises has the owner's time to answer first");
  await h.tick(start + 21 * 60_000);
  assert.equal(h.ledger().asks[id]!.status, "answered");
  assert.equal(
    h.ledger().asks[id]!.answer,
    "Nobody answered within 21 minutes: it went back to its Lead to settle.",
    "the record says what happened, not a settlement the Lead has yet to make",
  );
  assert.match(
    heard(h, lead),
    new RegExp(
      `NO ANSWER to your ask ${id} in 21 minutes: Keep the old endpoint\\?\\n\\nNext: Settle it yourself from ${join(h.project.state, "CONTEXT.md")}, your directive and the code`,
    ),
  );
  assert.match(heard(h, sup), new RegExp(`LAPSED ${id} from the Lead of L1: unanswered for 21 minutes`));
  assert.match((await h.call(sup, "supervisor", "answer", { ask: id, text: "keep it" })).text, /already answered/);
  const report = await h.report();
  assert.ok("decided" in report);
  assert.deepEqual(
    report.decided.map((item) => [item.title, item.detail]),
    [[`${id} went back to the Lead of L1 to settle`, "nobody answered in 21 minutes: Keep the old endpoint?"]],
    "the Human reads on the Report what the Lead settled without them",
  );

  h.projectSettings({ hitl: { on: true } });
  await h.call(lead, "lead", "ask", { kind: "question", text: "Rename it?", default: "no" });
  const kept = Object.values(h.ledger().asks).at(-1)!.id;
  await h.tick(start + 200 * 60_000);
  assert.equal(h.ledger().asks[kept]!.status, "open", "in the loop, the Human's answer is waited for");
});

test("word held for a seat rides the reply to its own call inside a short turn, and wakes nobody", async () => {
  const h = harness();
  const sup = h.add(SUPERVISOR, h.root, "sup");
  let n = 0;
  const status = (stop = new AbortController()) =>
    h.runtime.answer(
      { id: `c${++n}`, agent: sup, role: "supervisor", tool: "status", args: {}, cwd: h.root, at: Date.now() },
      stop.signal,
    );
  await h.idle(sup);
  await h.runtime.outbox.post({ to: sup, key: "land:L1:landed", text: "LANDED L1 (Cart)", wakes: false });
  // The Human writes, and the Supervisor answers in a turn too short for mail to be steered into it.
  h.agents.get(sup)!.status = "running";
  await h.beginTurn(sup);
  const stopped = new AbortController();
  stopped.abort();
  assert.doesNotMatch((await status(stopped)).text, /LANDED L1/, "a reply nobody will read carries nothing");
  const reply = await status();
  assert.match(reply.text, /\n\n---\n\nMail the desk held for you:\n\n[^]*LANDED L1 \(Cart\)/);
  assert.deepEqual(h.runtime.outbox.pending(sup), []);
  h.agents.get(sup)!.status = "idle";
  await h.endTurn(sup, "L1 has landed.");
  assert.deepEqual(h.agents.get(sup)!.sent, [], "nothing is sent to start another turn");
});

test("mail given up for a seat that is gone is on its project's record", async () => {
  const h = harness();
  const sup = h.add(SUPERVISOR, h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", {
    title: "Numbers",
    outcome: "a.txt gains words",
    acceptance: ["four"],
    outOfScope: ["the rest"],
  });
  const lead = h.ledger().lanes.L1!.lead!;
  await h.call(lead, "lead", "status", {});
  await h.runtime.outbox.post({ to: lead, key: "closed:L1", text: "LANE CLOSED L1", wakes: false });
  h.agents.get(lead)!.archivedAt = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
  await h.tick();
  assert.deepEqual(h.runtime.outbox.pending(lead), []);
  assert.deepEqual(
    h.events("mail.dropped").map((event) => [event.to, event.key, event.why]),
    [[lead, "closed:L1", "its seat has been archived a day"]],
  );
});

test("a Lead in a running turn is never cut into: its Peers' hand-backs wait in its queue and reach it as one, when its turn ends", async () => {
  const { h, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "b", title: "Receipt", goal: "g", acceptance: ["b"], holds: ["b.txt"], parallel: true }],
  });
  const other = h.ledger().tasks["L1-T2"]!.peer!;
  await h.idle(lead);
  const seat = h.agents.get(lead)!;
  const before = seat.sent.length;
  seat.status = "running";
  h.runtime.outbox.turnStarted(lead);
  h.commit(lane.worktree!, "a.txt", "A\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "a" });
  await h.call(other, "peer", "done", { outcome: "complete", summary: "b" });
  await h.tick();
  assert.deepEqual(seat.steered, [], "nothing is steered into a turn it is thinking or writing in");
  assert.equal(seat.sent.length, before, "nor sent in place of it");
  await h.idle(lead);
  assert.match(seat.sent.at(-1)!, /^2 messages[^]*HANDBACK L1-T1 [^]*HANDBACK L1-T2 /, "both, in one message");
});

test("a letter names who sent it by the work it holds, not by its agent's id", async () => {
  const { h, lane, peer } = await laneWithPeer();
  h.commit(lane.worktree!, "a.txt", "A\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "a" });
  await h.idle(lane.lead!);
  assert.match(h.heard(lane.lead!).join("\n"), /HANDBACK L1-T1 \(Clean build\) from the Peer on L1-T1\n/);
  assert.doesNotMatch(h.heard(lane.lead!).join("\n"), new RegExp(`from ${peer}`));
});

test("a queue reaches its seat as one message that lists its letters first and numbers each, so none reads as part of another", async () => {
  const { h, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "b", title: "Receipt", goal: "g", acceptance: ["b"], holds: ["b.txt"], parallel: true }],
  });
  const other = h.ledger().tasks["L1-T2"]!.peer!;
  await h.idle(lead);
  h.agents.get(lead)!.status = "running";
  h.commit(lane.worktree!, "a.txt", "A\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "a" });
  await h.call(other, "peer", "ask", {
    question: "Cents or units?",
    disputes: "units",
    tried: "the ledger keeps cents",
  });
  await h.idle(lead);
  const batch = h.agents.get(lead)!.sent.at(-1)!;
  assert.match(
    batch,
    /^2 messages: 1 HANDBACK L1-T1 \(Clean build\) from the Peer on L1-T1 · 2 CHALLENGE A1 from the Peer on L1-T2 \(Receipt\)\n\n--- 1 of 2 ---\n\nHANDBACK L1-T1 [^]*\n\n--- 2 of 2 ---\n\nCHALLENGE A1 /,
  );
  assert.match(batch, /\n\n---\n\nOpen asks waiting on you:\n- A1 \(challenge\)/, "the asks still open, after them");
});
