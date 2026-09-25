import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type SensorSpec, loadKit, sensorProblems } from "../../server/catalog/kit.ts";
import { mask } from "../../server/runtime/watch/mask.ts";
import { confirmable } from "../../server/runtime/watch/jev/rules.ts";
import { Assessor, SensorError, assess, pinpoint, readAnswers } from "../../server/runtime/watch/jev/sensor.ts";
import { Pacer } from "../../server/runtime/watch/pacer.ts";
import type { Brief } from "../../server/runtime/watch/jev/views.ts";
import { Window } from "../../server/runtime/watch/window.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kit = loadKit(join(here, "..", ".."));
const shipped = Object.values(kit.sensors)[0]!;

const spec = (questions: SensorSpec["questions"], extra: Partial<SensorSpec> = {}): SensorSpec => ({ ...shipped, retries: 2, timeoutSeconds: 1, questions, ...extra });
const noul = (instructions = "q") => ({ view: "work" as const, instructions, threshold: 0.7, level: "attend" as const });
const brief = (goal = "g"): Brief => ({ role: "Peer", can: ["work", "write", "watched"], goal, context: "", beside: [], gates: ["npm test"], workingCopy: "/w" });
const sensing = (questions: SensorSpec["questions"], extra: Partial<SensorSpec> = {}) => ({ spec: spec(questions, extra), key: "k", brief: brief(), rules: {} });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (item: Record<string, unknown>, seq: number) => ({ item, seq, epoch: "e", turnId: "t", replay: false });
const shell = (id: string, command: string) => ({ type: "tool_call", callId: id, name: "Bash", status: "completed", detail: { type: "shell", command, output: "ok" } });

test("the response OpenRouter documents for its Decisions endpoint reads as an assessment", () => {
  const documented = JSON.parse(readFileSync(join(here, "..", "fixtures", "decisions-response.json"), "utf-8"));
  assert.deepEqual(readAnswers(documented, spec({ is_bug: noul() })), {
    answers: { is_bug: 0.96 },
    model: "typesafe/jev-1.13-20260917",
    id: "gen-dec-1789738314-X5e5eKGQdvR9rblyX250",
    cost: 0.000019992,
  });
});

test("one answer missing, not a probability, or outside 0 to 1 voids the whole assessment", () => {
  const asked = spec({ a: noul(), b: noul() });
  const body = (b: unknown) => ({ answers: { a: { type: "noul", noul: 0.4 }, ...(b === undefined ? {} : { b }) }, model: "m", id: "i" });
  assert.throws(() => readAnswers(body(undefined), asked), /the answer to b is missing/);
  assert.throws(() => readAnswers(body({ type: "noul", noul: "0.9" }), asked), /the answer to b is not a probability/);
  assert.throws(() => readAnswers(body({ type: "choice", choice: "x" }), asked), /the answer to b is not a probability/);
  assert.throws(() => readAnswers(body({ type: "noul", noul: 1.2 }), asked), /the answer to b is 1.2, outside 0 to 1/);
  assert.deepEqual(readAnswers(body({ type: "noul", noul: 1 }), asked).answers, { a: 0.4, b: 1 });
});

type Reply = { status: number; body?: unknown; retryAfter?: string };

function server(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetcher = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const reply = replies.shift() ?? { status: 500 };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (name: string) => (name === "retry-after" ? (reply.retryAfter ?? null) : null) },
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body ?? { error: "x" }),
    };
  };
  return { calls, fetcher };
}

const good = { answers: { a: { type: "noul", noul: 0.9 } }, model: "typesafe/jev-1.13-20260917", id: "gen-1", usage: { cost: 0.00002 } };

