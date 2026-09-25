import { isAbsolute, relative } from "node:path";
import { globToRegex, normalize } from "../../core/scope.ts";
import { mask } from "./mask.ts";
import type { Call, Change, Unit, Window } from "./window.ts";

const COMMAND_START = "(?:^|[;&|(`{\\n]|\\$\\(|\\b(?:sudo|xargs|exec|env|nohup|time|command|then|do|else)\\s+|-exec(?:dir)?\\s+|\\b(?:ba|z)?sh\\s+-l?c\\s+)\\s*['\"]?";

export const DESTRUCTIVE =
  `${COMMAND_START}(?:rm\\s+(?:-\\S+\\s+)*(?:-[a-z]*[rf][a-z]*|--(?:recursive|force)\\b)|git\\s+(?:-C\\s+\\S+\\s+)?(?:reset\\s+--hard|clean\\s+-[a-z]*f|push\\s+[^|;&]*(?:--force|-f)\\b|branch\\s+(?:-\\S+\\s+)*(?-i:-D)\\b|branch\\b(?=[^|;&]*\\s(?:-[a-z]*d|--delete))[^|;&]*\\s(?:-[a-z]*f|--force)\\b))` +
  "|--force-with-lease|\\bdrop\\s+(?:table|database)\\b|\\btruncate\\s+table\\b";

export const TEST_PATH = "(^|/)(tests?|specs?|__tests__)/|[._-](test|spec)\\.[a-z]+$|(^|/)test_[^/]*\\.[a-z]+$";

export const SUPPRESSED = "@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|#\\s*type:\\s*ignore|#\\s*noqa|\\bas\\s+any\\b(?![ \\t]+(?!as\\b)[a-z])";

const ASSERTION = "\\b(assert|expect)\\b|\\.should\\b";
const SKIPPED = "\\.(skip|only|todo)\\b|\\bx(it|describe|test)\\b|@Disabled\\b|pytest\\.mark\\.skip\\b";

export type Level = "page" | "attend" | "note";

export type Fact = { kind: string; level: Level; quote: string };

export const FACT_LEVELS: Record<string, Level> = {
  destructive: "page",
  stuck: "attend",
  "no-recovery": "attend",
  "test-weakened": "attend",
  suppressed: "attend",
  unverified: "attend",
  "claim-contradicted": "attend",
  "long-turn": "attend",
  "rework-loop": "attend",
  "patched-not-fixed": "attend",
  "accepted-unfinished": "attend",
  "reviews-unconverged": "attend",
  "certainty-only": "attend",
  "brief-prewritten": "attend",
  "call-failed": "note",
  "gate-failed": "note",
  "outside-scope": "note",
};

export const FACT_TITLES: Record<string, string> = {
  destructive: "Ran a command that cannot be undone",
  stuck: "Going round in circles",
  "no-recovery": "Did not recover from a failure",
  "test-weakened": "A test lost its assertions",
  suppressed: "Silenced a check instead of fixing it",
  unverified: "Handed back without running the gate",
  "claim-contradicted": "Handed back as complete while its last check failed",
  "long-turn": "A turn running far longer than usual",
  "rework-loop": "Sent back again and again",
  "patched-not-fixed": "Several tasks patched, none fixed",
  "accepted-unfinished": "Work taken in unfinished",
  "reviews-unconverged": "Reviews piling up with nothing accepted",
  "certainty-only": "A review told to report only certainties",
  "brief-prewritten": "A brief that writes the answer out",
};

export type Rules = {
  destructive: RegExp;
  testPath: RegExp;
  suppressed: RegExp;
  exit?: RegExp;
  desk?: (call: Call) => boolean;
  gates: string[];
  cwd?: string;
  temp?: string;
  owned?: string[];
  repeatsAt: number;
  recoverWithin: number;
};

const count = (text: string, pattern: string): number => (text.match(new RegExp(pattern, "gi")) ?? []).length;
const flat = (text: string, limit = 200): string => within(mask(text).replace(/\s+/g, " ").trim(), limit);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** How a change to a test file weakened it, if it did: a new skip marker, or fewer assertions. */
export function weakened(before: string, after: string): string | undefined {
  if (count(after, SKIPPED) > count(before, SKIPPED)) return "adds a skip marker";
  const [was, now] = [count(before, ASSERTION), count(after, ASSERTION)];
  return now < was ? `${was} assertions become ${now}` : undefined;
}

