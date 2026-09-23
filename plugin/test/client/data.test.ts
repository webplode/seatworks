import assert from "node:assert/strict";
import { test } from "node:test";
import { type Layer, thinkingInForce, countsInstead, dropMcp, foldRoles, harnessInForce, incidentLines, jevHeader, keptRoles, leaning, modelInForce, modelRow, setAttention, setFlow, setMcp, setRole, setSensorKey, spent, trackRecord, watcherState } from "../../client/data.ts";
import type { WatchIncident, WatchSeat, WatchView } from "../../shared/views.ts";
import { KEPT } from "../../shared/rpc.ts";

const held: Layer = {
  rules: "Keep diffs small.",
  roles: { lead: { harness: "claude", model: "opus", thinking: "high", rules: "Never touch the generated client." } },
  attention: { longTurnMinutes: 30, watch: false },
};

test("changing a seat's agent forgets what was chosen for the old one and keeps what the owner wrote", () => {
  const moved = setRole(held, "lead", { harness: "devin" }, true);
  assert.deepEqual(moved.roles!.lead, { rules: "Never touch the generated client.", harness: "devin" });
  assert.equal(moved.rules, "Keep diffs small.", "what every seat is told is untouched");
  assert.deepEqual(moved.attention, { longTurnMinutes: 30, watch: false }, "and so is everything else in the layer");
});

test("changing a seat's model or thinking keeps the rest of its choice", () => {
  const remodelled = setRole(held, "lead", { model: "other" });
  assert.deepEqual(remodelled.roles!.lead, { harness: "claude", model: "other", thinking: "high", rules: "Never touch the generated client." });
});

test("running the setup screen over a project keeps what it holds, and does not pin the old agent's model on a new one", () => {
  const project: Layer = {
    rules: "Never touch the release branch.",
    mcp: { docs: { enabled: true, connect: { type: "http", url: "https://x", headers: { Authorization: "Bearer SECRET" } } } },
    attention: { longTurnMinutes: 45 },
    roles: { peer: { harness: "claude", model: "claude-opus-5", thinking: "high" } },
  };
  // What the dialog collected: one role moved to another agent. A write is the whole layer.
  const draft: Layer = { roles: { peer: { harness: "devin" } } };
  const folded = foldRoles(project, draft, (role) => project.roles?.[role]?.harness);

  assert.equal(folded.rules, "Never touch the release branch.", "the rule every seat is told survives");
  assert.equal(folded.mcp!.docs!.connect!.headers!.Authorization, "Bearer SECRET", "and so does the token the owner pasted");
  assert.deepEqual(folded.attention, { longTurnMinutes: 45 });
  assert.deepEqual(folded.roles!.peer, { harness: "devin" }, "the model and thinking level picked for the old agent are not kept on the new one");

  const same = foldRoles(project, { roles: { peer: { thinking: "low" } } }, (role) => project.roles?.[role]?.harness);
  assert.deepEqual(same.roles!.peer, { harness: "claude", model: "claude-opus-5", thinking: "low" });
});

test("a role whose agent is not recorded anywhere keeps the model the owner picked for it", () => {
  // A role nobody moved runs the kit's default agent, so no layer names it, yet the owner chose a model.
  const project: Layer = { roles: { peer: { model: "swe-2-medium" } } };
  const draft: Layer = { roles: { peer: { harness: "devin" } } };

  const unknown = foldRoles(project, draft, () => undefined);
  assert.deepEqual(unknown.roles!.peer, { model: "swe-2-medium", harness: "devin" }, "an agent nobody can name is not an agent being replaced");

  const moved = foldRoles(project, { roles: { peer: { harness: "claude" } } }, () => "devin");
  assert.deepEqual(moved.roles!.peer, { harness: "claude" });
});

test("re-pasting a server the owner gave to nobody leaves it given to nobody", () => {
  const reachable = ["supervisor", "lead", "peer", "reviewer"];
  // Unticking the last role writes an empty list; a re-paste to rotate the token once gave the server to all four.
  assert.deepEqual(keptRoles([], reachable), [], "a narrowing to nobody is a narrowing, not an absence");
  assert.deepEqual(keptRoles(undefined, reachable), reachable, "never narrowed is what does mean every reachable role");
  assert.deepEqual(keptRoles(["lead", "peer"], reachable), ["lead", "peer"]);
  assert.deepEqual(keptRoles(["lead", "designer"], reachable), ["lead"], "and a role that cannot reach it is dropped from the narrowing");
});