test("a busy or failing endpoint is asked again, and a refusal that retrying cannot fix is not", async () => {
  const asked = spec({ a: noul("is it?") });
  const busy = server([{ status: 429, retryAfter: "0.01" }, { status: 503, retryAfter: "0.01" }, { status: 200, body: good }]);
  const assessment = await assess(asked, "sk-or-secret", { goal: "g" }, "seat-1", busy.fetcher as never);
  assert.equal(assessment.answers.a, 0.9);
  assert.equal(busy.calls.length, 3);
  assert.deepEqual(busy.calls[0]!.body, { model: asked.model, state: { goal: "g" }, questions: { a: { type: "noul", instructions: "is it?" } }, session_id: "seat-1" });
  assert.equal(busy.calls[0]!.headers.Authorization, "Bearer sk-or-secret");
  for (const status of [400, 401, 402, 413]) {
    const refused = server([{ status, body: { error: { message: "no" } } }, { status: 200, body: good }]);
    const error = await assess(asked, "sk-or-secret", {}, "seat-1", refused.fetcher as never).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof SensorError && error.status === status, String(status));
    assert.equal(refused.calls.length, 1, `${status} is a setting to fix, not a moment to wait out`);
    assert.doesNotMatch(error.message, /sk-or-secret/);
  }
  const down = server([{ status: 500, retryAfter: "0.01" }, { status: 502, retryAfter: "0.01" }, { status: 503 }, { status: 200, body: good }]);
  await assert.rejects(assess(asked, "k", {}, "s", down.fetcher as never), (error: unknown) => error instanceof SensorError && error.status === 503);
  assert.equal(down.calls.length, 3, "two retries, then it gives up");
});

test("pieces arriving close together make one assessment, a steady stream makes one per interval, and never two at once", async (t) => {
  // Mock clock: on real timers a busy machine stretched a wait past the quiet window.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const advance = async (ms: number) => {
    for (let i = 0; i < ms; i++) {
      t.mock.timers.tick(1);
      for (let k = 0; k < 5; k++) await Promise.resolve();
    }
  };
  let runs = 0;
  let inside = 0;
  let most = 0;
  const pacer = new Pacer(30, 90, async () => {
    runs += 1;
    inside += 1;
    most = Math.max(most, inside);
    await wait(40);
    inside -= 1;
  });
  pacer.nudge();
  await advance(10);
  pacer.nudge();
  await advance(10);
  pacer.nudge();
  await advance(29);
  assert.equal(runs, 0, "still inside the quiet window of the last nudge");
  await advance(1);
  assert.equal(runs, 1, "three nudges inside the quiet window are one assessment");
  await advance(60);
  const steady = runs;
  for (let i = 0; i < 15; i++) {
    pacer.nudge();
    await advance(10);
  }
  assert.equal(runs - steady, 1, "a seat that never goes quiet is assessed once in its interval, not held back");
  await advance(30);
  assert.equal(runs - steady, 2, "and once more when it does go quiet");
  pacer.now();
  pacer.now();
  pacer.now();
  await advance(200);
  assert.equal(most, 1, "one assessment at a time");
  pacer.stop();
});

