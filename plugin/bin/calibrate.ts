import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Question, type SensorSpec, loadKit } from "../server/catalog/kit.ts";
import { DAY_MS, type Judged, loadIncidents } from "../server/desk/incidents.ts";
import { WATCHER_JUDGED } from "../server/desk/notice.ts";
import { type Project, projectOf } from "../server/desk/project.ts";
import { TeamSource } from "../server/runtime/team-source.ts";
import { type Kept, assessmentsDir, readAssessments } from "../server/runtime/watch/jev/assessments.ts";
import { type Fact, FACT_LEVELS } from "../server/runtime/watch/facts.ts";
import { weigh } from "../server/runtime/watch/jev/rules.ts";
import { assessViews } from "../server/runtime/watch/jev/sensor.ts";
import type { Step } from "../server/runtime/watch/trail.ts";
import { stepText } from "../server/runtime/watch/trail.ts";

export type Label = { id: string; seat: string; kind: string; opened: number; last: number; closed?: number; sensor?: Judged; by?: "watcher"; label: "useful" | "noise" };

type Fetcher = Parameters<typeof assessViews>[5];
type Answers = (record: Kept) => Record<string, number> | undefined;

const ENOUGH = 5;
const USAGE = `usage: node bin/calibrate.ts <project directory or its state directory> [--ask] [--limit N] [--per-day N] [--model ID]
       node bin/calibrate.ts <project> --sample N
       node bin/calibrate.ts <project> [--missed ID]... [--fine ID]...

Reads the assessments the watch kept and the useful/noise marks on incidents, and reports for each
question how well its answers separate the two (AUROC), how often it would fire, and the threshold
that keeps it within the daily budget, then how precise the incidents were in the end. --ask asks the
questions in catalog/sensor again against the kept states first (it costs one call per assessment).
--limit keeps the newest N assessments (a whole number above 0); --per-day replaces the budget in the
settings (a whole number); --model keeps only what that model version answered.

--sample N shows N turns the watch did not flag, picked at random, for you to read; mark each one
--missed ID if something there should have been raised, or --fine ID if not. The report then says how
much the watch misses.`;

const SPOT_CHECKS = "spot-checks.jsonl";

const judged = (value: unknown): Judged | undefined => {
  const held = value as Judged | null | undefined;
  return held && typeof held.question === "string" && typeof held.p === "number" && ["confirms", "vetoes", "unclear"].includes(held.says) ? held : undefined;
};

export function labelsIn(state: string): Label[] {
  const found = new Map<string, Label>();
  const log = join(state, "events.log");
  if (existsSync(log)) {
    for (const row of readFileSync(log, "utf-8").split("\n")) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(row) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.kind !== "incident.ack" || (event.verdict !== "useful" && event.verdict !== "noise")) continue;
      if (typeof event.id !== "string" || typeof event.seat !== "string" || typeof event.finding !== "string" || typeof event.opened !== "number" || typeof event.last !== "number") continue;
      const closed = typeof event.at === "string" ? Date.parse(event.at) : Number.NaN;
      const sensor = judged(event.sensor);
      found.set(`${event.id}:${event.opened}`, {
        id: event.id,
        seat: event.seat,
        kind: event.finding,
        opened: event.opened,
        last: event.last,
        ...(Number.isFinite(closed) ? { closed } : {}),
        ...(sensor ? { sensor } : {}),
        ...(event.by === "watcher" ? { by: "watcher" as const } : {}),
        label: event.verdict,
      });
    }
  }
  for (const item of Object.values(loadIncidents(state).items)) {
    if (item.label !== "useful" && item.label !== "noise") continue;
    const sensor = judged(item.sensor);
    found.set(`${item.id}:${item.opened}`, {
      id: item.id,
      seat: item.seat,
      kind: item.kind,
      opened: item.opened,
      last: item.last,
      ...(item.closed !== undefined ? { closed: item.closed } : {}),
      ...(sensor ? { sensor } : {}),
      ...(item.by ? { by: item.by } : {}),
      label: item.label,
    });
  }
  return [...found.values()];
}

