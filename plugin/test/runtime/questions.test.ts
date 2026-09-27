import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness, laneWithPeer, repo } from "./harness.ts";

const packet = (extra: Record<string, unknown> = {}) => ({
  question: "Delete old invoices, or keep them archived?",
  why: "It decides whether customers' records can come back.",
  options: [
    { label: "Delete", effect: "Invoices older than 7 years are gone for good." },
    { label: "Archive", effect: "They move to cold storage and can be restored." },
  ],
  recommend: "Archive",
  reason: "Nothing is lost, and storage costs little.",
  ifSilent: "The lane archives them, which can be undone.",
  class: "reversible",
  ...extra,
});

test("a costly question still open when the Human steps out of the loop parks nothing at its lane's ready report", async () => {
  const { h, sup, lane } = await laneWithPeer({ hitl: { on: true } }, undefined, { holds: ["a.txt"], parallel: true });
  await h.call(sup, "supervisor", "ask_human", packet({ lane: "L1", class: "costly" }));
  h.projectSettings({ hitl: { on: false } });
  const reported = await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  assert.equal(reported.ok, true, reported.text);
  assert.equal(h.ledger().lanes.L1!.onHold, undefined, "the Supervisor decides it now");
});

test("a question's class decides what waits on it: an irreversible one holds its lane now, a costly one at its ready report, and the Human's standing orders raise it", async () => {
  const { h, sup, lane } = await laneWithPeer({ hitl: { on: true } }, undefined, {
    holds: ["a.txt"],
    parallel: true,
  });
  h.machineSettings({ hitl: { questionsPerDay: 6 } });
  const ask = (extra: Record<string, unknown>) => h.call(sup, "supervisor", "ask_human", packet(extra));
  assert.match(
    (await ask({ lane: "L1", class: "costly" })).text,
    /stops at its next report of ready if they have not answered by then\./,
  );
  assert.equal(h.ledger().lanes.L1!.onHold, undefined);
  const reported = await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  assert.match(
    h.ledger().lanes.L1!.onHold?.reason ?? "",
    /went on without the Human's answer to H1, and stops at its ready report until they answer/,
  );
  assert.deepEqual(h.agents.get(lane.lead!)!.interrupted, [], "the Lead is not cut off inside its own report");
  assert.match(
    reported.text,
    /The lane is on hold: it went on without the Human's answer to H1[^]*nothing starts in it and nothing lands until it resumes\./,
  );
  await h.idle(sup);
  assert.match(
    h.agents.get(sup)!.sent.join("\n"),
    /REPORT L1 \(Build\): ready to land\n\nIt is on hold: it went on without the Human's answer to H1/,
  );
  h.timelineOf(sup).add({ type: "user_message", text: "No. Don't touch invoices at all.", clientMessageId: "app-2" });
  assert.match(
    (
      await h.call(sup, "supervisor", "record_human_answer", {
        question: "H1",
        choice: "decline",
        quote: "No. Don't touch invoices at all.",
      })
    ).text,
    /^H1 is declined: decline\. Lane L1 is still on hold for it/,
  );
  await h.call(sup, "supervisor", "resume_lane", { lane: "L1" });
  assert.match(
    (await ask({ lane: "L1", class: "costly" })).text,
    /Its lane has already reported ready, so it stops now until they answer\. Lane L1 is on hold for it\./,
  );
  assert.match(h.ledger().lanes.L1!.onHold?.reason ?? "", /waits for the Human's answer to H2/);
  assert.match(
    h.heard(lane.lead!).join("\n"),
    /HOLD L1 \(Build\): the desk has stopped this lane for the Human's answer: it waits for the Human's answer to H2/,
    "a lane parked for the Human was not stopped by the owner",
  );
  assert.match(
    (await h.call(sup, "supervisor", "resume_lane", { lane: "L1" })).text,
    /^Lane L1 waits for the Human's answer to H2, and resumes only once they answer, decline or cancel it\.$/,
  );
  assert.ok(h.ledger().lanes.L1!.onHold, "only their word lifts it");
  assert.match(
    (await h.call(sup, "supervisor", "land_lane", { lane: "L1" })).text,
    /^Lane L1 is on hold: [^]*\. It waits for the Human's answer to H2: once they answer, decline or cancel it, or you withdraw it with withdraw_question, resume_lane it, then land it\.$/,
  );

  await h.call(sup, "supervisor", "set_project", { askFirst: ["src/auth"] });
  const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["the rest"], isolate: true };
  await h.call(sup, "supervisor", "open_lane", { title: "Login", ...scope, writeSet: ["src/**"] });
  await h.call(sup, "supervisor", "open_lane", { title: "Session", ...scope });
  const copy = h.ledger().lanes.L3!.worktree!;
  mkdirSync(join(copy, "src", "auth"), { recursive: true });
  h.commit(copy, "src/auth/session.ts", "export const session = 1;\n");
  assert.match(
    (await ask({ lane: "L2" })).text,
    /^Asked the Human as H3; it waits in their question queue\. It is costly, not reversible\. Lane L2 may write under src\/auth, which the Human asked to be asked about first\. The lane goes on/,
  );
  assert.match(
    (await ask({ lane: "L3" })).text,
    /It is costly, not reversible\. Lane L3: It changes src\/auth\/session\.ts, under src\/auth, which the Human asked to be asked about first\./,
  );
  await ask({ lane: "L2", class: "irreversible" });
  assert.deepEqual(
    ["H3", "H4", "H5"].map((id) => h.ledger().questions[id]!.class),
    ["costly", "costly", "irreversible"],
  );
});