test("the shipped sensor asks only questions it can use, and the kit refuses one that could not be read", () => {
  assert.deepEqual(sensorProblems(shipped.id, shipped as unknown as Record<string, unknown>), []);
  assert.ok(Object.values(shipped.questions).some((question) => question.alone), "some questions stand alone");
  // `unverified` already opens its own incident, so the question confirms it rather than opening a second.
  const claims = shipped.questions.unverified_success!;
  assert.deepEqual(claims.confirms, ["unverified"]);
  assert.equal(claims.level, undefined, "it opens no incident of its own");
  assert.equal(claims.agrees, undefined);
  assert.ok(confirmable(shipped.questions).has("unverified"), "so the unverified incident waits for the sensor and is vetoed when nothing was claimed");
  assert.deepEqual(sensorProblems("x", { ...shipped, id: "x", url: "http://plain" } as never), ["sends its state somewhere that is not https"]);
  assert.deepEqual(sensorProblems("x", { ...shipped, id: "x", questions: { q: { view: "work", instructions: "?", threshold: 2, level: "loud", alone: true } } } as never), [
    "asks q with no threshold between 0 and 1",
    "asks q at a level that is neither page nor attend",
  ]);
  assert.deepEqual(sensorProblems("x", { ...shipped, id: "x", questions: { q: { view: "work", instructions: "?", threshold: 0.7, level: "attend" } } } as never), [
    "asks q with a level, though it opens no incident of its own",
    "asks q with a threshold, though nothing decides on its answer",
  ]);
  assert.deepEqual(sensorProblems("x", { ...shipped, id: "x", questions: { q: { view: "claim", instructions: "?", threshold: 0.7, confirms: ["destructive"], criteria: { true: "yes" } } } } as never), [
    "asks q with criteria that are not a true and a false text",
    "asks q with confirms that is not a list of attention-level fact kinds",
  ]);
  assert.deepEqual(sensorProblems("x", { ...shipped, id: "x", unclaer: 0.2, questions: { q: { view: "work", instructions: "?", criterion: { true: "a", false: "b" }, criteria: null } } } as never), [
    "has unclaer, which a sensor does not take",
    "asks q with criterion, which a question does not take",
    "asks q with criteria that are not a true and a false text",
  ], "a misspelt key is refused, not silently dropped");
  // A question can need only what its one view holds, or it would silently never be asked.
  assert.deepEqual(sensorProblems("x", { ...shipped, id: "x", questions: { q: { view: "everything", instructions: "?" }, r: { view: "work", instructions: "?", needs: ["claim"] } } } as never), [
    "asks q over everything, which is not a view (actions, work, claim, instruction)",
    "asks r with needs that is not a list of its view's fields (role, goal, context, beside, instruction, steps)",
  ]);
  assert.deepEqual(sensorProblems("x", { ...shipped, id: "x", questions: { q: { view: "work", instructions: "?", excusedBeside: true } } } as never), ["asks q excused beside, though it opens no incident to excuse"]);
  assert.deepEqual(sensorProblems("x", { ...shipped, id: "x", questions: { q: { view: "work", instructions: "?", for: ["write"] }, r: { view: "instruction", instructions: "?", after: "rework" } } } as never), [
    "asks q for something that is not a capability",
    "asks r after something that is not a list of who an instruction comes from",
  ]);
});

test("the usual shapes a secret is printed in are masked", () => {
  for (const [text, secret] of [
    ['curl -H "Authorization: Bearer 9f8e7d6c5b4a39281706"', "9f8e7d6c5b4a39281706"],
    ["STRIPE=sk_live_51HxQ2eLkYbq7ZzAbCdEf", "sk_live_51HxQ2eLkYbq7ZzAbCdEf"],
    ['{\\"password\\": \\"Tr0ub4dor&3xyz\\"}', "Tr0ub4dor&3xyz"],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG", "wJalrXUtnFEMI/K7MDENG"],
    ["git clone https://bob:hunter2hunter2@github.com/x/y", "hunter2hunter2"],
  ]) assert.ok(!mask(text).includes(secret), `${text} → ${mask(text)}`);
});

test("an answer whose body never finishes arriving is given up at the timeout", async () => {
  const stalled = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: () => new Promise<unknown>(() => {}), text: async () => "" });
  const started = Date.now();
  await assert.rejects(assess(spec({ a: noul() }, { timeoutSeconds: 0.05, retries: 0 }), "k", {}, "s", stalled as never), /no answer within 0.05 s/);
  assert.ok(Date.now() - started < 1000);
});

test("a response without an id still counts, since the endpoint does not promise one", () => {
  const documented = JSON.parse(readFileSync(join(here, "..", "fixtures", "decisions-response.json"), "utf-8"));
  delete documented.id;
  assert.equal(readAnswers(documented, spec({ is_bug: noul() })).id, null);
});

test("an assessment still in flight when its seat is let go is not recorded", async () => {
  let answer: (value: unknown) => void = () => {};
  const fetcher = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: () => new Promise((resolve) => (answer = resolve)), text: async () => "" });
  const done: string[] = [];
  const watch = { seat: { id: "s1", provider: "p", cwd: "/w" }, window: new Window(), noted: [] } as never;
  const assessor = new Assessor({
    sensing: () => sensing({ a: noul() }),
    done: () => done.push("done"),
    failed: () => done.push("failed"),
    fetcher: fetcher as never,
  });
  assessor.moment(watch, true);
  await wait(10);
  assessor.drop("s1");
  answer({ answers: { a: { type: "noul", noul: 0.9 } }, model: "m" });
  await wait(10);
  assert.deepEqual(done, []);
});