export function auroc(positives: number[], negatives: number[]): number | undefined {
  if (positives.length === 0 || negatives.length === 0) return undefined;
  let wins = 0;
  for (const positive of positives) for (const negative of negatives) wins += positive > negative ? 1 : positive === negative ? 0.5 : 0;
  return wins / (positives.length * negatives.length);
}

export function peak(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let most = 0;
  for (let from = 0, to = 0; to < sorted.length; to++) {
    while (sorted[to]! - sorted[from]! >= DAY_MS) from += 1;
    most = Math.max(most, to - from + 1);
  }
  return most;
}

async function reask(kept: Kept[], spec: SensorSpec, key: string, fetcher?: Fetcher): Promise<{ answers: Map<Kept, Record<string, number>>; failed: number; cost: number; models: Map<string, number> }> {
  const answers = new Map<Kept, Record<string, number>>();
  const models = new Map<string, number>();
  let failed = 0;
  let cost = 0;
  let next = 0;
  const work = async () => {
    while (next < kept.length) {
      const record = kept[next++]!;
      try {
        // A record kept before its turn was does not say what its seat could do or who sent its instruction, so a question asked only of some is not asked of it again.
        const asking = await assessViews(spec, key, record.views, record.turn ?? { can: [], from: [] }, `replay:${record.seat}`, fetcher);
        if (!asking) continue;
        const { assessment } = asking;
        answers.set(record, assessment.answers);
        models.set(assessment.model, (models.get(assessment.model) ?? 0) + 1);
        cost += assessment.cost ?? 0;
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, work));
  return { answers, failed, cost, models };
}

const turnOf = (record: Kept) => `${record.seat}\n${record.turnId ?? ""}`;
const idOf = (record: Kept) => `${record.seat}@${record.askedAt}`;
const fixed = (value: number | undefined) => (value === undefined ? "–" : value.toFixed(2));
const share = (part: number, whole: number) => (whole === 0 ? "–" : (part / whole).toFixed(2));
const CANDIDATES = Array.from({ length: 101 }, (_, index) => index / 100);

function fired(kept: Kept[], name: string, question: Question, answers: Answers, threshold: number, unclear: number): { at: number; level: "page" | "attend" }[] {
  const first = new Map<string, { at: number; level: "page" | "attend" }>();
  const previous = new Map<string, Record<string, number>>();
  for (const record of kept) {
    const all = answers(record);
    if (!all) continue;
    const before = previous.get(turnOf(record));
    previous.set(turnOf(record), all);
    const p = all[name];
    if (p === undefined || first.has(turnOf(record))) continue;
    const again = before?.[name];
    const { findings } = weigh({ answers: { [name]: p }, model: record.model }, { [name]: { ...question, threshold } }, record.facts as Fact[], { unclear, ended: !record.running, ...(again === undefined ? {} : { before: { [name]: again } }) });
    const found = findings.find((finding) => finding.kind === name);
    if (found) first.set(turnOf(record), { at: record.at, level: found.level });
  }
  return [...first.values()].sort((a, b) => a.at - b.at);
}

function precision(scored: { label: Label["label"]; p: number }[], threshold: number): string {
  const hit = scored.filter((item) => item.p >= Math.round(threshold * 1e9) / 1e9);
  if (hit.length === 0) return "none of the marked ones fire";
  return `${share(hit.filter((item) => item.label === "useful").length, hit.length)} of ${hit.length} marked`;
}

function verdictLine(useful: number, noise: number, judgedAuroc: number | undefined, again: boolean, what: string): string {
  if (useful < ENOUGH || noise < ENOUGH) return `  → not enough marks${again ? " answered again" : ""} to judge (${ENOUGH} of each are needed)`;
  return judgedAuroc! < 0.55 ? `  → ${what}: its answers barely separate useful from noise` : "  → keep";
}

type Scored = { label: Label["label"]; p: number; again?: number };

function separation(scored: Scored[], replayed: boolean): { useful: Scored[]; noise: Scored[]; usefulAgain: Scored[]; noiseAgain: Scored[]; asKept?: number; asAsked?: number } {
  const useful = scored.filter((item) => item.label === "useful");
  const noise = scored.filter((item) => item.label === "noise");
  const usefulAgain = useful.filter((item) => item.again !== undefined);
  const noiseAgain = noise.filter((item) => item.again !== undefined);
  return {
    useful,
    noise,
    usefulAgain,
    noiseAgain,
    asKept: auroc(useful.map((item) => item.p), noise.map((item) => item.p)),
    asAsked: replayed ? auroc(usefulAgain.map((item) => item.again!), noiseAgain.map((item) => item.again!)) : undefined,
  };
}

const sameQuestion = (record: Kept, name: string, question: Question) => {
  const kept = record.questions[name];
  return kept !== undefined && kept.instructions === question.instructions && JSON.stringify(kept.criteria ?? null) === JSON.stringify(question.criteria ?? null);
};

function effective(kept: Kept[], during: Kept[], name: string, question: Question, answers: Answers): number | undefined {
  const scores = during.flatMap((record) => {
    const p = answers(record)?.[name];
    if (p === undefined) return [];
    if (!question.alone || question.level !== "attend" || !record.running) return [p];
    const before = kept.filter((other) => other.seat === record.seat && other.turnId === record.turnId && other.askedAt < record.askedAt).at(-1);
    const again = before ? answers(before)?.[name] : undefined;
    return again === undefined ? [] : [Math.min(p, again)];
  });
  return scores.length > 0 ? Math.max(...scores) : undefined;
}

export type CalibrateOptions = { state: string; kit?: ReturnType<typeof loadKit>; project?: Project; ask?: boolean; limit?: number; perDay?: number; model?: string; fetcher?: Fetcher };

export async function calibrate(options: CalibrateOptions): Promise<string> {
  const kit = options.kit ?? loadKit(join(dirname(fileURLToPath(import.meta.url)), ".."));
  const project = options.project ?? { root: "", slug: basename(options.state), state: options.state };
  const team = new TeamSource(kit).teamFor(project);
  const spec = team.sensor?.spec ?? Object.values(kit.sensors)[0];
  if (!spec) return "The kit ships no sensor, so there is nothing to calibrate.";
  const read = readAssessments(options.state);
  const chosen = options.model ? read.kept.filter((record) => record.model === options.model) : read.kept;
  const kept = options.limit !== undefined ? chosen.slice(-options.limit) : chosen;
  const out: string[] = [];
  if (kept.length === 0) return `No assessments are kept under ${assessmentsDir(options.state)}${options.model ? ` from ${options.model}` : ""} yet. They are written once a sensor key is set and the watch has assessed a seat.`;
  const perDay = options.perDay ?? team.attention.incidentsPerDay;
  const unclear = spec.unclear;
  const seen = new Map<string, number>();
  for (const record of kept) seen.set(record.model, (seen.get(record.model) ?? 0) + 1);
  out.push(`${kept.length} assessments over ${((kept.at(-1)!.at - kept[0]!.at) / DAY_MS).toFixed(1)} days${read.broken > 0 ? `, ${read.broken} unreadable and skipped` : ""}; answered by ${[...seen].map(([model, count]) => `${model} (${count})`).join(", ")}`);
  if (seen.size > 1) out.push("More than one model version answered, and a threshold tuned on one does not carry to another: pass --model with the one in use.");
  let replayed: Map<Kept, Record<string, number>> | undefined;
  let failedAgain = 0;
  if (options.ask) {
    if (!team.sensor) return "--ask needs the sensor key in the machine settings (sensor.key).";
    const again = await reask(kept, spec, team.sensor.key, options.fetcher);
    replayed = again.answers;
    failedAgain = again.failed;
    out.push(`asked again: ${again.answers.size} answered, ${again.failed} failed, cost ${again.cost.toFixed(6)}; answered by ${[...again.models].map(([model, count]) => `${model} (${count})`).join(", ") || "nobody"}`);
  }
  out.push(`A question fires at most once per turn. Every count below is its busiest 24 hours, the window the day's budget of ${perDay} is spent over, and only attention counts against it.`);
  const narrowed = options.limit !== undefined || options.model !== undefined;
  const from = kept[0]!.askedAt;
  const to = kept.at(-1)!.at;
  const labels = labelsIn(options.state).filter((label) => !narrowed || (label.opened >= from && label.opened <= to && (!options.model || !label.sensor || label.sensor.model === options.model)));
  if (narrowed) out.push("Only incidents opened while these assessments were kept are counted, and none the sensor judged under another model.");
  const stored: Answers = (record) => Object.fromEntries(Object.entries(record.answers).filter(([name]) => spec.questions[name] && sameQuestion(record, name, spec.questions[name])));
  const again: Answers = (record) => replayed?.get(record);
  const now: number[] = [];
  const suggested: number[] = [];
  for (const [name, question] of Object.entries(spec.questions)) {
    const answered = kept.filter((record) => stored(record)?.[name] !== undefined).length;
    const earlier = kept.filter((record) => record.answers[name] !== undefined).length - answered;
    const answeredAgain = replayed ? [...replayed.values()].filter((answers) => answers[name] !== undefined).length : 0;
    const threshold = question.threshold;
    const ties = [question.alone ? `alone, ${question.level}` : "", question.agrees ? `with ${question.agrees.join("/")}, ${question.level}` : "", question.confirms ? `confirms ${question.confirms.join("/")}` : ""].filter(Boolean).join("; ");
    out.push("");
    out.push(`${name}${threshold === undefined ? " (label-only)" : ` (${ties}; at ${fixed(threshold)}, unsure from ${fixed(threshold - unclear)})`}`);
    out.push(`  answered ${answered} times as kept${earlier > 0 ? ` (and ${earlier} times to an earlier wording, which is left out: --ask asks those again)` : ""}${replayed ? `, ${answeredAgain} times asked again` : ""}`);
    if (threshold === undefined) continue;
    if (question.level && answered + answeredAgain > 0) {
      const scored: Scored[] = [];
      let unmatched = 0;
      // A Watcher raises under the same names, and what it raised says nothing of how this question reads.
      for (const label of labels.filter((item) => item.kind === name && item.by !== "watcher")) {
        const during = kept.filter((record) => record.seat === label.seat && record.found.includes(name) && record.at >= label.opened - 1000 && record.at <= label.last);
        const p = effective(kept, during, name, question, stored);
        if (p === undefined) {
          unmatched += 1;
          continue;
        }
        const later = replayed ? effective(kept, during, name, question, again) : undefined;
        scored.push({ label: label.label, p, ...(later !== undefined ? { again: later } : {}) });
      }
      const split = separation(scored, Boolean(replayed));
      out.push(`  its own incidents, marked: ${split.useful.length} useful, ${split.noise.length} noise${unmatched > 0 ? ` (${unmatched} more have no kept assessment)` : ""}`);
      out.push(`  AUROC as kept: ${fixed(split.asKept)}${replayed ? `; asked again: ${fixed(split.asAsked)} (${split.usefulAgain.length} useful, ${split.noiseAgain.length} noise answered)` : ""}`);
      const at = fired(kept, name, question, stored, threshold, unclear);
      const attention = at.filter((item) => item.level === "attend").map((item) => item.at);
      const pages = at.length - attention.length;
      out.push(`  at ${fixed(threshold)}: fires on ${at.length} turns${pages > 0 ? ` (${pages} as page)` : ""}, at most ${peak(attention)} attention in 24 hours; precision ${precision(scored, threshold)}`);
      now.push(...attention);
      if (question.level === "attend") {
        const peakAt = (candidate: number, answers: Answers) => peak(fired(kept, name, question, answers, candidate, unclear).map((item) => item.at));
        const within = CANDIDATES.find((candidate) => peakAt(candidate, stored) <= perDay);
        if (within === undefined) {
          out.push(`  no threshold keeps it within ${perDay} in 24 hours`);
          suggested.push(...attention);
        } else {
          suggested.push(...fired(kept, name, question, stored, within, unclear).map((item) => item.at));
          out.push(`  most sensitive threshold within ${perDay} in 24 hours, were it the only thing firing: ${fixed(within)} (at most ${peakAt(within, stored)}; precision ${precision(scored, within)})`);
        }
        if (replayed) {
          const withinAgain = CANDIDATES.find((candidate) => peakAt(candidate, again) <= perDay);
          out.push(failedAgain > 0 ? `  asked again: not computed, since ${failedAgain} assessments could not be asked again` : `  asked again, the same: ${withinAgain === undefined ? "no threshold" : fixed(withinAgain)}`);
        }
      } else suggested.push(...attention);
      const [useful, noise, judgedAuroc] = replayed ? [split.usefulAgain.length, split.noiseAgain.length, split.asAsked] : [split.useful.length, split.noise.length, split.asKept];
      out.push(verdictLine(useful, noise, judgedAuroc, Boolean(replayed), "make it label-only"));
    }
    if (question.confirms) {
      const scored: Scored[] = [];
      let unjudged = 0;
      for (const label of labels.filter((item) => question.confirms!.includes(item.kind))) {
        if (label.sensor?.question !== name) {
          unjudged += 1;
          continue;
        }
        const judging = kept.filter((record) => record.seat === label.seat && record.verdicts.some((verdict) => verdict.kind === label.kind && verdict.question === name) && record.at >= label.opened - 1000 && record.at <= (label.closed ?? Number.POSITIVE_INFINITY));
        const later = judging.map((record) => replayed?.get(record)?.[name]).filter((p): p is number => p !== undefined);
        scored.push({ label: label.label, p: label.sensor.p, ...(later.length > 0 ? { again: later.at(-1)! } : {}) });
      }
      const split = separation(scored, Boolean(replayed));
      out.push(`  ${question.confirms.join("/")} incidents it judged, marked: ${split.useful.length} useful, ${split.noise.length} noise${unjudged > 0 ? ` (${unjudged} more were marked with no verdict from it)` : ""}`);
      out.push(`  AUROC as kept: ${fixed(split.asKept)}${replayed ? `; asked again: ${fixed(split.asAsked)} (${split.usefulAgain.length} useful, ${split.noiseAgain.length} noise answered)` : ""}`);
      const tally = (from: number, to: number) => {
        const within = scored.filter((item) => item.p >= from && item.p < to);
        return `${within.filter((item) => item.label === "useful").length} useful, ${within.filter((item) => item.label === "noise").length} noise`;
      };
      out.push(`  it confirmed ${tally(threshold, 2)}; was unsure of ${tally(threshold - unclear, threshold)}; held back ${tally(-1, threshold - unclear)}`);
      const [useful, noise, judgedAuroc] = replayed ? [split.usefulAgain.length, split.noiseAgain.length, split.asAsked] : [split.useful.length, split.noise.length, split.asKept];
      out.push(verdictLine(useful, noise, judgedAuroc, Boolean(replayed), "stop it holding incidents back"));
    }
  }
  const opened = factOpens(options.state).filter((time) => !narrowed || (time >= from && time <= to));
  out.push("");
  out.push(`together, with the ${opened.length} attention incidents code facts opened and the sensor did not hold back: at most ${peak([...now, ...opened])} in 24 hours at the thresholds set, ${peak([...suggested, ...opened])} at the ones suggested above; the budget is ${perDay}`);
  out.push("", ...finalIncidents(labels));
  out.push("", ...spotChecked(options.state, options.model ? read.kept.filter((record) => record.model === options.model) : read.kept));
  out.push("");
  out.push("Every mark comes from an incident that was raised, so AUROC here ranks within what already crossed a threshold; only the spot checks say anything of what was never raised.");
  return out.join("\n");
}

function events(state: string): Record<string, unknown>[] {
  const log = join(state, "events.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf-8")
    .split("\n")
    .flatMap((row) => {
      try {
        const event = JSON.parse(row) as Record<string, unknown>;
        return event && typeof event === "object" ? [event] : [];
      } catch {
        return [];
      }
    });
}

function factOpens(state: string): number[] {
  const opens = new Map<string, number>();
  const says = new Map<string, unknown>();
  for (const event of events(state)) {
    if (event.kind === "incident.open" && event.level === "attend" && FACT_LEVELS[String(event.finding)] === "attend" && typeof event.id === "string" && typeof event.at === "string") opens.set(event.id, Date.parse(event.at));
    if (event.kind === "incident.judged" && typeof event.id === "string" && event.told !== true) says.set(event.id, event.says);
  }
  return [...opens].filter(([id, time]) => Number.isFinite(time) && says.get(id) !== "vetoes").map(([, time]) => time);
}

function finalIncidents(labels: Label[]): string[] {
  const fact = (label: Label) => FACT_LEVELS[label.kind] !== undefined;
  const byWatcher = (label: Label) => label.sensor?.question === WATCHER_JUDGED;
  const sensor = (label: Label) => fact(label) && label.sensor !== undefined && !byWatcher(label);
  const useful = (list: Label[]) => list.filter((label) => label.label === "useful").length;
  const groups: [string, (label: Label) => boolean][] = [
    ["raised by a sensor question", (label) => !fact(label) && label.by !== "watcher"],
    ["raised by the Watcher", (label) => label.by === "watcher"],
    ["raised by code facts, confirmed by the sensor", (label) => sensor(label) && label.sensor?.says === "confirms"],
    ["raised by code facts, the sensor unsure", (label) => sensor(label) && label.sensor?.says === "unclear"],
    ["raised by code facts, held back by the sensor", (label) => sensor(label) && label.sensor?.says === "vetoes"],
    ["raised by code facts, confirmed by the Watcher", (label) => fact(label) && byWatcher(label) && label.sensor?.says === "confirms"],
    ["raised by code facts, held back by the Watcher", (label) => fact(label) && byWatcher(label) && label.sensor?.says === "vetoes"],
    ["raised by code facts, not judged", (label) => fact(label) && !label.sensor],
  ];
  const lines = [`incidents in the end, as marked: ${useful(labels)} useful of ${labels.length} (precision ${share(useful(labels), labels.length)})`];
  for (const [name, test] of groups) {
    const mine = labels.filter(test);
    if (mine.length > 0) lines.push(`  ${name}: ${useful(mine)} useful of ${mine.length} (precision ${share(useful(mine), mine.length)})`);
  }
  const kinds = new Map<string, { useful: number; noise: number }>();
  for (const label of labels) {
    const tally = kinds.get(label.kind) ?? { useful: 0, noise: 0 };
    tally[label.label] += 1;
    kinds.set(label.kind, tally);
  }
  for (const [kind, tally] of [...kinds].sort()) lines.push(`  ${kind}: ${tally.useful} useful, ${tally.noise} noise`);
  return lines;
}

function unflagged(state: string, kept: Kept[]): Kept[][] {
  const turns = new Map<string, Kept[]>();
  for (const record of kept) turns.set(turnOf(record), [...(turns.get(turnOf(record)) ?? []), record]);
  const opened = events(state).flatMap((event) => (event.kind === "incident.open" && typeof event.agent === "string" && typeof event.at === "string" ? [{ seat: event.agent, at: Date.parse(event.at) }] : []));
  const clean = (records: Kept[]) => {
    const [first, last] = [records[0]!, records.at(-1)!];
    return (
      records.every((record) => record.found.length === 0 && record.verdicts.length === 0 && record.facts.every((fact) => fact.level === "note")) &&
      !opened.some((open) => open.seat === first.seat && open.at >= first.askedAt && open.at <= last.at + 60_000)
    );
  };
  return [...turns.values()].filter(clean);
}

type SpotCheck = { id: string; verdict: "missed" | "fine"; at: number };

function spotChecks(state: string): SpotCheck[] {
  const file = join(assessmentsDir(state), SPOT_CHECKS);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .flatMap((row) => {
      try {
        const check = JSON.parse(row) as SpotCheck;
        return typeof check.id === "string" && (check.verdict === "missed" || check.verdict === "fine") ? [check] : [];
      } catch {
        return [];
      }
    });
}

function spotChecked(state: string, kept: Kept[]): string[] {
  const latest = new Map<string, SpotCheck["verdict"]>();
  for (const check of spotChecks(state)) latest.set(check.id, check.verdict);
  const turns = unflagged(state, kept);
  const checked = turns.flatMap((records) => (latest.has(idOf(records.at(-1)!)) ? [latest.get(idOf(records.at(-1)!))!] : []));
  const missed = checked.filter((verdict) => verdict === "missed").length;
  const counted = "Only turns with a kept assessment are counted; a turn the sensor never answered is in none of these.";
  if (checked.length === 0) return [`${turns.length} turns the watch did not flag, none spot-checked yet: --sample N picks some to read.`, counted];
  return [`${turns.length} turns the watch did not flag; ${checked.length} spot-checked, ${missed} of them missed something (miss rate ${share(missed, checked.length)})`, counted];
}

export function sample(state: string, count: number, pick: (length: number) => number = (length) => Math.floor(Math.random() * length)): string {
  const checked = new Set(spotChecks(state).map((check) => check.id));
  const open = unflagged(state, readAssessments(state).kept).filter((records) => !checked.has(idOf(records.at(-1)!)));
  if (open.length === 0) return "Every turn the watch did not flag has been spot-checked, or there are none.";
  const out: string[] = [];
  for (let taken = 0; taken < count && open.length > 0; taken++) {
    const records = open.splice(pick(open.length), 1)[0]!;
    const last = records.at(-1)!;
    const work = (last.views.work ?? {}) as { instruction?: string; goal?: string; steps?: Step[] };
    const claim = last.views.claim?.claim;
    out.push(`${idOf(last)}  ${last.provider}, turn ${last.turnId ?? "–"}, ${new Date(last.askedAt).toISOString().slice(0, 16).replace("T", " ")}`);
    out.push(`  instruction: ${work.instruction ?? ""}`);
    out.push(`  goal: ${(work.goal ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
    for (const step of (work.steps ?? []).slice(-10)) out.push(`  | ${stepText(step)}`);
    if (typeof claim === "string") out.push(`  final: ${claim}`);
    out.push("");
  }
  out.push("Mark each with --missed ID if something there should have been raised, or --fine ID if not.");
  return out.join("\n");
}

export function mark(state: string, missed: string[], fine: string[], now = Date.now()): string {
  const known = new Set(unflagged(state, readAssessments(state).kept).map((records) => idOf(records.at(-1)!)));
  const unknown = [...missed, ...fine].filter((id) => !known.has(id));
  if (unknown.length > 0) return `${unknown.join(", ")} is not a turn --sample offers (the last assessment of a turn the watch did not flag); nothing was marked.`;
  const both = missed.filter((id) => fine.includes(id));
  if (both.length > 0) return `${both.join(", ")} is marked both missed and fine; nothing was marked.`;
  mkdirSync(assessmentsDir(state), { recursive: true });
  const rows = [...missed.map((id) => ({ id, verdict: "missed", at: now })), ...fine.map((id) => ({ id, verdict: "fine", at: now }))];
  appendFileSync(join(assessmentsDir(state), SPOT_CHECKS), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return `Marked ${missed.length} missed and ${fine.length} fine.`;
}

function projectFor(path: string): Project {
  const full = resolve(path);
  if (existsSync(join(full, "assessments")) || existsSync(join(full, "incidents.json"))) return { root: "", slug: basename(full), state: full };
  return projectOf(full);
}

function whole(value: string | undefined, least: number): number | undefined {
  if (value === undefined) return undefined;
  return /^\d+$/.test(value) && Number(value) >= least ? Number(value) : Number.NaN;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ask: { type: "boolean" },
      limit: { type: "string" },
      "per-day": { type: "string" },
      model: { type: "string" },
      sample: { type: "string" },
      missed: { type: "string", multiple: true },
      fine: { type: "string", multiple: true },
      help: { type: "boolean" },
    },
  });
  const limit = whole(values.limit, 1);
  const perDay = whole(values["per-day"], 0);
  const count = whole(values.sample, 1);
  const marking = Boolean(values.missed || values.fine);
  if (values.help || positionals.length !== 1 || Number.isNaN(limit) || Number.isNaN(perDay) || Number.isNaN(count) || (count !== undefined && marking)) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const project = projectFor(positionals[0]!);
  if (count !== undefined) console.log(sample(project.state, count));
  else if (marking) console.log(mark(project.state, values.missed ?? [], values.fine ?? []));
  else console.log(await calibrate({ state: project.state, project, ask: values.ask, limit, perDay, model: values.model }));
}
