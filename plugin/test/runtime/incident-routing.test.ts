import assert from "node:assert/strict";
import { test } from "node:test";
import { saveIncidents } from "../../server/desk/store/incidents.ts";
import { projectOf } from "../../server/desk/project/project.ts";
import { laneWithPeer, repo } from "./harness.ts";
import { book, notice } from "./noticed.ts";

test("a page held for nobody is told once somebody can read it, though the task it is about merged meanwhile", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  h.agents.get(sup)!.archivedAt = new Date().toISOString();
  await notice(h, peer, "destructive", "page", "rm -rf build");
  assert.equal(book(h).I1!.held, "nobody");
  h.commit(lane.worktree!, "a.txt", "done\n");
  await h.call(peer, "peer", "done", { outcome: "complete", summary: "done" });
  await h.call(lane.lead!, "lead", "accept", { task: "L1-T1" });
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "merged");
  h.agents.get(sup)!.archivedAt = null;
  await h.tick();
  assert.match(h.heard(sup).join("\n"), /INCIDENT I1 \(destructive, page\)[\s\S]*rm -rf build/);
});

test("what was held because nobody could read it is told once somebody can, and never to the seat it is about", async (t) => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const seated = (yes: boolean) => void (h.agents.get(sup)!.archivedAt = yes ? null : new Date().toISOString());
  const told = (id: string) => h.heard(sup).filter((text) => text.includes(`INCIDENT ${id} `));
  const second = repo();
  const other = projectOf(second.root);
  const supB = h.add("sw3-supervisor-claude/claude-opus-5", second.root, "sup-b");

  seated(false);
  await notice(h, peer, "destructive", "page", "rm -rf build");
  assert.equal(book(h).I1!.held, "nobody");
  seated(true);
  assert.deepEqual((await notice(h, peer, "destructive", "page", "git push --force origin main")).sent, ["I1"]);
  assert.match(
    told("I1").join("\n"),
    /INCIDENT I1 \(destructive, page\)[\s\S]*git push --force origin main/,
    "on its next sighting, in the latest words",
  );
  await notice(h, peer, "destructive", "page", "rm -rf dist");
  assert.equal(told("I1").length, 1, "told once, then quiet");
  assert.equal(
    book(h).I1!.quote,
    "git push --force origin main",
    "what the Supervisor was told is what stays on record",
  );
  assert.equal((await h.call(sup, "supervisor", "mark_incident", { id: "I1", verdict: "useful" })).ok, true);

  seated(false);
  await notice(h, peer, "destructive", "page", "rm -rf src");
  await h.tick();
  assert.deepEqual(told("I2"), [], "nobody yet");
  seated(true);
  await h.tick();
  await h.tick();
  assert.equal(told("I2").length, 1, "the round tells it once somebody sits down, and once only");
  assert.match(told("I2").join("\n"), /rm -rf src/);
  await notice(h, peer, "destructive", "page", "git push --force origin main");
  const acked = await h.call(sup, "supervisor", "mark_incident", { id: "I2", verdict: "useful" });
  assert.match(
    acked.text,
    /after you were told: git push --force origin main/,
    "a sighting after the letter is kept beside it",
  );
  assert.equal(book(h).I2!.quote, "rm -rf src");

  seated(false);
  await notice(h, lane.lead!, "stuck");
  await notice(h, peer, "destructive", "page", "rm -rf lib");
  seated(true);
  await h.tick();
  assert.deepEqual(
    [told("I3").length, told("I4").length],
    [1, 1],
    "once somebody sits down, all that was held for nobody is told",
  );

  const self = await notice(h, sup, "destructive", "page", "rm -rf build");
  assert.deepEqual(self.sent, [], "an incident is never addressed to the seat it is about");
  assert.equal(book(h).I5!.held, "nobody");

  await notice(
    h,
    { id: "p-b", provider: "sw3-peer-claude/claude-opus-5" },
    "destructive",
    "page",
    "rm -rf build",
    other,
  );
  assert.match(
    h.heard(supB).join("\n"),
    /INCIDENT I1 \(destructive, page\)/,
    "the second project's owner is told of its own I1, not dropped as a repeat of the first's",
  );

  t.mock.method(h.runtime.outbox, "post", () => Promise.reject(new Error("the outbox could not be written")), {
    times: 1,
  });
  await notice(h, lane.lead!, "destructive", "page", "rm -rf data");
  assert.equal(book(h).I6!.held, "nobody", "a letter that never left is not a page told");
  await h.tick();
  assert.match(told("I6").join("\n"), /rm -rf data/, "the round tells it again");
});

