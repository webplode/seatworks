import type { Question, SensorSpec } from "../../../catalog/kit.ts";
import type { Fact } from "../facts.ts";
import { type Step, trailOf } from "../trail.ts";
import { type Brief, type Turn, type View, type ViewName, asked, viewsOf } from "./views.ts";
import type { SeatWatch } from "../watches.ts";
import { errorText } from "../../../core/errors.ts";
import { Pacer } from "../pacer.ts";

export type Assessment = { answers: Record<string, number>; model: string; id: string | null; cost: number | null };

export class SensorError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Between retries. It holds the process open: a script left with nothing else to wait on exited mid-retry. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function readAnswers(body: unknown, spec: Pick<SensorSpec, "questions">): Assessment {
  const held = (body ?? {}) as { answers?: Record<string, { type?: unknown; noul?: unknown }>; model?: unknown; id?: unknown; usage?: { cost?: unknown } };
  const answers: Record<string, number> = {};
  for (const name of Object.keys(spec.questions)) {
    const answer = held.answers?.[name];
    if (!answer) throw new SensorError(`the answer to ${name} is missing`);
    if (answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) throw new SensorError(`the answer to ${name} is not a probability`);
    if (answer.noul < 0 || answer.noul > 1) throw new SensorError(`the answer to ${name} is ${answer.noul}, outside 0 to 1`);
    answers[name] = answer.noul;
  }
  if (typeof held.model !== "string") throw new SensorError("the response names no model");
  return { answers, model: held.model, id: typeof held.id === "string" ? held.id : null, cost: typeof held.usage?.cost === "number" ? held.usage.cost : null };
}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/** One request to the sensor, retried as its settings say; what it answered, unread. */
export async function decide(spec: SensorSpec, key: string, state: unknown, questions: Record<string, unknown>, session: string, fetcher: Fetch, halt?: AbortSignal): Promise<unknown> {
  const body = JSON.stringify({ model: spec.model, state, questions, session_id: session.slice(0, 256) });
  for (let attempt = 0; ; attempt++) {
    if (halt?.aborted) throw new SensorError("let go");
    const late = AbortSignal.timeout(spec.timeoutSeconds * 1000);
    const signal = halt ? AbortSignal.any([halt, late]) : late;
    let status: number;
    let wait: number | undefined;
    let said = "";
    try {
      const response = await bounded(fetcher(spec.url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, signal }), signal);
      if (response.ok) {
        return await bounded(response.json(), signal).catch((error: unknown) => {
          throw new SensorError(late.aborted ? `no answer within ${spec.timeoutSeconds} s` : halt?.aborted ? "let go" : `the answer is not JSON: ${errorText(error)}`);
        });
      }
      status = response.status;
      const after = Number(response.headers.get("retry-after"));
      if (Number.isFinite(after) && after > 0) wait = Math.min(after, 10) * 1000;
      said = await bounded(response.text(), signal).catch(() => "");
    } catch (error) {
      if (error instanceof SensorError) throw error;
      if (halt?.aborted) throw new SensorError("let go");
      if (attempt < spec.retries) {
        await pause(500 * 2 ** attempt);
        continue;
      }
      throw new SensorError(late.aborted ? `no answer within ${spec.timeoutSeconds} s` : `unreachable: ${errorText(error)}`);
    }
    const retryable = status === 429 || status >= 500;
    if (!retryable || attempt >= spec.retries) throw new SensorError(`${status}: ${said.replace(/\s+/g, " ").slice(0, 200)}`, status);
    await pause(wait ?? 500 * 2 ** attempt);
  }
}

export async function assess(spec: SensorSpec, key: string, state: unknown, session: string, fetcher: Fetch = fetch as unknown as Fetch, halt?: AbortSignal): Promise<Assessment> {
  const questions = Object.fromEntries(Object.entries(spec.questions).map(([name, question]) => [name, { type: "noul", instructions: question.instructions, ...(question.criteria ? { criteria: question.criteria } : {}) }]));
  return readAnswers(await decide(spec, key, state, questions, session, fetcher, halt), spec);
}

/** Which of `view`'s steps `question` is about, as one choice over step ids, so an incident can quote it. */
export async function pinpoint(spec: SensorSpec, key: string, view: View, question: Question, session: string, fetcher: Fetch = fetch as unknown as Fetch): Promise<{ id: string; p: number } | undefined> {
  const ids = (Array.isArray(view.steps) ? (view.steps as { id?: unknown }[]) : []).map((step) => step.id).filter((id): id is string => typeof id === "string");
  if (ids.length === 0 || ids.length > 255) return undefined;
  const where = { type: "choice", instructions: `Which step in \`steps\` is the one this is about: ${question.instructions}`, criteria: Object.fromEntries(ids.map((id) => [id, null])) };
  const body = (await decide(spec, key, view, { where }, session, fetcher)) as { answers?: { where?: { choice?: unknown; probabilities?: Record<string, unknown> } } } | null;
  const choice = body?.answers?.where?.choice;
  const p = typeof choice === "string" ? body?.answers?.where?.probabilities?.[choice] : undefined;
  return typeof choice === "string" && ids.includes(choice) && typeof p === "number" ? { id: choice, p } : undefined;
}