/** Calls to `server`: read from the field the harness records it in, or else from the name, `pattern` holding `{server}` where it goes. */
export function callsTo(pattern: string | undefined, field: string | undefined, server: string): ((call: Call) => boolean) | undefined {
  if (field) return (call) => field.split(".").reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], call.detail) === server;
  const name = pattern ? new RegExp(pattern.replaceAll("{server}", server)) : undefined;
  return name && ((call) => name.test(call.name));
}

export function failed(call: Call, exit?: RegExp): boolean {
  if (call.status === "failed") return true;
  if (typeof call.detail.exitCode === "number") return call.detail.exitCode !== 0;
  const code = exit?.exec(str(call.detail.output).trim())?.[1];
  return code !== undefined && Number(code) !== 0;
}

export function isGate(call: Call, gates: string[]): boolean {
  return call.detail.type === "shell" && gates.some((gate) => str(call.detail.command).includes(gate));
}

const said = (value: unknown): boolean => value !== undefined && value !== null && value !== "" && !(typeof value === "object" && Object.keys(value).length === 0);

/** Undefined when nothing tells calls apart: Paseo records a Claude seat's MCP calls with an empty input. */
function actionOf(call: Call): string | undefined {
  const { output: _output, exitCode: _exit, ...rest } = call.detail;
  return Object.entries(rest).some(([key, value]) => key !== "type" && said(value)) ? `${call.name}\n${JSON.stringify(rest)}` : undefined;
}

function resultOf(call: Call, exit?: RegExp): string {
  return `${failed(call, exit) ? "failed" : "ok"}\n${str(call.detail.output)}\n${JSON.stringify(call.error ?? null)}`;
}

export function stuck(units: Unit[], rules: Pick<Rules, "exit" | "repeatsAt">): string | undefined {
  const recent = units.slice(-20);
  const calls = recent.flatMap((unit) => (unit.kind === "call" && unit.call.ended && !unit.call.pseudo ? [unit.call] : []));
  const same = (list: (string | undefined)[]) => list[0] !== undefined && list.every((value) => value === list[0]);
  const n = rules.repeatsAt;
  const tail = calls.slice(-(n + 1));
  if (!rules.exit && tail.length === n + 1 && same(tail.map(actionOf)) && same(tail.map((call) => resultOf(call)))) {
    return `the same action with the same result ${n + 1} times: ${flat(describe(tail[0]!), 120)}`;
  }
  const errors = calls.slice(-n);
  if (errors.length === n && same(errors.map(actionOf)) && errors.every((call) => failed(call, rules.exit))) {
    return `the same action failing ${n} times: ${flat(describe(errors[0]!), 120)}`;
  }
  const spoken = recent.filter((unit) => unit.kind !== "thought");
  for (const said of [spoken.slice(-n), spoken.slice(-n - 1, -1)]) {
    if (said.length === n && said.every((unit) => unit.kind === "said") && same(said.map((unit) => (unit.kind === "said" ? flat(unit.text, 2000) : "")))) {
      return `the same words ${n} times with nothing done between them`;
    }
  }
  const cycle = calls.slice(-2 * n);
  if (!rules.exit && cycle.length === 2 * n) {
    const actions = cycle.map(actionOf);
    const results = cycle.map((call) => resultOf(call));
    const alternates = actions[0] !== actions[1] && actions.every((action, index) => action === actions[index % 2]) && results.every((result, index) => result === results[index % 2]);
    if (alternates) return `alternating between two actions ${n} times: ${flat(describe(cycle[0]!), 60)} / ${flat(describe(cycle[1]!), 60)}`;
  }
  return undefined;
}

export function describe(call: Call): string {
  const detail = call.detail;
  const what = str(detail.command) || str(detail.filePath) || str(detail.url) || str(detail.query);
  return [call.name || "tool", what].filter(Boolean).join(": ");
}

function escapes(path: string, rules: Rules): boolean {
  if (!path || !rules.cwd || !isAbsolute(path)) return false;
  return relative(rules.cwd, path).startsWith("..");
}

function outside(path: string, rules: Rules): boolean {
  if (!path || /\s/.test(path) || !rules.cwd) return false;
  if (rules.temp && isAbsolute(path) && !relative(rules.temp, path).startsWith("..")) return false;
  const rel = isAbsolute(path) ? relative(rules.cwd, path) : normalize(path);
  if (rel.startsWith("..")) return true;
  if (!rules.owned || rules.owned.length === 0) return false;
  return !rules.owned.some((glob) => globToRegex(glob).test(rel));
}

