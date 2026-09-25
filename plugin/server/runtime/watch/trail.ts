import { around, failed, sides, TRUNCATED, within } from "./facts.ts";
import { mask } from "./mask.ts";
import type { Call, Unit, Window } from "./window.ts";

type Result = "running" | "ok" | "failed";

/** Acts and the seat's own accounts are kept apart: what a seat says about its work is not evidence of it. */
export type Step = (
  | { id: string; kind: "ran"; command: string; result: Result; exit?: number; output?: string }
  | { id: string; kind: "changed"; path: string; result: Result; change?: string }
  | { id: string; kind: "read"; target: string; result: Result; output?: string }
  | { id: string; kind: "called"; tool: string; input?: string; result: Result; output?: string }
  | { id: string; kind: "said" | "thought" | "told" | "error"; text: string }
  | { id: string; kind: "compacted" }
) & { note?: string };

/** A turn since its instruction: who sent that, its steps in order, how many fell out before them, and what it ended on. */
export type Trail = { instruction: string; from: string[]; steps: Step[]; lost: number; final?: { id: string; text: string } };

const LIMIT = { command: 600, output: 300, change: 160, said: 600, thought: 400, told: 600, error: 300, input: 200, target: 300 };

const clip = (text: string, limit: number) => (text.length > limit ? `${within(text, limit)}…` : text);
const tail = (text: string, limit: number) => (text.length > limit ? `…${text.slice(-limit).replace(/^[\uDC00-\uDFFF]/, "")}` : text);
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const BASE64_RUN = /^[A-Za-z0-9+/=]{40,}$/;

/** What a tool call's own error field says, which is prose the seat saw, not a thrown value. */
function saidError(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  const held = error as { content?: unknown; message?: unknown; text?: unknown };
  for (const value of [held.content, held.message, held.text]) if (typeof value === "string") return value;
  return JSON.stringify(error);
}

function linesOf(text: string): string[] {
  const body = text.replace(/\n$/, "");
  return body ? body.split("\n") : [];
}

const shown = (rows: string[]) => rows.map((row) => flat(row)).find((row) => row && !BASE64_RUN.test(row));

/** An edit as the lines it added and removed, and the first added line that reads as text. */
function changed(call: Call): string | undefined {
  const detail = call.detail;
  const diff = str(detail.unifiedDiff);
  const rows = diff.split("\n");
  const cut = diff !== "" && TRUNCATED.test(rows.at(-1)!);
  const both = sides(diff ? { ...detail, unifiedDiff: mask(cut ? rows.slice(0, -2).join("\n") : diff) } : detail);
  const note = cut ? " (diff cut short)" : "";
  if (!both) {
    const written = linesOf(mask(str(detail.content)));
    const first = shown(written);
    return written.length > 0 ? `wrote ${written.length} lines${first ? `: ${clip(first, LIMIT.change)}` : ""}` : undefined;
  }
  const [before, after] = both.map((text) => linesOf(mask(text)));
  const left = new Map<string, number>();
  for (const row of before!) left.set(row, (left.get(row) ?? 0) + 1);
  const added: string[] = [];
  for (const row of after!) {
    const held = left.get(row) ?? 0;
    if (held > 0) left.set(row, held - 1);
    else added.push(row);
  }
  const removed = [...left.values()].reduce((sum, held) => sum + held, 0);
  if (added.length === 0 && removed === 0) return note.trim() || undefined;
  const first = shown(added);
  return `+${added.length} -${removed}${note}${first ? `: ${clip(first, LIMIT.change)}` : ""}`;
}

function callStep(id: string, call: Call, exit?: RegExp, destructive?: RegExp): Step {
  const { detail } = call;
  const result: Result = !call.ended ? "running" : failed(call, exit) ? "failed" : "ok";
  const code = typeof detail.exitCode === "number" && detail.exitCode !== 0 ? { exit: detail.exitCode } : {};
  const said = flat(mask(str(detail.output) || saidError(call.error)));
  const output = (limit: number) => (said ? { output: tail(said, limit) } : {});
  if (detail.type === "shell") return { id, kind: "ran", command: around(flat(mask(str(detail.command))), destructive, LIMIT.command), result, ...code, ...output(LIMIT.output) };
  if (detail.type === "edit" || detail.type === "write") {
    const change = result === "failed" ? undefined : changed(call);
    return { id, kind: "changed", path: flat(mask(str(detail.filePath))), result, ...(change ? { change } : {}) };
  }
  const target = str(detail.filePath) || str(detail.url) || str(detail.query);
  if (target) return { id, kind: "read", target: clip(flat(mask(target)), LIMIT.target), result, ...output(LIMIT.output) };
  const input = detail.input && typeof detail.input === "object" && Object.keys(detail.input).length > 0 ? clip(flat(mask(JSON.stringify(detail.input))), LIMIT.input) : undefined;
  return { id, kind: "called", tool: call.name || "tool", ...(input ? { input } : {}), result, ...output(LIMIT.output) };
}

function step(id: string, unit: Unit, exit?: RegExp, destructive?: RegExp): Step {
  if (unit.kind === "call") return callStep(id, unit.call, exit, destructive);
  if (unit.kind === "said") return { id, kind: "said", text: clip(flat(mask(unit.text)), LIMIT.said) };
  if (unit.kind === "thought") return { id, kind: "thought", text: clip(flat(mask(unit.text)), LIMIT.thought) };
  if (unit.kind === "user") return { id, kind: "told", text: clip(flat(mask(unit.text)), LIMIT.told) };
  if (unit.kind === "error") return { id, kind: "error", text: clip(flat(mask(unit.text)), LIMIT.error) };
  return { id, kind: "compacted" };
}

/** Ids count from the instruction, dropped steps included, so an id means the same step in every reading. */
export function trailOf(window: Window, ended: boolean, rules: { exit?: RegExp; destructive?: RegExp }): Trail {
  const units = window.sinceInstruction();
  const lost = window.lostSinceInstruction();
  let end = units.length;
  while (end > 0 && units[end - 1]!.kind === "thought") end -= 1;
  const closing = ended && units[end - 1]?.kind === "said" ? units[end - 1] : undefined;
  const steps = units.flatMap((unit, index) => (unit === closing ? [] : [step(`S${lost + index + 1}`, unit, rules.exit, rules.destructive)]));
  const final = closing?.kind === "said" ? { id: `S${lost + units.indexOf(closing) + 1}`, text: clip(flat(mask(closing.text)), LIMIT.said) } : undefined;
  const instruction = window.lastInstruction();
  return { instruction: flat(mask(instruction.text)), from: instruction.from, steps, lost, ...(final ? { final } : {}) };
}

export function stepText(step: Step): string {
  if (step.kind === "ran") return `${step.id} ran: ${step.command}${step.result === "failed" ? ` (failed${step.exit ? `, exit ${step.exit}` : ""})` : ""}`;
  if (step.kind === "changed") return `${step.id} changed ${step.path}${step.change ? `: ${step.change}` : ""}`;
  if (step.kind === "read") return `${step.id} read ${step.target}`;
  if (step.kind === "called") return `${step.id} called ${step.tool}${step.input ? ` ${step.input}` : ""}`;
  if (step.kind === "compacted") return `${step.id} context compacted`;
  return `${step.id} ${step.kind}: ${step.text}`;
}
