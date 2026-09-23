import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Seats } from "../../server/core/ports.ts";
import { Outbox } from "../../server/runtime/outbox.ts";
import { tempDir } from "../tempdir.ts";

type FakeAgent = { status: string; pendingPermissions: { title?: string; name?: string }[]; archivedAt: string | null; sent: string[]; steered: string[] };

function fakeSeats(agents: Record<string, FakeAgent>): Seats {
  return {
    async open() {
      return [];
    },
    async look(id: string) {
      const agent = agents[id]!;
      return { id, status: agent.status, pendingPermissions: agent.pendingPermissions, archivedAt: agent.archivedAt };
    },
    async send(id: string, text: string, steer?: boolean) {
      agents[id]!.sent.push(text);
      if (steer) agents[id]!.steered.push(text);
    },
    async respond() {},
    async archive() {},
    watch() {
      throw new Error("the outbox watches nobody");
    },
  };
}

const agent = (status: string): FakeAgent => ({ status, pendingPermissions: [], archivedAt: null, sent: [], steered: [] });

const outboxOn = (agents: Record<string, FakeAgent>, compose: (to: string, list: { text: string }[]) => string, steers = false) =>
  new Outbox(join(tempDir(), "outbox.json"), compose, fakeSeats(agents), undefined, () => steers);

test("a letter to an idle seat is sent at once and the same key is not sent twice", async () => {
  const agents = { sup: agent("idle") };
  const outbox = outboxOn(agents, (_to, list) => list.map((letter) => letter.text).join("|"));
  assert.equal(await outbox.post({ to: "sup", key: "k1", text: "one" }), "sent");
  assert.deepEqual(agents.sup.sent, ["one"]);
  assert.equal(await outbox.post({ to: "sup", key: "k1", text: "one" }), "duplicate");
});

test("confirmed delivery deduplication survives a process restart", async () => {
  const agents = { lead: agent("idle") };
  const file = join(tempDir(), "outbox.json");
  const make = () => new Outbox(file, (_to, list) => list.map((l) => l.text).join("|"), fakeSeats(agents));
  await make().post({ to: "lead", key: "correction-1", text: "Keep the existing API" });
  assert.equal(await make().post({ to: "lead", key: "correction-1", text: "Keep the existing API" }), "duplicate");
  assert.equal(agents.lead.sent.length, 1);
});

test("letters to a busy seat are held and go out together when its turn ends", async () => {
  const agents = { sup: agent("running") };
  const outbox = outboxOn(agents, (_to, list) => list.map((letter) => letter.text).join("|"));
  assert.equal(await outbox.post({ to: "sup", key: "a", text: "first" }), "held");
  assert.equal(await outbox.post({ to: "sup", key: "b", text: "second" }), "held");
  agents.sup.status = "idle";
  outbox.turnEnded("sup");
  const sent = await outbox.pump("sup");
  assert.equal(sent.size, 2);
  assert.deepEqual(agents.sup.sent, ["first|second"]);
  assert.deepEqual(outbox.pending("sup"), []);
});

test("after sending, a seat is left alone until its turn ends", async () => {
  const agents = { sup: agent("idle") };
  const outbox = outboxOn(agents, (_to, list) => list.map((letter) => letter.text).join("|"));
  await outbox.post({ to: "sup", key: "a", text: "first" });
  assert.equal(await outbox.post({ to: "sup", key: "b", text: "second" }), "held");
  outbox.turnEnded("sup");
  await outbox.pump("sup");
  assert.deepEqual(agents.sup.sent, ["first", "second"]);
});

test("a seat with a pending permission or an archived seat receives nothing, and neither one's mail is thrown away", async () => {
  const agents = { a: { ...agent("idle"), pendingPermissions: [{}] }, b: { ...agent("idle"), archivedAt: "2026-01-01" } };
  const outbox = outboxOn(agents, (_to, list) => list[0]!.text);
  assert.equal(await outbox.post({ to: "a", key: "x", text: "t" }), "held");
  assert.equal(await outbox.post({ to: "b", key: "y", text: "t" }), "held");
  assert.equal(outbox.pending("a").length, 1);
  assert.equal(outbox.pending("b").length, 1, "a Lead's report must outlive the seat it was addressed to");
});

test("mail for a seat Paseo cannot answer for is held, and the round goes on to the next seat", async () => {
  const agents = { real: agent("idle") };
  const outbox = outboxOn(agents, (_to, list) => list[0]!.text);
  assert.equal(await outbox.post({ to: "gone", key: "x", text: "a report nobody can read yet" }), "held", "a tool that did its work is not failed by an address");
  assert.equal(outbox.pending("gone").length, 1);
  assert.equal(await outbox.post({ to: "real", key: "y", text: "and this still goes out" }), "sent");
  assert.deepEqual(agents.real.sent, ["and this still goes out"]);
});

test("a seat whose harness takes mail mid-turn gets it in a settled turn, and a turn still starting is left alone", async () => {
  const agents = { lead: agent("running"), fresh: agent("running"), unseen: agent("running") };
  const outbox = outboxOn(agents, (_to, list) => list.map((letter) => letter.text).join("|"), true);
  outbox.turnStarted("lead", Date.now() - 2 * 60_000);
  assert.equal(await outbox.post({ to: "lead", key: "a", text: "the owner says stop" }), "sent");
  assert.deepEqual(agents.lead.steered, ["the owner says stop"], "into the running turn, not in place of it");
  // A steer the provider cannot take yet is turned into replacing the turn by the daemon.
  outbox.turnStarted("fresh");
  assert.equal(await outbox.post({ to: "fresh", key: "a", text: "t" }), "held");
  // Nor one the desk never saw start, which may have begun a moment ago.
  assert.equal(await outbox.post({ to: "unseen", key: "a", text: "t" }), "held");
  assert.deepEqual([...agents.fresh.sent, ...agents.unseen.sent], []);
});

test("a harness that cannot take mail mid-turn, or a seat stopped on a permission, still waits", async () => {
  const agents = { peer: agent("running"), asking: { ...agent("running"), pendingPermissions: [{ title: "Which?" }] } };
  const plain = outboxOn(agents, (_to, list) => list[0]!.text, false);
  plain.turnStarted("peer", Date.now() - 2 * 60_000);
  assert.equal(await plain.post({ to: "peer", key: "a", text: "t" }), "held");
  const steering = outboxOn(agents, (_to, list) => list[0]!.text, true);
  steering.turnStarted("asking", Date.now() - 2 * 60_000);
  assert.equal(await steering.post({ to: "asking", key: "a", text: "t" }), "held", "it has stopped until the permission is decided");
  assert.deepEqual([...agents.peer.sent, ...agents.asking.sent], []);
});