test("the Human's daily allowance of questions counts every project, on the Report and when a question is asked", async () => {
  const h = harness();
  h.machineSettings({ hitl: { on: true } });
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const elsewhere = repo().root;
  const theirs = h.add("sw3-supervisor-claude/claude-opus-5", elsewhere, "sup-b");
  assert.match((await h.call(theirs, "supervisor", "ask_human", packet(), elsewhere)).text, /^Asked the Human as H1;/);
  assert.match((await h.call(sup, "supervisor", "ask_human", packet())).text, /^Asked the Human as H1;/);
  const report = await h.report();
  assert.ok("numbers" in report);
  assert.deepEqual(report.numbers[0], { title: "Questions today", value: "2 of 3", detail: "across every project" });
  const lone = (await h.call(sup, "supervisor", "ask_human", packet())).text;
  assert.match(
    lone,
    /^Asked the Human as H2; it waits in their question queue\. Nothing waits for it: what it decides goes ahead/,
  );
  assert.doesNotMatch(lone, /lane/, "a question that names no lane says nothing of one");
  assert.match(
    (await h.call(sup, "supervisor", "ask_human", packet())).text,
    /The Human has had 3 questions in the last day \([^)]*\), and 3 is what they allow/,
  );
  const irreversible = (await h.call(sup, "supervisor", "ask_human", packet({ class: "irreversible" }))).text;
  assert.match(
    irreversible,
    /^Asked the Human as H3; it waits in their question queue\. Nothing it decides goes ahead until they answer\. An answer/,
    "what cannot be undone is never refused for the limit, though it counts",
  );
  assert.doesNotMatch(irreversible, /Lead|lane/, "and with no lane named, no Lead is told to keep off it");
  const counted = await h.report();
  assert.ok("numbers" in counted);
  assert.equal(counted.numbers[0]!.value, "4 of 3");
});

test("with the Human out of the loop nothing queues for them: the Supervisor decides, or asks them directly about the concept", async () => {
  const { h, sup } = await laneWithPeer();
  const asked = await h.call(sup, "supervisor", "ask_human", packet());
  assert.equal(asked.ok, false);
  assert.match(asked.text, /out of the loop on this project, so nothing queues for them: decide it yourself/);
  assert.match(
    asked.text,
    /or what a lane is for or what it costs past what they agreed, ask them directly with your own question tool; write what settles the concept into CONTEXT\.md/,
  );
  assert.deepEqual(h.ledger().questions, {});
});
