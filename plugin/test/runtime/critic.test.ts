import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness } from "./harness.ts";

const lane = { title: "Login", outcome: "Users sign in with email and password.", acceptance: ["A right password signs the user in.", "A wrong password shows an error."], outOfScope: ["social login"] };

/** A Supervisor whose conversation holds the Human's words, its own words and a desk letter, in a project set as `settings` says. */
function talked(outbox: string, settings?: Record<string, unknown>) {
  const h = harness(outbox);
  if (settings) {
    mkdirSync(h.project.state, { recursive: true });
    writeFileSync(join(h.project.state, "settings.json"), JSON.stringify(settings));
  }
  const sup = h.add("sw2-supervisor-claude/claude-opus-5", h.root, "sup");
  const timeline = h.timelineOf(sup);
  // As the daemon records them: the prompt a seat was started with carries only a messageId of its own.
  timeline.add({ type: "user_message", text: "Let users sign in with email and password, and keep them signed in for a day.", messageId: "773d2eee-257e" });
  timeline.add({ type: "reasoning", text: "They probably want password reset too." });
  timeline.add({ type: "assistant_message", text: "Should a session also survive a browser restart?" });
  timeline.add({ type: "user_message", text: "Yes, a day even across restarts.", clientMessageId: "0b52e1f7-ui" });
  timeline.add({ type: "user_message", text: "REPORT L9 (Old): ready to land", clientMessageId: "sw2-3f2a", messageId: "sw2-3f2a" });
  timeline.add({
    type: "tool_call",
    callId: "ask-1",
    name: "AskUserQuestion",
    status: "completed",
    detail: { type: "unknown", input: { questions: [{ question: "Should a remembered sign-in end on sign-out?" }] }, output: { output: 'Your questions have been answered: "Should a remembered sign-in end on sign-out?"="Yes, sign-out ends it everywhere". You can now continue with these answers in mind.' } },
  });
  mkdirSync(h.project.state, { recursive: true });
  writeFileSync(join(h.project.state, "CONTEXT.md"), "# Context\n\n- Session: what keeps a user signed in.\n");
  const critics = () => [...h.agents.values()].filter((agent) => agent.provider.startsWith("sw2-critic-"));
  return { h, sup, critics };
}

