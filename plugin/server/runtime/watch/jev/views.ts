import type { Question } from "../../../catalog/kit.ts";
import type { Sibling } from "../../../desk/ledger.ts";
import { within } from "../facts.ts";
import type { Step, Trail } from "../trail.ts";

/** What the sensor is told about the seat itself, apart from what its turn did; `can` chooses questions and is never sent. */
export type Brief = { role: string; can: string[]; goal: string; context: string; beside: Sibling[]; gates: string[]; workingCopy: string };

export type View = Record<string, unknown>;

/** What chooses the questions a turn is asked: what the seat's role can do, and who its instruction came from. */
export type Turn = { can: string[]; from: string[] };

export const LEAST_STATE_CHARS = 1000;

export const VIEW_FIELDS = {
  actions: ["goal", "context", "instruction", "working_copy", "steps"],
  work: ["role", "goal", "context", "beside", "instruction", "steps"],
  claim: ["goal", "claim", "last_check", "changed_after_check"],
  instruction: ["instruction", "steps"],
} as const;

export type ViewName = keyof typeof VIEW_FIELDS;

export const isView = (name: unknown): name is ViewName => typeof name === "string" && Object.hasOwn(VIEW_FIELDS, name);

const size = (value: unknown) => JSON.stringify(value).length;
const set = (text: string) => (text.trim() ? text : undefined);

/** A step with what it printed left out: whether an act was dangerous is in the act, not its output. */
function act(step: Step): Step {
  if (!("output" in step)) return step;
  const { output: _output, ...rest } = step;
  return rest as Step;
}

/** Fits `fields` and as many latest (or earliest) `steps` as `limit` allows; overlong fields are halved, longest first. */
function fit(fields: Record<string, string | undefined>, steps: Step[], limit: number, keep: "latest" | "earliest"): View {
  const text: Record<string, string> = Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const first = keep === "latest" ? steps.at(-1) : steps[0];
  const floor = first ? size(first) + 1 : 0;
  while (size({ ...text, steps: [] }) + floor > limit) {
    const longest = Object.keys(text).reduce((a, b) => (text[b]!.length > text[a]!.length ? b : a));
    if (text[longest]!.length <= 2) break;
    text[longest] = `${within(text[longest]!, Math.floor(text[longest]!.length / 2))}…`;
  }
  let room = limit - size({ ...text, steps: [] });
  const order = keep === "latest" ? [...steps].reverse() : steps;
  const kept: Step[] = [];
  for (const step of order) {
    const cost = size(step) + 1;
    if (cost > room) break;
    kept.push(step);
    room -= cost;
  }
  return { ...text, steps: keep === "latest" ? kept.reverse() : kept };
}

/** What in `said` names one of a sibling's paths: a path under one it owns, or a file it owns by name. */
function mentioned(said: string, siblings: Sibling[]): { path: string; task: string } | undefined {
  const words = said.split(/[^\w./-]+/).filter(Boolean);
  for (const sibling of siblings) {
    for (const glob of sibling.owned) {
      const path = glob.replace(/^\.\//, "").replace(/\*+.*$/, "");
      const file = glob.includes("*") ? undefined : path.split("/").at(-1);
      if (path && words.some((word) => word.startsWith(path) || (file?.includes(".") && (word === file || word.endsWith(`/${file}`))))) return { path, task: sibling.task };
    }
  }
  return undefined;
}

const spoken = (step: Step): string => ("text" in step ? step.text : "command" in step ? step.command : "target" in step ? step.target : "path" in step ? step.path : "");

/** Notes a step that speaks of a sibling's file where it stands: the sensor does not reliably make that hop itself. */
function noted(steps: Step[], siblings: Sibling[]): Step[] {
  return steps.map((step) => {
    const found = mentioned(spoken(step), siblings);
    return found ? { ...step, note: `${found.path} is being written by ${found.task} in another copy, so it is not finished here` } : step;
  });
}

/** The last run of the project's gate, or of the runner its script starts, since the instruction. */
function lastCheck(steps: Step[], gates: string[]): number {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]!;
    if (step.kind === "ran" && gates.some((gate) => step.command.includes(gate))) return index;
  }
  return -1;
}

/** `claim` beside its evidence, the last check and what changed after it; what a seat says of its work is never evidence. */
function claimOf(trail: Trail, brief: Brief, limit: number): View | undefined {
  const final = trail.final?.text;
  if (!final) return undefined;
  const at = lastCheck(trail.steps, brief.gates);
  const check = trail.steps[at];
  const after = trail.steps.slice(at + 1).flatMap((step) => (step.kind === "changed" && step.result !== "failed" ? [step.path] : []));
  const view: View = {
    ...(set(brief.goal) ? { goal: brief.goal } : {}),
    claim: final,
    last_check: check ?? `none: nothing that runs ${brief.gates[0] ?? "the project's checks"} was run since the instruction`,
    changed_after_check: [...new Set(after)],
  };
  return size(view) > limit ? { ...view, claim: `${within(final, Math.max(200, limit - size({ ...view, claim: "" })))}…` } : view;
}

const besideText = (siblings: Sibling[]) =>
  siblings.length === 0 ? "" : `Being written in other copies, and so not finished here: ${siblings.map((sibling) => `${sibling.task} (${sibling.title})${sibling.owned.length > 0 ? `, which owns ${sibling.owned.join(", ")}` : ""}`).join("; ")}`;

/** Every view a trail can give, each fitted to `limit`; a view with nothing to show is left out. */
export function viewsOf(trail: Trail, brief: Brief, limit: number): Partial<Record<ViewName, View>> {
  const who = { goal: set(brief.goal), context: set(brief.context) };
  const views: Partial<Record<ViewName, View>> = {
    actions: fit({ ...who, instruction: set(trail.instruction), working_copy: set(brief.workingCopy) }, trail.steps.filter((step) => step.kind === "ran" || step.kind === "changed" || step.kind === "called").map(act), limit, "latest"),
    // What the turn ended on is something the seat said, and the work view reads everything it said.
    work: fit({ role: set(brief.role), ...who, beside: set(besideText(brief.beside)), instruction: set(trail.instruction) }, noted([...trail.steps, ...(trail.final ? [{ id: trail.final.id, kind: "said" as const, text: trail.final.text }] : [])], brief.beside), limit, "latest"),
  };
  const claim = claimOf(trail, brief, limit);
  if (claim) views.claim = claim;
  // Needs the first steps: a turn that lost them cannot answer, and saying so did not make the sensor careful.
  if (trail.lost === 0 && trail.instruction) views.instruction = fit({ instruction: trail.instruction }, trail.steps, limit, "earliest");
  return views;
}

const blank = (value: unknown) => value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/** The questions that apply to this seat's turn and its views can answer: its role can do what each is `for`, its instruction came from one it is asked `after`, and the view it reads has something in what it needs. */
export function asked(questions: Record<string, Question>, views: Partial<Record<ViewName, View>>, turn: Turn): Record<string, Question> {
  return Object.fromEntries(
    Object.entries(questions).filter(([, question]) => {
      const view = views[question.view];
      if (question.for && !turn.can.includes(question.for)) return false;
      if (question.after && !question.after.some((kind) => turn.from.includes(kind))) return false;
      return view !== undefined && (!question.needs || question.needs.some((field) => !blank(view[field])));
    }),
  );
}