test("ordinary words and identifiers that look like secret names are left alone", () => {
  for (const text of ["maxTokens: 12345678", "const pk_order_line_items_id = 3", "Basic auth is enabled on staging", "tokenizer=cl100k_base"]) assert.equal(mask(text), text, text);
});

test("an answer that is not JSON is not paid for again", async () => {
  const replies = server([{ status: 200 }, { status: 200, body: good }]);
  const broken = async (url: string, init: never) => ({ ...(await replies.fetcher(url, init)), json: async () => { throw new SyntaxError("Unexpected token <"); } });
  await assert.rejects(assess(spec({ a: noul() }), "k", {}, "s", broken as never), /the answer is not JSON/);
  assert.equal(replies.calls.length, 1);
});

test("letting a seat go stops the request it has in flight", async () => {
  let seen: AbortSignal | undefined;
  const fetcher = async (_url: string, init: { signal: AbortSignal }) => {
    seen = init.signal;
    return new Promise<never>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  };
  const watch = { seat: { id: "s1", provider: "p", cwd: "/w" }, window: new Window(), noted: [] } as never;
  const assessor = new Assessor({ sensing: () => sensing({ a: noul() }, { timeoutSeconds: 5 }), done: () => {}, failed: () => {}, fetcher: fetcher as never });
  assessor.moment(watch, true);
  await wait(10);
  assessor.drop("s1");
  await wait(10);
  assert.equal(seen?.aborted, true);
});

test("each view is asked in a request of its own, only for the questions it can answer", async () => {
  const bodies: { state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
  const fetcher = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { state: Record<string, unknown>; questions: Record<string, unknown> };
    bodies.push(body);
    const answers = Object.fromEntries(Object.keys(body.questions).map((name) => [name, { type: "noul", noul: 0.1 }]));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ answers, model: "m", usage: { cost: 0.00001 } }), text: async () => "" };
  };
  const readings: { questions: string[]; cost: number | null }[] = [];
  let running = true;
  let goal = "";
  const window = new Window();
  const watch = { seat: { id: "s1", provider: "p", cwd: "/w" }, window, noted: [], get running() { return running; } } as never;
  const assessor = new Assessor({
    sensing: () => ({ spec: shipped, key: "k", brief: brief(goal), rules: {} }),
    done: (_watch, reading) => readings.push({ questions: Object.keys(reading.questions), cost: reading.assessment.cost }),
    failed: () => {},
    fetcher: fetcher as never,
  });
  const of = (view: string) => Object.entries(shipped.questions).filter(([, question]) => question.view === view).map(([name]) => name);
  const sent = (from: number) => bodies.slice(from).map((body) => Object.keys(body.questions).sort());
  window.add(row({ type: "user_message", text: "Fix it" }, 1));
  window.add(row(shell("c1", "ls"), 2));
  assessor.moment(watch, true);
  await wait(20);
  // No claim while the turn runs; a question also reading the instruction is held back only when all it reads is blank.
  assert.deepEqual(sent(0), [of("actions"), of("work"), of("instruction")].map((names) => names.sort()));
  assert.ok(bodies.every((body) => Object.keys(body.questions).every((name) => Object.keys(body.state).length > 0 && shipped.questions[name]!.view !== undefined)));
  assert.ok(Math.abs(readings[0]!.cost! - 0.00003) < 1e-12, "one reading costs what its requests did together");
  assert.deepEqual((bodies[0]!.questions.unsafe_action as { criteria: unknown }).criteria, shipped.questions.unsafe_action!.criteria, "a question's criteria go with it");
  window.add(row({ type: "assistant_message", text: "Fixed, all tests pass", messageId: "m1" }, 3));
  running = false;
  goal = "Totals reflect the discount code";
  const before = bodies.length;
  assessor.moment(watch, true);
  await wait(20);
  assert.deepEqual(sent(before).flat().sort(), Object.keys(shipped.questions).sort(), "a turn that has ended on a claim, with a goal, brings every question back");
  assert.deepEqual(readings.at(-1)!.questions.sort(), Object.keys(shipped.questions).sort(), "the decision is made on what was asked");
  assessor.dispose();
});

