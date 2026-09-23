import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { STATE_VERSION } from "../../server/core/state.ts";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHAPES = join(PLUGIN, "test", "fixtures", "state", "shapes.json");

const KEPT: [string, string[]][] = [
  ["server/desk/ledger.ts", ["LaneStatus", "TaskStatus", "AskKind", "Lane", "Handback", "Task", "Ask", "Releasing", "Restoring", "Slot", "AgentRef", "Ledger"]],
  ["server/desk/incidents.ts", ["Held", "Judged", "Incident", "Incidents"]],
  ["server/desk/project.ts", ["GateOn", "ProjectConfig"]],
  ["server/runtime/outbox.ts", ["LetterSchema", "Letter"]],
  ["shared/supervision.ts", ["Operation", "Association", "ScopeProject", "Binding", "Dependency"]],
  ["server/runtime/watch/jev/communication.ts", ["Budget"]],
  ["server/upkeep/content.ts", ["Taken"]],
  ["server/catalog/settings.ts", ["Scalar", "RoleChoice", "Connect", "McpChoice", "Pattern", "AttentionChoice", "FlowChoice", "shared", "SensorChoice", "ProjectLayerSchema", "MachineLayerSchema"]],
];

const bare = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** One `type` or `const` declaration, up to the semicolon that ends it at the top level. */
function declaration(source: string, file: string, name: string): string {
  const start = new RegExp(`^(?:export )?(?:type|const) ${name}\\b`, "m").exec(source)?.index;
  assert.ok(start !== undefined, `${file} no longer declares ${name}; update the list in this test along with STATE_VERSION`);
  let depth = 0;
  for (let at = start; at < source.length; at++) {
    const char = source[at]!;
    if ("{([".includes(char)) depth++;
    else if ("})]".includes(char)) depth--;
    else if (char === ";" && depth === 0) return bare(source.slice(start, at + 1));
  }
  throw new Error(`${name} in ${file} does not end`);
}

function shape(): string {
  const hash = createHash("sha256");
  for (const [file, names] of KEPT) {
    const source = readFileSync(join(PLUGIN, file), "utf-8");
    for (const name of names) hash.update(`${file}#${declaration(source, file, name)}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

test("the shape of every kept file is the one recorded for this STATE_VERSION", () => {
  const recorded = JSON.parse(readFileSync(SHAPES, "utf-8")) as Record<string, string>;
  const now = shape();
  assert.ok(Object.keys(recorded).every((version) => Number(version) <= STATE_VERSION), "shapes.json records a state newer than STATE_VERSION");
  assert.equal(
    recorded[String(STATE_VERSION)],
    now,
    [
      `The shape of a kept file changed (now ${now}), and STATE_VERSION is still ${STATE_VERSION}.`,
      `Raise STATE_VERSION in server/core/state.ts to ${STATE_VERSION + 1}, add a step to it in server/upkeep/state.ts,`,
      `add test/fixtures/state/v${STATE_VERSION + 1} in the new format, and record "${STATE_VERSION + 1}": "${now}" in test/fixtures/state/shapes.json.`,
      "The shape recorded for an earlier state is never changed.",
    ].join("\n"),
  );
});
