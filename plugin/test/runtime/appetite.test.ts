import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

test("a lane that spends past what it was worth sends whoever supervises to the Human, in the loop or out of it", async () => {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const opened = await h.call(sup, "supervisor", "open_lane", {
    title: "Brakes",
    outcome: "the bike stops",
    acceptance: ["stops in 5 m"],
    appetite: "$3",
  });
  assert.equal(opened.ok, true, opened.text);
  const lead = h.ledger().lanes.L1!.lead!;
  Object.assign(h.agents.get(lead)!, { lastUsage: { totalCostUsd: 2 } });
  await h.tick();
  await h.idle(sup);
  assert.doesNotMatch(h.heard(sup).join("\n"), /PAST ITS APPETITE/);
  Object.assign(h.agents.get(lead)!, { lastUsage: { totalCostUsd: 3.5 } });
  await h.tick();
  await h.tick();
  await h.idle(sup);
  const heard = h.heard(sup).join("\n");
  assert.match(heard, /PAST ITS APPETITE L1 \(Brakes\): its seats spent \$3\.50 of the \$3\.00 it was worth\./);
  assert.match(heard, /Next: What it costs is the Human's to agree, in the loop or out of it/);
  assert.equal(heard.match(/^PAST ITS APPETITE/gm)!.length, 1, "told once, not on every round");

  const out = await h.call(sup, "supervisor", "ask_human", {
    question: "Spend $5 more on the brakes?",
    why: "past the appetite",
    options: [
      { label: "Go on", effect: "the lane spends up to $8" },
      { label: "Stop", effect: "the lane is dropped" },
    ],
    recommend: "Go on",
    reason: "nearly done",
    ifSilent: "the lane waits",
    class: "costly",
  });
  assert.equal(out.ok, false);
  assert.match(
    out.text,
    /what a lane is for or what it costs past what they agreed/,
    "out of the loop, they are asked directly",
  );
});