const SCRATCH = /^(?:\$\{?TMPDIR\}?|\/tmp|\/private\/tmp)(?:\/|$)/;

/** An `rm` whose every target is scratch space: $TMPDIR, /tmp, or the machine's temporary directory. */
function scratchOnly(part: string, temp?: string): boolean {
  const words = part.trim().split(/\s+/);
  if (words[0] !== "rm") return false;
  const targets = words.slice(1).filter((word) => !word.startsWith("-")).map((word) => word.replace(/^["']|["']$/g, ""));
  return targets.length > 0 && targets.every((target) => SCRATCH.test(target) || Boolean(temp && isAbsolute(target) && !relative(temp, target).startsWith("..")));
}

export function onDetail(call: Call, rules: Rules): Fact[] {
  if (call.detail.type !== "shell") return [];
  // A command at a time: removing a commit message's temp file once paged a Lead.
  const risky = str(call.detail.command)
    .split(/&&|\|\||;|\n/)
    .find((part) => rules.destructive.test(part) && !scratchOnly(part, rules.temp));
  return risky ? [{ kind: "destructive", level: "page", quote: around(flat(risky, Infinity), rules.destructive, 200) }] : [];
}

const PROSE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

export function within(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Cuts around the match, not from the front: what makes a long command irreversible is often at its end. */
export function around(text: string, pattern: RegExp | undefined, limit: number): string {
  if (text.length <= limit) return text;
  const found = pattern ? new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(text) : null;
  const start = found && found.index + found[0].length > limit ? Math.max(0, Math.min(found.index - Math.floor(limit / 4), text.length - limit)) : 0;
  const body = within(text.slice(start).replace(/^[\uDC00-\uDFFF]/, ""), limit);
  return `${start > 0 ? "…" : ""}${body}${start + body.length < text.length ? "…" : ""}`;
}

export const TRUNCATED = /^\.\.\.\[truncated \d+ chars\]$/;

export function sides(detail: Call["detail"], known?: (path: string) => string | undefined): [string, string] | undefined {
  const diff = str(detail.unifiedDiff);
  if (diff) {
    let lines = diff.split("\n");
    if (TRUNCATED.test(lines.at(-1) ?? "")) {
      lines = lines.slice(0, -1);
      while (lines.length > 0 && !/^( |@@)/.test(lines.at(-1)!)) lines.pop();
    }
    const numbered = !lines.some((line) => line.startsWith("@@") || line.startsWith("diff --git")) && lines.some((line) => /^[+-]\s*\d+ /.test(line));
    const header = new Set<number>();
    let hunk = false;
    lines.forEach((line, index) => {
      if (line.startsWith("diff --git")) hunk = false;
      else if (line.startsWith("@@")) hunk = true;
      else if (!hunk && line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) header.add(index).add(index + 1);
    });
    const taken = (sign: string) =>
      lines
        .filter((line, index) => line.startsWith(sign) && !header.has(index))
        .map((line) => (numbered ? line.slice(1).replace(/^\s*\d+ /, "") : line.slice(1)))
        .join("\n");
    return [taken("-"), taken("+")];
  }
  if (detail.type === "write") {
    const before = known?.(str(detail.filePath));
    return before === undefined ? undefined : [before, str(detail.content)];
  }
  return [str(detail.oldString), str(detail.newString)];
}

function hits(text: string, pattern: RegExp): string[] {
  return text.match(new RegExp(pattern.source, "gi")) ?? [];
}

export function onSettle(call: Call, rules: Rules, known?: (path: string) => string | undefined): Fact[] {
  const facts: Fact[] = [];
  const detail = call.detail;
  const bad = failed(call, rules.exit);
  // The desk's refusals already told the seat why and what instead, and the desk records them.
  if (bad && !rules.desk?.(call)) facts.push({ kind: isGate(call, rules.gates) ? "gate-failed" : "call-failed", level: "note", quote: flat(describe(call)) });
  const writes = detail.type === "edit" || detail.type === "write";
  const both = writes && !bad ? sides(detail, known) : undefined;
  if (both) {
    const path = str(detail.filePath);
    const [before, after] = both;
    if (rules.testPath.test(path) && (before || after)) {
      const how = weakened(before, after);
      if (how) facts.push({ kind: "test-weakened", level: "attend", quote: `${flat(path)}: ${how}` });
    }
    if (!PROSE.test(path)) {
      const was = hits(before, rules.suppressed);
      const now = hits(after, rules.suppressed);
      const added = now.find((hit) => now.filter((other) => other === hit).length > was.filter((other) => other === hit).length);
      if (added) facts.push({ kind: "suppressed", level: "attend", quote: `${flat(path)}: adds ${flat(added, 60)}` });
    }
  }
  if (writes && outside(str(detail.filePath), rules)) {
    facts.push({ kind: "outside-scope", level: "note", quote: flat(str(detail.filePath)) });
  }
  return facts;
}

const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "bunx", "uv", "uvx", "poetry", "pipenv", "python", "python3", "cargo", "go", "make", "just", "deno", "node", "dotnet", "mvn", "gradle", "./gradlew", "git", "gh", "docker", "kubectl"]);

export function head(command: string): string {
  const main = command.split(/&&|;/).map((part) => part.trim()).filter((part) => part && !/^cd\s/.test(part)).at(-1) ?? command;
  const words = main.split("|")[0]!.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  if (!RUNNERS.has(words[0] ?? "")) return words[0] ?? "";
  return words.slice(0, /^(run|exec|-m|x|dlx)$/.test(words[1] ?? "") ? 3 : 2).join(" ");
}

export class Recovery {
  private open: { command: string; head: string; steps: number; told: boolean } | undefined;

  step(call: Call, rules: Rules): Fact[] {
    const shell = call.detail.type === "shell";
    const command = str(call.detail.command);
    const bad = failed(call, rules.exit);
    if (shell && bad && (!this.open || head(command) !== this.open.head)) {
      this.open = { command, head: head(command), steps: 0, told: false };
      return [];
    }
    if (!this.open) return [];
    if (shell && !bad && (head(command) === this.open.head || isGate(call, rules.gates))) {
      this.open = undefined;
      return [];
    }
    this.open.steps += 1;
    if (this.open.told || this.open.steps < rules.recoverWithin) return [];
    this.open.told = true;
    return [{ kind: "no-recovery", level: "attend", quote: `${rules.recoverWithin} steps since \`${flat(this.open.command, 100)}\` failed, and neither it nor the gate has passed since` }];
  }

  reset(): void {
    this.open = undefined;
  }
}

/** The instruction's calls, with where the last edit inside the working copy and the last run of the gate fell. */
function lastWriteAndGate(window: Window, rules: Rules) {
  const calls = window.sinceInstruction().flatMap((unit) => (unit.kind === "call" ? [unit.call] : []));
  const inside = (call: Call) => (call.detail.type === "edit" || call.detail.type === "write") && !escapes(str(call.detail.filePath), rules);
  let lastWrite = -1;
  let lastGate = -1;
  calls.forEach((call, index) => {
    if (inside(call) && !failed(call, rules.exit)) lastWrite = index;
    if (isGate(call, rules.gates)) lastGate = index;
  });
  return { calls, inside, lastWrite, lastGate };
}

export function unverified(window: Window, rules: Rules, heard: boolean): Fact[] {
  const named = rules.gates[0];
  if (!heard || !named) return [];
  const { calls, inside, lastWrite, lastGate } = lastWriteAndGate(window, rules);
  if (lastWrite < 0 || lastGate > lastWrite) return [];
  const written = new Set(calls.filter(inside).map((call) => str(call.detail.filePath)));
  return [{ kind: "unverified", level: "attend", quote: `${written.size} file${written.size === 1 ? "" : "s"} written and \`${flat(named, 100)}\` not run after the last of them` }];
}

/** A hand-back that says the work is complete when the check it ran after its last edit failed: the record, not the claim, is what settles it. */
export function contradicted(window: Window, rules: Rules, outcome: string | undefined): Fact[] {
  if (outcome !== "complete") return [];
  const { calls, lastWrite, lastGate } = lastWriteAndGate(window, rules);
  const check = calls[lastGate];
  if (!check || lastGate < lastWrite || !failed(check, rules.exit)) return [];
  return [{ kind: "claim-contradicted", level: "attend", quote: `handed back as complete, but \`${flat(str(check.detail.command), 100)}\` failed the last time it ran, after the last edit` }];
}

export function afterChange(change: Change, rules: Rules, known?: (path: string) => string | undefined): Fact[] {
  const call = change.call;
  if (!call || call.pseudo) return [];
  return [...(change.detailed ? onDetail(call, rules) : []), ...(change.settled ? onSettle(call, rules, known) : [])];
}