test("the step a question was about is found among its view's steps, as one choice over their ids", async () => {
  const bodies: { questions: Record<string, { type: string; criteria: Record<string, null> }> }[] = [];
  const fetcher = async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ answers: { where: { type: "choice", choice: "S7", probabilities: { S6: 0.1, S7: 0.9 }, confidence: 0.8 } }, model: "m" }), text: async () => "" };
  };
  const view = { goal: "g", steps: [{ id: "S6", kind: "ran", command: "ls", result: "ok" }, { id: "S7", kind: "ran", command: "rm -rf /x", result: "ok" }] };
  assert.deepEqual(await pinpoint(shipped, "k", view, shipped.questions.unsafe_action!, "s1", fetcher as never), { id: "S7", p: 0.9 });
  assert.equal(bodies[0]!.questions.where!.type, "choice");
  assert.deepEqual(Object.keys(bodies[0]!.questions.where!.criteria), ["S6", "S7"]);
  assert.equal(await pinpoint(shipped, "k", { steps: [] }, shipped.questions.unsafe_action!, "s1", fetcher as never), undefined, "nothing to point at is no request");
  assert.equal(bodies.length, 1);
});

test("a decision is made on the facts noted when the state was taken, whatever the seat noted while the answer was on its way", async () => {
  let answer: (value: unknown) => void = () => {};
  const fetcher = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: () => new Promise((resolve) => (answer = resolve)), text: async () => "" });
  const noted = [{ kind: "destructive", level: "page" as const, quote: "rm -rf build" }];
  const watch = { seat: { id: "s1", provider: "p", cwd: "/w" }, window: new Window(), noted } as never;
  const readings: { facts: string[] }[] = [];
  const assessor = new Assessor({
    sensing: () => sensing({ a: noul() }),
    done: (_watch, reading) => readings.push({ facts: reading.facts.map((fact) => fact.kind) }),
    failed: () => {},
    fetcher: fetcher as never,
  });
  assessor.moment(watch, true);
  await wait(10);
  noted.length = 0;
  noted.push({ kind: "outside-scope", level: "note" as never, quote: "/etc/hosts" });
  answer({ answers: { a: { type: "noul", noul: 0.9 } }, model: "m" });
  await wait(10);
  assert.deepEqual(readings, [{ facts: ["destructive"] }]);
  assessor.dispose();
});

test("every question the shipped sensor asks carries a label a person can read, and a label is never sent", () => {
  for (const [name, question] of Object.entries(shipped.questions)) {
    assert.equal(typeof question.label, "string", `${name} has no label`);
    assert.ok(question.label!.length > 0 && !question.label!.includes("_"), `${name}'s label reads as a name, not a sentence`);
  }
  assert.deepEqual(sensorProblems("x", { ...shipped, id: "x", questions: { q: { view: "work", instructions: "?", label: 3 } } } as never), ["asks q with a label that is not text"]);
});

test("a script waiting out a busy sensor waits for the answer rather than exiting on the way", () => {
  // A retry's pause did not hold the process open, so the eval scripts exited silently mid-run.
  const script = `
    import { assess } from ${JSON.stringify(join(here, "..", "..", "server", "runtime", "watch", "jev", "sensor.ts"))};
    let calls = 0;
    const fetcher = async () => (++calls === 1
      ? { ok: false, status: 529, headers: { get: () => null }, json: async () => ({}), text: async () => "busy" }
      : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ answers: { a: { type: "noul", noul: 0.4 } }, model: "m" }), text: async () => "" });
    const spec = { model: "m", url: "https://x", timeoutSeconds: 1, retries: 1, questions: { a: { view: "work", instructions: "q" } } };
    console.log((await assess(spec, "k", {}, "s", fetcher)).answers.a);`;
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf-8" }).trim(), "0.4");
});