test("a settings screen offers the agent in force, not the one the kit would have picked", () => {
  const peer = { id: "peer", defaults: { harness: "devin" } };
  const project: Layer = { roles: { peer: { harness: "claude" } } };
  const machine: Layer = { roles: { peer: { harness: "codex" } } };

  // Skipping the two middle layers once showed Devin for a Peer the owner had put on Claude Code.
  assert.equal(harnessInForce(peer, {}, project, machine), "claude", "the project's choice wins");
  assert.equal(harnessInForce(peer, {}, {}, machine), "codex", "then the machine's");
  assert.equal(harnessInForce(peer, {}, {}, {}), "devin", "and the kit's default only when nobody chose");
  assert.equal(harnessInForce(peer, { roles: { peer: { harness: "codex" } } }, project, machine), "codex", "a draft being filled in wins over both");
  assert.equal(harnessInForce(peer, undefined, undefined), "devin", "a layer not read yet is not a choice");
});

test("the model row shows what is in force even when this agent does not list it, and offers a way back", () => {
  const opus = [{ id: "claude-opus-5", label: "Opus 5" }];
  const settled = modelRow("claude-opus-5", opus);
  assert.equal(settled.stray, false);
  assert.deepEqual(settled.options, [{ label: "Opus 5", value: "claude-opus-5" }]);

  // The screen once printed "Opus 5" here, which is not what the seat runs, and rendered no control.
  const wrong = modelRow("swe-2-medium", opus);
  assert.equal(wrong.value, "swe-2-medium", "the seat's own model is what is shown");
  assert.equal(wrong.stray, true);
  assert.deepEqual(wrong.options, [{ label: "Opus 5", value: "claude-opus-5" }, { label: "swe-2-medium", value: "swe-2-medium" }], "and it stays pickable so the owner can move off it");
  assert.equal(modelRow("", opus).stray, false, "nothing chosen is not a stray choice");
});

test("removing a server this layer added forgets it, token and all", () => {
  const held: Layer = {
    rules: "Keep diffs small.",
    mcp: { docs: { enabled: true, label: "Docs", roles: ["lead"], connect: { type: "http", url: "https://x", headers: { Authorization: "Bearer SECRET" } } } },
  };
  const dropped = dropMcp(held, "docs");
  assert.equal(dropped.mcp, undefined, "the entry goes, rather than staying on disk marked removed");
  assert.equal(dropped.rules, "Keep diffs small.", "and nothing else in the layer is touched");
  assert.equal(JSON.stringify(dropped).includes("SECRET"), false, "so the token is really gone");
});

test("a collapsed lane gives up its counts for a Lead that is waiting or gone", () => {
  const lane = (lead: { status: string; waiting: string[] } | null, open = false) => ({ taskCount: 3, open, lead });
  assert.equal(countsInstead(lane({ status: "running", waiting: [] })), true, "the ordinary case is the counts");
  assert.equal(countsInstead(lane({ status: "idle", waiting: [] }, true)), false, "an opened lane shows its Lead and its tasks");
  assert.equal(countsInstead({ taskCount: 0, open: false, lead: { status: "idle", waiting: [] } }), false);

  // Lanes start collapsed, so the Lead's line is the only place a seat waiting on the owner shows.
  assert.equal(countsInstead(lane({ status: "running", waiting: ["Write outside the working copy"] })), false);
  assert.equal(countsInstead(lane({ status: "gone", waiting: [] })), false, "and a Lead that has gone is never news the counts may hide");
  assert.equal(countsInstead(lane(null)), false);
});

test("the model in force follows the resolver: a layer naming another agent drops the models below it", () => {
  const lead = { id: "lead", defaults: { harness: "claude", model: "claude-opus-5" } };
  const machine: Layer = { roles: { lead: { harness: "devin", model: "swe-2-max" } } };
  // The machine's model was chosen for an agent the project has since moved off, so it is not in force.
  assert.equal(modelInForce(lead, {}, { roles: { lead: { harness: "codex" } } }, machine), undefined);
  assert.equal(modelInForce(lead, {}, { roles: { lead: { harness: "claude" } } }, machine), "claude-opus-5", "back on its own agent, the kit's choice there");
  assert.equal(modelInForce(lead, { roles: { lead: { model: "claude-sonnet-5" } } }, undefined, machine), "claude-sonnet-5");
  assert.equal(modelInForce(lead), "claude-opus-5");
});

