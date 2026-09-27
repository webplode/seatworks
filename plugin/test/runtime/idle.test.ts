import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

test("an idle Lead with nothing running, asked or reported ready wakes whoever supervises, and one waiting on it or on the Human does not", async () => {
  const h = harness();
  h.projectSettings({ hitl: { on: true } });
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  const scope = { outcome: "x", acceptance: ["a"], outOfScope: ["the rest"] };
  await h.call(sup, "supervisor", "set_project", { askFirst: ["b.txt"] });
  for (const [title, isolate] of [
    ["Quiet", false],
    ["Held", true],
    ["Ready", true],
    ["Parked", true],
    ["Detoured", true],
  ] as const)
    await h.call(sup, "supervisor", "open_lane", { title, ...scope, isolate });
  await h.call(sup, "supervisor", "open_lane", { title: "Clearing", ...scope, isolate: true, detourOf: "L5" });
  const lanes = h.ledger().lanes;
  await h.call(sup, "supervisor", "hold_lane", { lane: "L2", reason: "the Human is reading it" });
  await h.call(lanes.L3!.lead!, "lead", "report", { summary: "done", ready: true });
  h.commit(lanes.L4!.worktree!, "b.txt", "bee, changed\n");
  await h.call(lanes.L4!.lead!, "lead", "report", { summary: "done", ready: true });
  assert.match((await h.call(sup, "supervisor", "land_lane", { lane: "L4" })).text, /waits for the Human's approval/);
  await h.call(sup, "supervisor", "amend_lane", { lane: "L4", acceptance: ["a", "b"], why: "the Human added b" });
  for (const lane of Object.values(lanes)) h.agents.get(lane.lead!)!.status = "idle";
  await h.tick(Date.now() + 20 * 60_000);
  const said = h.heard(sup).join("\n");
  assert.match(
    said,
    /INCIDENT I1 \(lane-idle, attend\) on the Lead of L1 \(Quiet\)[^]*What was seen: idle \d+ minutes with no running task, no open ask and no report of it ready; its last words: [^]*\nNext: Nothing, if /,
    "whether to step in is whoever supervises' own call",
  );
  assert.doesNotMatch(
    said,
    /lane-idle, attend\) on the Lead of L[2345]/,
    "a Lead told to wait, or waiting on whoever lands it, on the Human or on a lane clearing its way, is not idle",
  );
  assert.doesNotMatch(h.heard(lanes.L1!.lead!).join("\n"), /INCIDENT/, "never to the Lead it is about");
});