test("a lane's own record raises an incident about its Lead once, held while the watch is off, never about a Lead that is gone", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const lead = lane.lead!;
  const rework = async (round: number) => {
    await h.call(peer, "peer", "done", { outcome: "complete", summary: `round ${round}` });
    await h.call(lead, "lead", "rework", { task: "L1-T1", text: "not yet" });
  };
  // The second sending-back is a struggle of the Peer's too, which the book keeps apart from this.
  const loops = () => Object.values(book(h)).filter((item) => item.kind === "rework-loop");
  for (const round of [1, 2, 3]) await rework(round);
  assert.equal(h.ledger().tasks["L1-T1"]!.reworks, 3, "three sendings-back are on the record");
  await h.tick();
  await h.tick();
  const told = h.heard(sup).join("\n");
  const [first] = loops();
  assert.match(
    told,
    new RegExp(`INCIDENT ${first!.id} \\(rework-loop, attend\\) on the Lead of L1 \\(Build\\)`),
    "a lane's record is gone through for what no turn shows, and told about the seat that decides to send it back",
  );
  assert.match(told, /What was seen: L1-T1 \(Clean build\) has been sent back 3 times/);
  assert.match(
    told,
    /\nNext: [^\n]*same Peer[^\n]*seat the task afresh, briefed with what the rounds learned/,
    "a fresh seat is one way out, beside the same Peer, which stays the Lead's default",
  );
  assert.equal(loops().length, 1, "the incident already on the book, not a second one");
  assert.doesNotMatch(h.heard(lead).join("\n"), /INCIDENT/, "never shown to the Lead it is about");

  const marked = await h.call(sup, "supervisor", "mark_incident", {
    id: first!.id,
    verdict: "noise",
    note: "expected: the brief changed under it",
  });
  assert.equal(marked.ok, true, marked.text + JSON.stringify(book(h)));
  await h.tick();
  await h.tick();
  assert.equal(loops().length, 1, "the same three sendings-back are not raised again once marked");
  await rework(4);
  await h.tick();
  assert.equal(loops().length, 2, "a fourth sending-back is something new to say");

  assert.equal((await h.call(sup, "supervisor", "mark_incident", { id: loops()[1]!.id, verdict: "noise" })).ok, true);
  await rework(5);
  h.agents.get(lead)!.archivedAt = new Date().toISOString();
  await h.tick();
  assert.equal(loops().length, 2, "an incident about a Lead that has gone is one nobody can close");
});

const quote = "the same action failing 3 times: Bash: npm test";

test("nothing reaches a seat that names or quotes an open incident about it from whoever supervises, who alone reads incidents", async () => {
  const { h, sup, lane, peer } = await laneWithPeer();
  const now = Date.now();
  const about = (id: string, seat: string) => ({
    id,
    seat,
    where: "L1",
    kind: "stuck",
    level: "attend" as const,
    quote,
    facts: ["stuck"],
    opened: now,
    last: now,
    count: 1,
    open: true,
  });
  saveIncidents(h.project.state, { next: 3, items: { I1: about("I1", peer), I2: about("I2", lane.lead!) } });
  const refusal = /That repeats incident I1 about the seat it goes to/;

  assert.match((await h.call(sup, "supervisor", "message", { to: "L1-T1", text: `See I1.` })).text, refusal);
  assert.match(
    (await h.call(sup, "supervisor", "message", { to: "L1-T1", text: `You hit ${quote.toUpperCase()}.` })).text,
    refusal,
  );
  assert.match(
    (await h.call(sup, "supervisor", "message", { to: "L1", text: `${quote}?` })).text,
    /That repeats incident I2/,
  );
  assert.match(
    (await h.call(sup, "supervisor", "message", { to: "L1-T1", text: "Why did I2 go that way?" })).text,
    /That repeats incident I2/,
    "what reaches a Peer is told to its Lead too, so it is checked against both",
  );
  assert.match(
    (
      await h.call(sup, "supervisor", "amend_lane", {
        lane: "L1",
        why: "the Human changed it",
        acceptance: [`no more ${quote}`],
      })
    ).text,
    /That repeats incident I2/,
  );
  assert.equal(
    (
      await h.call(sup, "supervisor", "message", {
        to: "L1",
        text: "The test run keeps failing the same way; what does the first failure say?",
      })
    ).ok,
    true,
  );

  // A Lead never reads an incident, so what it says to its Peer is its own and passes: here, only by chance the same words.
  assert.equal((await h.call(lane.lead!, "lead", "message", { to: "L1-T1", text: `You hit ${quote}.` })).ok, true);
  await h.call(peer, "peer", "ask", { question: "Which rounding?", bestGuess: "half up" });
  assert.match(
    (await h.call(sup, "supervisor", "answer", { ask: "A1", text: "Half up, as I2 showed." })).text,
    /That repeats incident I2/,
    "an answer put past the Lead it was put to reaches that Lead too",
  );
  assert.match((await h.call(sup, "supervisor", "answer", { ask: "A1", text: "Half up. Also I1." })).text, refusal);
  assert.equal((await h.call(lane.lead!, "lead", "answer", { ask: "A1", text: "Half up, I1 aside." })).ok, true);
});