test("a lane opened is read by a fresh Critic against the Human's own words and CONTEXT.md, never the Supervisor's", async () => {
  const { h, sup, critics } = talked("outbox-critic.json");
  const opened = await h.call(sup, "supervisor", "open_lane", { ...lane, isolate: true });
  assert.equal(opened.ok, true, opened.text);
  const [critic] = critics();
  assert.ok(critic, "a Critic is seated for the lane");
  assert.equal(critic.labels["seatworks.critique"], "L1");
  const brief = critic.prompt ?? "";
  assert.match(brief, /Let users sign in with email and password, and keep them signed in for a day\./);
  assert.match(brief, /Yes, a day even across restarts\./);
  assert.match(brief, /"Should a remembered sign-in end on sign-out\?"="Yes, sign-out ends it everywhere"/, "what the Human chose when asked is theirs too");
  assert.match(brief, /Session: what keeps a user signed in\./);
  assert.match(brief, /A wrong password shows an error\./);
  assert.doesNotMatch(brief, /password reset|browser restart\?|REPORT L9/, "not what the Supervisor thought or said, nor the desk's own mail");

  const invented = await h.call(critic.id, "critic", "findings", { lane: "L1", findings: [{ kind: "missing", human: "keep them signed in for a week", lane: "", why: "x", question: "y" }] });
  assert.equal(invented.ok, false);
  assert.match(invented.text, /"keep them signed in for a week" is not in what the Human wrote/);
  const found = await h.call(critic.id, "critic", "findings", {
    lane: "L1",
    findings: [{ kind: "missing", human: "keep them signed in for a day", lane: "", why: "Nothing in the lane keeps a user signed in, so the Lead builds sign-in with no session length.", question: "Should a session last 24 hours, across browser restarts? Recommended: yes, as you said." }],
  });
  assert.equal(found.ok, true, found.text);
  await h.endTurn(critic.id, "Handed in.");
  await h.idle(sup);
  const told = h.agents.get(sup)!.sent.join("\n");
  assert.match(told, /CRITIQUE L1 \(Login\): 1 point where the Human's words and the lane may not agree[^]*missing — the Human: "keep them signed in for a day"; the lane says nothing of it[^]*Should a session last 24 hours/);
  assert.ok(critic.archivedAt, "one look, then it goes");
  h.runtime.dispose();
});

test("a Critic that finds nothing sends nothing, one quoting a lane that is not there is refused, and off seats none", async () => {
  const quiet = talked("outbox-critic-quiet.json");
  await quiet.h.call(quiet.sup, "supervisor", "open_lane", { ...lane, isolate: true });
  const [critic] = quiet.critics();
  const misquoted = await quiet.h.call(critic!.id, "critic", "findings", { lane: "L1", findings: [{ kind: "contradiction", human: "sign in with email and password", lane: "Users sign in with a phone number.", why: "x", question: "y" }] });
  assert.match(misquoted.text, /"Users sign in with a phone number\." is not in the lane/);
  assert.equal((await quiet.h.call(critic!.id, "critic", "findings", { lane: "L1", findings: [] })).ok, true);
  await quiet.h.endTurn(critic!.id, "Nothing to hand in.");
  await quiet.h.idle(quiet.sup);
  assert.doesNotMatch(quiet.h.agents.get(quiet.sup)!.sent.join("\n"), /CRITIQUE/);
  assert.ok(critic!.archivedAt);
  quiet.h.runtime.dispose();

  const off = talked("outbox-critic-off.json", { critic: { by: "off" } });
  await off.h.call(off.sup, "supervisor", "open_lane", { ...lane, isolate: true });
  assert.deepEqual(off.critics(), []);
  off.h.runtime.dispose();
});

test("a Critic whose turn ends without handing its findings in is let go all the same", async () => {
  const { h, sup, critics } = talked("outbox-critic-silent.json");
  await h.call(sup, "supervisor", "open_lane", { ...lane, isolate: true });
  const [critic] = critics();
  await h.endTurn(critic!.id, "I read it.");
  assert.ok(critic!.archivedAt);
  h.runtime.dispose();
});

test("the desk marks every letter it sends, which is how the Human's own words are told from its mail", async () => {
  const { h, sup } = talked("outbox-critic-mark.json");
  await h.runtime.desk.post(sup, "hello", "A letter.");
  await h.idle(sup);
  assert.ok(h.agents.get(sup)!.sentIds.length > 0);
  assert.ok(h.agents.get(sup)!.sentIds.every((id) => id.startsWith("sw2-")));
  h.runtime.dispose();
});

test("a lane that waits for another is read by a Critic when it is recorded, not when its turn comes", async () => {
  const { h, sup, critics } = talked("outbox-critic-waiting.json");
  await h.call(sup, "supervisor", "open_lane", { ...lane, isolate: true });
  await h.call(sup, "supervisor", "open_lane", { ...lane, title: "Remember me", after: ["L1"] });
  assert.equal(h.ledger().lanes.L2!.status, "waiting");
  assert.deepEqual(critics().map((critic) => critic.labels["seatworks.critique"]), ["L1", "L2"]);
  h.runtime.dispose();
});

test("a quote copied in another case or without its full stop is still the words it copies", async () => {
  const { h, sup, critics } = talked("outbox-critic-case.json");
  await h.call(sup, "supervisor", "open_lane", { ...lane, isolate: true });
  const [critic] = critics();
  const recased = await h.call(critic!.id, "critic", "findings", { lane: "L1", findings: [{ kind: "contradiction", human: "let users sign in with email and password", lane: "a wrong password shows an error", why: "x", question: "y" }] });
  assert.equal(recased.ok, true, recased.text);
  h.runtime.dispose();
});
