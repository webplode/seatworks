import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { digestOf } from "../../server/desk/checkpoints.ts";
import type { Project } from "../../server/desk/project.ts";
import { tempDir } from "../tempdir.ts";

const DAY = 86_400_000;
const now = Date.parse("2026-09-23T12:00:00.000Z");

/** A project whose checkpoints.log holds `runs`, each `[days ago, decision, finding, waitedMs?]`. */
function logged(runs: [number, string, string?, number?][], checkpoint = "land"): Project {
  const project: Project = { root: "/work/shop", slug: "shop", state: tempDir("sw2-digest-") };
  const lines = runs.map(([ago, decision, finding, waitedMs]) =>
    JSON.stringify({ at: new Date(now - ago * DAY).toISOString(), checkpoint, mode: "shadow", lane: "L1", by: "sup", decision, findings: finding ? [finding] : [], ...(waitedMs === undefined ? {} : { waitedMs }) }),
  );
  writeFileSync(join(project.state, "checkpoints.log"), `${lines.join("\n")}\nnot json\n`);
  return project;
}

test("a shadow check says when it has run enough to be judged, what turning it on would have stopped, and the latest reasons to judge it by", () => {
  const few = digestOf(logged(Array.from({ length: 12 }, () => [1, "pass"] as [number, string])), "land", "shadow", now);
  assert.deepEqual(few, { lines: ["Not enough yet to judge: 12 of the 30 runs it takes."], state: undefined });

  const runs: [number, string, string?][] = Array.from({ length: 30 }, (_, index) => [10 - index / 3, "pass"]);
  for (const [index, reason] of ["a is risky.", "b is risky.", "c is deleted.", "d is risky.", "e is risky."].entries()) runs[index * 6] = [10 - index * 2, "ask", reason];
  const enough = digestOf(logged(runs), "land", "shadow", now);
  assert.equal(enough.state, "ready");
  assert.deepEqual(enough.lines, [
    "Turned on, it would have stopped work 5 times in 30 runs over 10 days (0.5 a day).",
    "The latest it would have stopped: L1: e is risky. L1: d is risky. L1: c is deleted. If most of those deserved a look, it is ready to turn on.",
  ]);

  const noisy = digestOf(logged(Array.from({ length: 30 }, (_, index) => [(29 - index) / 10, "ask", `f${index} is risky.`])), "land", "shadow", now);
  assert.equal(noisy.state, undefined, "stopping work more than twice a day is too often to turn on as it is");
  assert.match(noisy.lines.join("\n"), /30 times in 30 runs over 3 days \(10 a day\)[^]*more than twice a day: narrow what it stops/);
});

test("a check that is on shows how its holds were decided, and one approved every time for twenty in a row may be adding nothing", () => {
  const decided = digestOf(logged([[3, "ask"], [3, "approved", undefined, 4 * 60_000], [2, "ask"], [2, "sent back", "tests first", 6_000], [1, "ask"], [1, "approved", undefined, 20 * 60_000]]), "land", "on", now);
  assert.deepEqual(decided, { lines: ["3 decided: 2 approved, 1 sent back; a median wait of 4 min; 1 decided within 10 seconds of being held."], state: undefined });

  const runs: [number, string, string?, number?][] = [[30, "sent back", "no", 60_000]];
  for (let index = 0; index < 20; index++) runs.push([20 - index, "approved", undefined, 3_000]);
  const stamped = digestOf(logged(runs), "land", "on", now);
  assert.equal(stamped.state, "stamped");
  assert.deepEqual(stamped.lines, [
    "21 decided: 20 approved, 1 sent back; a median wait of 0 min; 20 decided within 10 seconds of being held.",
    "The last 20 were all approved, so it likely sends back fewer than 15% (3 in 20) of what it holds: it may be adding nothing. Hold less, or move it back to shadow.",
  ]);
  assert.deepEqual(digestOf(logged(runs, "plan"), "land", "on", now).lines, ["Nothing decided yet."], "one check's log is not another's");
});
