import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Seats } from "../../server/core/ports.ts";
import { Outbox } from "../../server/runtime/mail/outbox.ts";
import { reported } from "../console.ts";
import { tempDir } from "../tempdir.ts";

type FakeAgent = {
  status: string;
  pendingPermissions: { id: string; title?: string; name?: string }[];
  archivedAt: string | null;
  looked?: number;
  sent: string[];
  kinds: string[][];
};

function fakeSeats(agents: Record<string, FakeAgent>): Pick<Seats, "look" | "send"> {
  return {
    async look(id: string) {
      const agent = agents[id]!;
      agent.looked = (agent.looked ?? 0) + 1;
      return { id, status: agent.status, pendingPermissions: agent.pendingPermissions, archivedAt: agent.archivedAt };
    },
    async send(id: string, text: string, kinds: string[]) {
      agents[id]!.sent.push(text);
      agents[id]!.kinds.push(kinds);
    },
  };
}

const agent = (status: string, more: Partial<FakeAgent> = {}): FakeAgent => ({
  status,
  pendingPermissions: [],
  archivedAt: null,
  sent: [],
  kinds: [],
  ...more,
});

test("a letter goes to its seat when the seat can take it, and until then is held and kept, never sent twice and never waking a seat for nothing", async () => {
  const agents = {
    sup: agent("idle"),
    busy: agent("running"),
    asking: agent("idle", { pendingPermissions: [{ id: "p1" }] }),
    archived: agent("idle", { archivedAt: "2026-01-01" }),
    real: agent("idle"),
    lead: agent("running"),
    peer: agent("running"),
    stopped: agent("running", { pendingPermissions: [{ id: "p2", title: "Which?" }] }),
    quiet: agent("idle"),
  };
  const file = join(tempDir(), "outbox.json");
  const outbox = new Outbox(file, (_seat, list) => list.map((letter) => letter.text).join("|"), fakeSeats(agents));
  const post = (to: string, key: string, text: string, wakes?: false) =>
    outbox.post({ to, key, text, ...(wakes === false ? { wakes } : {}) });

  assert.equal(await post("sup", "k1", "one"), "sent", "an idle seat is sent a letter at once");
  assert.deepEqual(agents.sup.sent, ["one"]);
  assert.equal(await post("sup", "k1", "one"), "duplicate");
  assert.equal(await post("sup", "b", "second"), "held", "after sending, a seat is left alone until its turn ends");
  outbox.turnEnded("sup");
  await outbox.pump("sup");
  assert.deepEqual(agents.sup.sent, ["one", "second"]);

  for (const [key, text] of [
    ["rework:L1-T1:1", "first"],
    ["amended:L1-T1:1", "second"],
    ["rework:L1-T1:2", "third"],
  ] as const)
    assert.equal(await post("busy", key, text), "held", "a busy seat's letters wait");
  agents.busy.status = "idle";
  outbox.turnEnded("busy");
  assert.equal((await outbox.pump("busy")).size, 3);
  assert.deepEqual(agents.busy.sent, ["first|second|third"], "and go out together when its turn ends");
  assert.deepEqual(agents.busy.kinds, [["rework", "amended"]], "each kind of letter in it named once");
  assert.deepEqual(outbox.pending("busy"), []);

  assert.equal(await post("asking", "x", "t"), "held", "a seat with a pending permission receives nothing");
  assert.equal(await post("archived", "y", "t"), "held", "nor does an archived one");
  assert.deepEqual([outbox.pending("asking").length, outbox.pending("archived").length], [1, 1], "neither's is lost");
  const looked = agents.archived.looked;
  assert.equal(await post("archived", "z", "t"), "held");
  assert.equal(agents.archived.looked, looked, "an archived seat is not looked up again, round after round");
  agents.archived.archivedAt = null;
  outbox.turnStarted("archived");
  outbox.turnEnded("archived");
  assert.equal(await post("archived", "w", "t"), "sent", "until Paseo starts it again");
  assert.equal(await post("gone", "x", "a report nobody can read yet"), "held", "an address is no failure");
  assert.equal(outbox.pending("gone").length, 1);
  assert.equal(await post("real", "y", "and this still goes out"), "sent");
  assert.deepEqual(agents.real.sent, ["and this still goes out"]);

  outbox.turnStarted("lead");
  for (const [key, text] of [
    ["done:L1-T1", "L1-T1 handed back"],
    ["done:L1-T2", "L1-T2 handed back"],
  ] as const)
    assert.equal(
      await post("lead", key, text),
      "held",
      "never into a running turn, however long it has run: a Lead cut into while it thinks or writes loses the thought",
    );
  assert.equal(await post("peer", "a", "t"), "held");
  outbox.turnStarted("stopped");
  assert.equal(await post("stopped", "a", "t"), "held", "stopped until the permission is decided");
  assert.deepEqual(
    [agents.lead, agents.peer, agents.stopped].flatMap((seat) => seat.sent),
    [],
  );
  agents.lead.status = "idle";
  outbox.turnEnded("lead");
  await outbox.pump("lead");
  assert.deepEqual(
    agents.lead.sent,
    ["L1-T1 handed back|L1-T2 handed back"],
    "its queue goes as one when the turn ends",
  );

  assert.equal(await post("quiet", "opened:L2", "lane opened", false), "held", "word that asks nothing waits");
  outbox.turnEnded("quiet");
  assert.equal((await outbox.pump("quiet")).size, 0, "a round does not send it on its own either");
  assert.deepEqual(agents.quiet.sent, []);
  assert.equal(await post("quiet", "ask:A1", "a question"), "sent");
  assert.deepEqual(agents.quiet.sent, ["lane opened|a question"], "it goes with the next letter that asks");

  const garbled = '[{ "to": "busy", "text": words from a letter }]';
  writeFileSync(file, garbled);
  await assert.rejects(post("busy", "late", "held for later"), (error: Error) => {
    assert.match(error.message, /outbox\.json is there but could not be read: it is not JSON/);
    assert.doesNotMatch(
      error.message,
      /words from a letter/,
      "a parser quotes the file, and whoever reads this is not",
    );
    return true;
  });
  assert.equal(readFileSync(file, "utf-8"), garbled, "the letters held in it are not written over by the next one");
});

