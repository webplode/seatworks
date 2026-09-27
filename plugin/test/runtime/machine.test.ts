import assert from "node:assert/strict";
import { test } from "node:test";
import { projectOf } from "../../server/desk/project/project.ts";
import { repo } from "./harness.ts";
import { laneWith } from "./landable.ts";

const scope = { acceptance: ["a"], outOfScope: ["the rest"] };

test("a Peer measuring holds the machine: the desk's gates wait, and whoever asks reads the machine's real state and who holds it", async () => {
  const { h, lane, work } = await laneWith({ "a.txt": "one\n" });
  const lead = lane.lead!;
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "b", title: "Bench", goal: "measure", ...scope, holds: ["b.txt"], parallel: true }],
  });
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  const held = await h.call(peer, "peer", "machine", { hold: 10, why: "benchmark the parser" });
  assert.equal(held.ok, true, held.text);
  assert.match(
    held.text,
    /\d+ processors; load [\d.]+, [\d.]+, [\d.]+ over 1, 5 and 15 minutes; [\d.]+ GB of [\d.]+ GB free\./,
  );
  assert.match(
    held.text,
    /Held for measuring by the Peer on L1-T1 in [^ ]+ until \d\d:\d\d, for "benchmark the parser": no gate or setup starts meanwhile\./,
  );
  const refused = await h.call(lead, "lead", "machine", { hold: 5, why: "mine" });
  assert.equal(refused.ok, false, "one holder at a time");
  assert.match(refused.text, /held for measuring by the Peer on L1-T1/);

  work({ "a.txt": "two\n" });
  const reporting = h.call(lead, "lead", "report", { summary: "done", ready: true });
  const waits = async () => (await h.call(lead, "lead", "machine", {})).text.includes("1 waiting for the machine");
  for (let i = 0; i < 200 && !(await waits()); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(await waits(), "the lane's gate waits while the machine is held");
  const letGo = await h.call(peer, "peer", "machine", { hold: 0 });
  assert.equal(letGo.ok, true, letGo.text);
  assert.doesNotMatch(letGo.text, /Held for measuring/);
  assert.equal((await reporting).ok, true, "and runs once it is let go");
});

test("the Supervisor reads every project on the machine at a glance, beside the machine's own state", async () => {
  const { h, sup } = await laneWith({ "a.txt": "one\n" });
  const second = repo().root;
  const other = h.add("sw3-supervisor-claude/claude-opus-5", second, "sup-b");
  await h.call(other, "supervisor", "open_lane", { title: "Tax", outcome: "tax rounds", ...scope }, second);
  const across = await h.call(sup, "supervisor", "status", { across: true });
  assert.equal(across.ok, true, across.text);
  assert.match(across.text, new RegExp(`${h.project.slug}: 1 lane open \\(L1 Cart\\)`));
  assert.match(across.text, new RegExp(`${projectOf(second).slug}: 1 lane open \\(L1 Tax\\)`));
  assert.match(across.text, /\d+ processors; load/);
});
