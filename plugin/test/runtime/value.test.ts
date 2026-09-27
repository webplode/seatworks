import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

const scope = { acceptance: ["a"], outOfScope: ["the rest"] };

test("the Report weighs each mechanism by what it changed: reviews that changed the work, challenges that changed the plan, asks sent up by kind", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Rounding", outcome: "money rounds", ...scope });
  const lane = h.ledger().lanes.L1!;
  const lead = lane.lead!;
  await h.call(lead, "lead", "add_tasks", {
    tasks: [{ key: "t", title: "Round", goal: "g", ...scope, hints: ["a.txt"] }],
  });
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  const handBack = async (text: string) => {
    h.commit(lane.worktree!, "a.txt", text);
    await h.call(peer, "peer", "done", { outcome: "complete", summary: "rounded" });
    await h.idle(peer);
  };
  const review = async (verdict: string, findings: unknown[]) => {
    const started = await h.call(lead, "lead", "start_review", { task: "L1-T1", focus: "Is it right?" });
    assert.equal(started.ok, true, started.text);
    const id = Object.values(h.ledger().tasks)
      .filter((task) => task.kind === "review")
      .at(-1)!;
    const done = await h.call(id.peer!, "reviewer", "done", { verdict, answer: "read it", findings });
    assert.equal(done.ok, true, done.text);
  };
  await handBack("half down\n");
  await review("changes", [{ severity: "P1", where: "a.txt:1", failure: "rounds half down", fix: "round half up" }]);
  assert.equal((await h.call(lead, "lead", "rework", { task: "L1-T1", text: "round half up" })).ok, true);
  await handBack("half up\n");
  await review("accept", []);

  await h.call(peer, "peer", "ask", {
    question: "Banker's rounding?",
    disputes: "half up",
    tried: "the ledger rounds to even",
  });
  const challenge = Object.values(h.ledger().asks).at(-1)!.id;
  await h.call(lead, "lead", "answer", {
    ask: challenge,
    text: "Round to even.",
    why: "the ledger does",
    verdict: "changes",
  });
  for (const text of ["a key for the tax API", "a key for the rates API"])
    await h.call(lead, "lead", "ask", { kind: "need", text, default: "stub nothing, wait" });

  const numbers = Object.fromEntries((await h.report()).numbers.map((row) => [row.title, [row.value, row.detail]]));
  assert.deepEqual(numbers["Reviews"], ["1 of 2 changed the work", "Reviewer: 1 of 2"]);
  assert.deepEqual(numbers["Challenges"], [
    "1 of 1 changed the plan",
    "0 kept as another sound option · 0 as not worth stopping for",
  ]);
  assert.deepEqual(numbers["Asks sent up"], ["2", "need 2"]);
});