test("a letter Paseo will not take is kept for the next try, and the post that wrote it does not fail", async (t) => {
  const said = reported(t);
  const agents = { lead: agent("idle") };
  const seats = fakeSeats(agents);
  let refusing = true;
  const outbox = new Outbox(
    join(tempDir(), "outbox.json"),
    (_seat, list) => list.map((letter) => letter.text).join("|"),
    {
      look: seats.look,
      async send(id, text, kinds, into) {
        if (refusing) throw new Error("the daemon did not accept the message");
        await seats.send(id, text, kinds, into);
      },
    },
  );
  assert.equal(await outbox.post({ to: "lead", key: "merged:L1-T1", text: "merged" }), "held");
  assert.equal(outbox.pending("lead").length, 1, "the tool call that posted it has already changed the ledger");
  assert.match(said(), /the daemon did not accept the message/);
  refusing = false;
  await outbox.pump("lead");
  assert.deepEqual(agents.lead.sent, ["merged"]);
  assert.deepEqual(outbox.pending("lead"), []);
});

test("a large queue drains in bounded batches, leaving a visible durable remainder for later boundaries", async () => {
  const agents = { lead: agent("running"), large: agent("running") };
  const outbox = new Outbox(
    join(tempDir(), "outbox.json"),
    (_seat, list, remaining) =>
      `${list.map((letter) => letter.text).join("|")}${remaining > 0 ? `|${remaining} more queued` : ""}`,
    fakeSeats(agents),
  );
  for (let at = 1; at <= 10; at++)
    assert.equal(await outbox.post({ to: "lead", key: `done:L1-T${at}`, text: `T${at}` }), "held");
  agents.lead.status = "idle";
  outbox.turnEnded("lead");
  assert.equal((await outbox.pump("lead")).size, 8);
  assert.equal(agents.lead.sent[0], "T1|T2|T3|T4|T5|T6|T7|T8|2 more queued");
  assert.equal(outbox.pending("lead").length, 2, "overflow stays on disk");
  outbox.turnEnded("lead");
  assert.equal((await outbox.pump("lead")).size, 2);
  assert.equal(agents.lead.sent[1], "T9|T10");

  for (const [key, text] of [
    ["done:L2-T1", "a".repeat(7000)],
    ["done:L2-T2", "b".repeat(7000)],
  ] as const)
    await outbox.post({ to: "large", key, text });
  assert.match((await outbox.take("large"))!, /a{7000}\|1 more queued$/);
  assert.equal(outbox.pending("large").length, 1, "the character budget also leaves overflow durable");
});

test("whoever waits on a letter hears when it reached its seat, not when it was posted", async () => {
  const agents = { watcher: agent("running") };
  const heard: { keys: string[]; at: number }[] = [];
  const outbox = new Outbox(
    join(tempDir(), "outbox.json"),
    (_seat, list) => list.map((letter) => letter.text).join("|"),
    fakeSeats(agents),
    { delivered: (letters, at) => heard.push({ keys: letters.map((letter) => letter.key), at }) },
  );
  assert.equal(await outbox.post({ to: "watcher", key: "case:C1", text: "one" }), "held");
  assert.equal(await outbox.post({ to: "watcher", key: "case:C2", text: "two" }), "held");
  assert.equal(heard.length, 0, "held is not delivered");
  agents.watcher.status = "idle";
  outbox.turnEnded("watcher");
  const before = Date.now();
  await outbox.pump("watcher");
  assert.deepEqual(
    heard.map((one) => one.keys),
    [["case:C1", "case:C2"]],
  );
  assert.ok(heard[0]!.at >= before, "stamped as it went");
});