test("a role that follows another shows that role's agent and model in force until it has its own", () => {
  const watcher = { id: "watcher", follows: "peer", defaults: { harness: "devin", model: "swe-2-max" } };
  const machine: Layer = { roles: { peer: { harness: "claude", model: "claude-opus-5" } } };
  assert.equal(harnessInForce(watcher, {}, {}, machine), "claude", "the Peer's own choice, not the kit's default");
  assert.equal(modelInForce(watcher, {}, {}, machine), "claude-opus-5");
  assert.equal(modelInForce(watcher, { roles: { peer: { model: "claude-sonnet-5" } } }, {}, machine), "claude-sonnet-5", "a Peer being edited in the same draft moves it too");
  const own: Layer = { roles: { watcher: { harness: "codex" } } };
  assert.equal(harnessInForce(watcher, {}, own, machine), "codex", "an agent of its own wins");
  assert.equal(modelInForce(watcher, {}, own, machine), undefined, "and drops what it followed");
  const back: Layer = { roles: { watcher: { harness: "claude" } } };
  assert.equal(modelInForce(watcher, back, own, machine), "claude-opus-5", "coming back to the Peer's agent brings back the Peer's model");
});

test("switching the watch on keeps the rest of the tuning, and the sensor's key is kept by the word the screen holds", () => {
  const on = setAttention(held, { watch: true });
  assert.deepEqual(on.attention, { longTurnMinutes: 30, watch: true }, "the other attention settings are not a casualty of the switch");
  assert.equal(on.rules, "Keep diffs small.");

  // A write is the whole layer, so every helper a section saves through must carry `KEPT` back or the key is lost.
  const screen: Layer = { ...held, sensor: { key: KEPT } };
  const elsewhere: Record<string, Layer> = {
    "a role moved to another agent": setRole(screen, "peer", { harness: "devin" }, true),
    "a server switched on": setMcp(screen, "docs", { enabled: true }),
    "a pasted server forgotten": dropMcp(setMcp(screen, "docs", { enabled: true }), "docs"),
    "the flow switch": setFlow(screen, { live: true }),
    "this card's own switch": setAttention(screen, { watch: true }),
  };
  for (const [what, saved] of Object.entries(elsewhere)) assert.deepEqual(saved.sensor, { key: KEPT }, `${what} carries the key back untouched`);
  assert.deepEqual(setSensorKey(screen, "sk-or-new").sensor, { key: "sk-or-new" }, "a typed key replaces the word");
  const forgotten = setSensorKey(screen, null);
  assert.equal("sensor" in forgotten, false, "forgetting it leaves no block at all, which is what clears the key on disk");
  assert.deepEqual(forgotten.attention, { longTurnMinutes: 30, watch: false }, "and nothing else goes with it");
});

const watching = (over: Partial<WatchView> = {}): WatchView => ({
  by: "jev",
  on: true,
  keyed: true,
  telling: false,
  judgeMinutes: 2,
  failing: null,
  watcher: null,
  lanes: 1,
  seats: [],
  lastRead: null,
  read: { turns: 0, cost: 0 },
  marks: { total: 0, open: 0, useful: 0, noise: 0, unknown: 0 },
  incidents: [],
  trouble: [],
  ...over,
});
const seatOf = (id: string, over: Partial<WatchSeat> = {}): WatchSeat => ({ id, name: `Peer · L1-${id} ${id}`, running: true, lean: null, ...over });
const incident = (over: Partial<WatchIncident> = {}): WatchIncident => ({
  id: "I1",
  title: "Built a stand-in for something that does not exist",
  level: "attend",
  name: "Peer · L1-T1 Pointer",
  minutes: 6,
  quote: "S9 said: patch.js is missing",
  source: "code",
  sure: null,
  told: null,
  lane: "L1",
  held: null,
  ...over,
});