export type Sensing = { spec: SensorSpec; key: string; brief: Brief; rules: { exit?: RegExp; destructive?: RegExp } };

export type Reading = { spec: SensorSpec; askedAt: number; turnId: string | null; running: boolean; assessment: Assessment; views: Partial<Record<ViewName, View>>; turn: Turn; questions: Record<string, Question>; facts: Fact[] };

export type Asked = { assessment: Assessment; questions: Record<string, Question> };

/** One request per view, sent together; a reading, a replay and a case all ask this way so all three see the same. */
export async function assessViews(spec: SensorSpec, key: string, views: Partial<Record<ViewName, View>>, turn: Turn, session: string, fetcher?: Fetch, halt?: AbortSignal): Promise<Asked | undefined> {
  const questions = asked(spec.questions, views, turn);
  const groups = new Map<ViewName, Record<string, Question>>();
  for (const [name, question] of Object.entries(questions)) groups.set(question.view, { ...groups.get(question.view), [name]: question });
  if (groups.size === 0) return undefined;
  const parts = await Promise.all([...groups].map(([view, group]) => assess({ ...spec, questions: group }, key, views[view], session, fetcher, halt)));
  return { assessment: merged(parts), questions };
}

function merged(parts: Assessment[]): Assessment {
  const ids = parts.map((part) => part.id).filter((id): id is string => id !== null);
  const costs = parts.map((part) => part.cost).filter((cost): cost is number => cost !== null);
  return {
    answers: Object.assign({}, ...parts.map((part) => part.answers)),
    model: parts[0]!.model,
    id: ids.length > 0 ? ids.join(",") : null,
    cost: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
  };
}

export type AssessorDeps = {
  sensing: (watch: SeatWatch) => Sensing | undefined;
  done: (watch: SeatWatch, reading: Reading) => void;
  failed: (watch: SeatWatch, error: SensorError) => void;
  fetcher?: Fetch;
};

export class Assessor {
  private readonly deps: AssessorDeps;
  private readonly pacers = new Map<string, Pacer>();

  constructor(deps: AssessorDeps) {
    this.deps = deps;
  }

  moment(watch: SeatWatch, urgent: boolean): void {
    const sensing = this.deps.sensing(watch);
    if (!sensing) return;
    let pacer = this.pacers.get(watch.seat.id);
    if (!pacer) {
      const made: Pacer = new Pacer(sensing.spec.debounceSeconds * 1000, sensing.spec.everySeconds * 1000, () => this.run(watch, made));
      pacer = made;
      this.pacers.set(watch.seat.id, pacer);
    }
    if (urgent) pacer.now();
    else pacer.nudge();
  }

  drop(id: string): void {
    this.pacers.get(id)?.stop();
    this.pacers.delete(id);
  }

  dispose(): void {
    for (const id of [...this.pacers.keys()]) this.drop(id);
  }

  private async run(watch: SeatWatch, pacer: Pacer): Promise<void> {
    const sensing = this.deps.sensing(watch);
    if (!sensing) return;
    const askedAt = Date.now();
    const { turnId, running } = watch;
    const facts = [...watch.noted];
    const trail = trailOf(watch.window, !running, sensing.rules);
    const views = viewsOf(trail, sensing.brief, sensing.spec.stateChars);
    const turn = { can: sensing.brief.can, from: trail.from };
    let asking: Asked | undefined;
    try {
      asking = await assessViews(sensing.spec, sensing.key, views, turn, watch.seat.id, this.deps.fetcher, pacer.halt.signal);
    } catch (error) {
      if (this.pacers.get(watch.seat.id) === pacer) this.deps.failed(watch, error instanceof SensorError ? error : new SensorError(errorText(error)));
      return;
    }
    if (asking && this.pacers.get(watch.seat.id) === pacer) this.deps.done(watch, { spec: sensing.spec, askedAt, turnId, running, assessment: asking.assessment, views, turn, questions: asking.questions, facts });
  }

  /** The step a question that opened an incident was about, and how sure the sensor is; undefined when it cannot say. */
  async locate(watch: SeatWatch, reading: Reading, name: string): Promise<(Step & { p: number }) | undefined> {
    const sensing = this.deps.sensing(watch);
    const question = reading.questions[name];
    const view = question ? reading.views[question.view] : undefined;
    if (!sensing || !question || !view) return undefined;
    try {
      const found = await pinpoint(sensing.spec, sensing.key, view, question, watch.seat.id, this.deps.fetcher);
      const step = found && (view.steps as Step[]).find((entry) => entry.id === found.id);
      return step ? { ...step, p: found.p } : undefined;
    } catch {
      return undefined;
    }
  }
}