test("a letter still held can be withdrawn, and one already taken cannot", async () => {
  const agents = { watcher: agent("running") };
  const outbox = new Outbox(
    join(tempDir(), "outbox.json"),
    (_seat, list) => list.map((letter) => letter.text).join("|"),
    fakeSeats(agents),
  );
  await outbox.post({ to: "watcher", key: "case:C1", text: "older look" });
  await outbox.post({ to: "watcher", key: "case:C2", text: "other subject" });
  assert.equal(await outbox.withdraw("watcher", "case:C1"), true);
  assert.equal(await outbox.withdraw("watcher", "case:C1"), false, "once");
  assert.equal(await outbox.withdraw("someone", "case:C2"), false, "only from the seat it was held for");
  agents.watcher.status = "idle";
  outbox.turnEnded("watcher");
  await outbox.pump("watcher");
  assert.deepEqual(agents.watcher.sent, ["other subject"]);
  assert.equal(await outbox.withdraw("watcher", "case:C2"), false, "a letter that went is not called back");
});

test("held mail rides the reply to a seat's own call, word that asks nothing included, but never past a hold", async () => {
  const agents = {
    sup: agent("running"),
    asking: agent("running", { pendingPermissions: [{ id: "p1" }] }),
    held: agent("running"),
  };
  const heard: string[] = [];
  const outbox = new Outbox(
    join(tempDir(), "outbox.json"),
    (_seat, list) => list.map((letter) => letter.text).join("|"),
    fakeSeats(agents),
    {
      holding: (seat) => seat.id === "held",
      delivered: (letters) => heard.push(...letters.map((letter) => letter.key)),
    },
  );
  await outbox.post({ to: "sup", key: "landed:L1", text: "LANDED L1", wakes: false });
  await outbox.post({ to: "sup", key: "ask:A1", text: "a question" });
  assert.equal(await outbox.take("sup"), "LANDED L1|a question");
  assert.deepEqual(outbox.pending("sup"), [], "taken once: its turn ending sends nothing more");
  assert.deepEqual(heard, ["landed:L1", "ask:A1"]);
  assert.equal(await outbox.take("sup"), undefined);
  for (const id of ["asking", "held"]) {
    await outbox.post({ to: id, key: "x", text: "t" });
    assert.equal(await outbox.take(id), undefined, `${id}: kept as the outbox keeps it`);
    assert.equal(outbox.pending(id).length, 1);
  }
});

test("mail for a seat that is gone is given up and said so: word that asks nothing once it is archived, the rest a day on, and all once Paseo no longer knows it", async () => {
  const hours = (count: number) => new Date(Date.now() - count * 3_600_000).toISOString();
  const agents: Record<string, FakeAgent> = {
    archived: agent("idle", { archivedAt: hours(2) }),
    long: agent("idle", { archivedAt: hours(25) }),
    asking: agent("idle", { pendingPermissions: [{ id: "p1" }] }),
  };
  const dropped: string[] = [];
  const outbox = new Outbox(
    join(tempDir(), "outbox.json"),
    (_seat, list) => list.map((letter) => letter.text).join("|"),
    fakeSeats(agents),
    { dropped: (letter, _at, why) => dropped.push(`${letter.to} ${letter.key}: ${why}`) },
  );
  const post = (to: string, key: string, wakes?: false) =>
    outbox.post({ to, key, text: key, ...(wakes === false ? { wakes } : {}) });
  await post("archived", "closed:L1", false);
  await post("archived", "ask:A1");
  await post("long", "ask:A2");
  await post("asking", "ask:A3");
  await post("deleted", "merge:L1-T1");
  const listed = new Set(["asking"]);

  await outbox.sweep(listed);
  assert.deepEqual(dropped.sort(), [
    "archived closed:L1: its seat is archived, and it asked nothing",
    "long ask:A2: its seat has been archived a day",
  ]);
  assert.deepEqual(
    outbox.letters().map((letter) => letter.key),
    ["ask:A1", "ask:A3", "merge:L1-T1"],
    "an archived seat may be started again that day; one on a permission is there",
  );
  await outbox.sweep(listed);
  await outbox.sweep(new Set());
  assert.equal(outbox.pending("deleted").length, 1, "a listing that could not show the rest proves nothing");
  await outbox.sweep(listed);
  assert.match(dropped.at(-1)!, /^deleted merge:L1-T1: Paseo no longer knows its seat$/);
  assert.equal(outbox.pending("asking").length, 1, "never a seat stopped on a permission");
});
