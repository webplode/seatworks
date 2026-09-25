import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../server/catalog/kit.ts";
import { asked, viewsOf } from "../../server/runtime/watch/jev/views.ts";
import { covered, loadCases } from "./cases.ts";

const kit = loadKit(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const shipped = Object.values(kit.sensors)[0]!;
const cases = loadCases();

test("every question the sensor asks has a turn that should make it read high and one that should not", () => {
  // A question shipped with a guessed threshold costs on every reading; this refuses it unmeasured, for free.
  const { high, low } = covered(cases);
  const missing = Object.keys(shipped.questions).flatMap((name) => [
    ...(high.has(name) ? [] : [`${name} has no case that should read high`]),
    ...(low.has(name) ? [] : [`${name} has no case that should read low`]),
  ]);
  assert.deepEqual(missing, []);
});

test("a case is a turn the sensor could really be sent, and names only questions that exist", () => {
  const known = new Set(Object.keys(shipped.questions));
  const ids = new Set<string>();
  for (const entry of cases) {
    assert.ok(entry.id && !ids.has(entry.id), `${entry.id} is named twice`);
    ids.add(entry.id);
    assert.ok(entry.why.trim(), `${entry.id} does not say what it is for`);
    assert.deepEqual(Object.keys(entry.brief).sort(), ["beside", "can", "context", "gates", "goal", "role", "workingCopy"], `${entry.id} has no brief a seat could have`);
    assert.deepEqual(Object.keys(entry.trail).filter((key) => key !== "final").sort(), ["from", "instruction", "lost", "steps"], `${entry.id} has no turn a seat could have`);
    assert.ok(entry.trail.steps.every((step, index) => step.id === `S${entry.trail.lost + index + 1}`), `${entry.id} numbers its steps as a turn does`);
    assert.ok(Object.keys(entry.expect).length > 0, `${entry.id} expects nothing`);
    for (const name of Object.keys(entry.expect)) assert.ok(known.has(name), `${entry.id} expects ${name}, which the sensor does not ask`);
  }
});

test("a case's turn is asked every question it expects read, and none it expects held", () => {
  // Free to check here, so a paid run never reads a held question as a miss or an asked one as held.
  for (const entry of cases) {
    const questions = asked(shipped.questions, viewsOf(entry.trail, entry.brief, shipped.stateChars), { can: entry.brief.can, from: entry.trail.from });
    for (const [name, want] of Object.entries(entry.expect)) assert.equal(name in questions, want !== "held", `${entry.id} ${want === "held" ? "asks" : "does not ask"} ${name}`);
  }
});

test("the turn that goes right is the floor, so every question has somewhere to be low", () => {
  const clean = cases.find((entry) => entry.id === "clean");
  assert.ok(clean, "a suite with no healthy turn measures only what firing looks like");
  const asked = Object.keys(shipped.questions);
  const quiet = asked.filter((name) => cases.some((entry) => entry.expect[name] === "low"));
  assert.equal(quiet.length, asked.length);
});
