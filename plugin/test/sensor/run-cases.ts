// npm run eval:sensor [-- --runs 3] [--case agreed-fires] [--question injected_intent]
// Not part of npm test: every case costs a real reading; the key comes from the machine settings layer.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadKit } from "../../server/catalog/kit.ts";
import { stateRoot } from "../../server/core/paths.ts";
import { assessViews } from "../../server/runtime/watch/jev/sensor.ts";
import { viewsOf } from "../../server/runtime/watch/jev/views.ts";
import { barOf, loadCases, median, right } from "./cases.ts";

const { values } = parseArgs({ options: { runs: { type: "string", default: "3" }, case: { type: "string" }, question: { type: "string" } } });
const runs = Number(values.runs);

const kit = loadKit(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const spec = Object.values(kit.sensors)[0]!;
const key = (JSON.parse(readFileSync(join(stateRoot(), "settings.json"), "utf-8")) as { sensor?: { key?: string } }).sensor?.key;
if (!key) {
  console.error("No sensor key in the machine settings. Set one under Watch on Machine defaults first.");
  process.exit(2);
}

const cases = loadCases().filter((entry) => !values.case || entry.id === values.case);
let wrong = 0;
let spent = 0;

for (const entry of cases) {
  const views = viewsOf(entry.trail, entry.brief, spec.stateChars);
  const answers: Record<string, number[]> = {};
  for (let run = 0; run < runs; run++) {
    const asking = await assessViews(spec, key, views, { can: entry.brief.can, from: entry.trail.from }, `eval:${entry.id}:${run}`);
    if (!asking) break;
    spent += asking.assessment.cost ?? 0;
    for (const [name, p] of Object.entries(asking.assessment.answers)) (answers[name] ??= []).push(p);
  }
  const said: string[] = [];
  for (const [name, want] of Object.entries(entry.expect)) {
    if (values.question && values.question !== name) continue;
    const read = answers[name];
    if (want === "held" || !read) {
      const ok = want === "held" && !read;
      if (!ok) wrong += 1;
      said.push(`  ${ok ? "✓" : "✗"} ${name} ${read ? `asked, ${median(read).toFixed(2)}` : "held back, so nothing was asked"} (wanted ${want})`);
      continue;
    }
    const answer = median(read);
    const ok = right(answer, want, barOf(spec.questions[name]));
    if (!ok) wrong += 1;
    said.push(`  ${ok ? "✓" : "✗"} ${name} ${answer.toFixed(2)} (wanted ${want})`);
  }
  if (said.length === 0) continue;
  console.log(`${entry.id} — ${entry.why}`);
  for (const line of said) console.log(line);
}

console.log(`\n${cases.length} turns × ${runs} readings, $${spent.toFixed(5)}. ${wrong === 0 ? "Every question read its turns the way the cases say." : `${wrong} read the wrong way.`}`);
process.exit(wrong === 0 ? 0 : 1);