test("the Jev card's header says the one thing to know first: reading, idle, not answering, or no key", () => {
  const reading = jevHeader(watching({ telling: true, lanes: 2, lastRead: 0, read: { turns: 128, cost: 0.015 }, seats: [seatOf("a"), seatOf("b"), seatOf("c", { running: false })] }));
  assert.deepEqual([reading.title, reading.word, reading.tone], ["Jev is watching 2 agents in 2 work streams", "sending notices", "success"]);
  assert.equal(reading.sub, "Last check just now · 128 turns read · $0.015 spent so far");
  const idle = jevHeader(watching({ lastRead: 660, read: { turns: 365, cost: 0.047 } }));
  assert.deepEqual([idle.title, idle.word, idle.tone], ["Nothing is running", "recording only", "muted"]);
  assert.match(idle.sub, /^Jev last checked a turn here 11 hours ago/, "an idle watch says when it last worked, so a dead one is visible");
  const failing = jevHeader(watching({ failing: { minutes: 4, detail: "429 too many requests" } }));
  assert.equal(failing.title, "Jev is not answering");
  assert.match(failing.sub, /429 too many requests\. Built-in checks still run on every turn; anything waiting for Jev's second look is sent after 2 minutes\./);
  const keyless = jevHeader(watching({ keyed: false, on: false }));
  assert.deepEqual([keyless.title, keyless.word, keyless.tone], ["Jev is not watching", "", "warning"]);
});

test("an incident says who raised it and how sure, and where it has got to, in words", () => {
  const jev = { by: "jev" as const, judgeMinutes: 2, failing: null };
  assert.deepEqual(incidentLines(incident({ level: "page", told: "supervisor", minutes: 2 }), jev), { sub: "Peer · L1-T1 Pointer · 2 min ago", source: "built-in check", state: "told the Supervisor", danger: true });
  assert.deepEqual(incidentLines(incident({ source: "jev", sure: { p: 0.86, bar: 0.85 }, told: "lead" }), jev), { sub: "Peer · L1-T1 Pointer · 6 min ago", source: "Jev 86% sure · reports at 85%", state: "told Lead L1", danger: false });
  assert.equal(incidentLines(incident({ held: "awaiting" }), jev).state, "held · Jev takes a second look, up to 2 min");
  assert.equal(incidentLines(incident({ held: "awaiting" }), { ...jev, failing: { minutes: 1, detail: "x" } }).state, "held · Jev is not answering, sent after 2 min");
  const seat = { by: "seat" as const, judgeMinutes: 10, failing: null };
  assert.equal(incidentLines(incident({ held: "awaiting" }), seat).state, "held · waiting for the Watcher, up to 10 min");
  assert.equal(incidentLines(incident({ held: "vetoed" }), seat).state, "held back by the Watcher");
  assert.equal(incidentLines(incident({ source: "watcher" }), seat).source, "noticed by the Watcher");
  assert.equal(incidentLines(incident({ held: "shadow" }), seat).state, "recorded · mail is off");
});

test("what Jev leans towards is listed closest to its bar first, and the seats with nothing leaning are named", () => {
  const seats = [
    seatOf("a", { lean: { title: "Said the work is done", p: 0.41, bar: 0.6 } }),
    seatOf("b"),
    seatOf("c", { lean: { title: "Worked on something it was not asked for", p: 0.62, bar: 0.7 } }),
  ];
  const { leaning: on, quiet } = leaning(seats);
  assert.deepEqual(on.map((seat) => seat.id), ["c", "a"]);
  assert.deepEqual(quiet, ["Peer · L1-b b"]);
});

test("the track record counts useful against noise, and says when there are marks enough to tune by", () => {
  assert.equal(trackRecord({ total: 0, open: 0, useful: 0, noise: 0, unknown: 0 }).title, "Nothing marked yet");
  const some = trackRecord({ total: 18, open: 0, useful: 12, noise: 5, unknown: 1 });
  assert.deepEqual([some.title, some.percent, some.parts], ["12 of 17 marked notices were useful", "71%", [12, 5, 1]]);
  assert.match(some.hint, /with 20 or more marks, run node bin\/calibrate\.ts/);
  assert.match(trackRecord({ total: 21, open: 0, useful: 14, noise: 6, unknown: 1 }).hint, /there are enough marks now/);
});

test("the Watcher seat on the canvas says whether it runs and how many readings wait for it", () => {
  assert.deepEqual(watcherState({ id: "w", status: "running", minutes: 0, queued: 2 }), { state: "running · 2 checks waiting", alive: true });
  assert.deepEqual(watcherState({ id: "w", status: "idle", minutes: 3, queued: 0 }), { state: "idle", alive: true });
  assert.deepEqual(watcherState(null), { state: "not started · starts once a work stream is open", alive: false });
});

test("money is shown in dollars, with enough places that a few cents do not read as nothing", () => {
  assert.equal(spent(0), "nothing yet");
  assert.equal(spent(0.0047), "$0.005");
  assert.equal(spent(0.412), "$0.412");
  assert.equal(spent(12.5), "$12.50");
  assert.doesNotMatch(spent(0.004), /\u00a2/);
});

test("a provider change clears inherited thinking until that provider supplies a default", () => {
  const role = { id: "lead", defaults: { harness: "claude", thinking: "medium" } };
  const machine = { roles: { lead: { harness: "claude", thinking: "high" } } };
  assert.equal(thinkingInForce(role, { roles: { lead: { harness: "codex" } } }, machine), undefined);
  assert.equal(thinkingInForce(role, { roles: { lead: { harness: "codex", thinking: "low" } } }, machine), "low");
  assert.equal(thinkingInForce(role, { roles: { lead: { harness: "claude" } } }, { roles: { lead: { harness: "codex", thinking: "low" } } }), "medium");
});

test("a Seatworks error reads in its own words, without Paseo's request wrapper", async () => {
  const { message } = await import("../../client/data.ts");
  assert.equal(message(new Error("Request failed: Git refused it. requestType=plugin.rpc.invoke.request code=handler_error")), "Git refused it.");
  assert.equal(message(new Error("plain")), "plain");
});
