import { type Caller, no, ok, str } from "../context.ts";
import type { Team } from "../../catalog/team.ts";
import { type Incident, awaitsWatcher, loadIncidents } from "../incidents.ts";
import { loadLedger, taskOfPeer } from "../ledger.ts";
import { WATCHER_JUDGED, judge as judgeIncidents, notice } from "../notice.ts";
import type { Tool } from "../services.ts";
import { HELD } from "./incidents.ts";
import { mask } from "../../runtime/watch/mask.ts";
import { shownAs } from "../../runtime/watch/seat/reader.ts";

function state(item: Incident | undefined): string {
  if (item?.told !== undefined) return "whoever answers for that seat has been told";
  return item?.held ? `it is recorded, not sent: ${HELD[item.held] ?? item.held}` : "it is recorded";
}

/** The agent and model the Watcher runs, which is what its judgement is filed under. */
function judgedBy(caller: Caller, team: Team): string {
  const seat = team.roles[caller.role.role];
  return seat ? `${seat.harness.id}/${seat.model?.id ?? ""}` : caller.role.role;
}

/** A Watcher still finishing its turn after the watch went to Jev reports into nothing. */
function notBySeat(services: Parameters<Tool>[0], caller: Caller): string | undefined {
  return services.ctx.team(caller.project).attention.by === "seat" ? undefined : "The watch on this project is by Jev now, so nothing a Watcher reports is taken. There is nothing more to do.";
}

/** Keeps the pointed-at step's words, not the Watcher's, minus the reading's number, so a noise mark holds on a re-read. */
export const raise: Tool = async (services, caller, args) => {
  const off = notBySeat(services, caller);
  if (off) return no(off);
  const { ctx, roster } = services;
  const kinds = ctx.kit.watcher?.kinds ?? {};
  const kind = str(args.kind);
  const ref = str(args.step);
  const found = kinds[kind];
  if (!found) return no(`${kind || "That"} is not a kind you raise. You raise ${Object.keys(kinds).join(", ") || "nothing in this kit"}.`);
  const sent = ctx.sent(caller.id, ref);
  if (!sent) return no(`${ref || "That"} is not a step a reading sent you. Give the ref as the reading wrote it, like R3.S5. A reading sent before the desk restarted cannot be raised against; the next one carries what is still there.`);
  if (!(await roster.seated(sent.seat.id))) {
    // A Peer let go once its work was accepted still has a Lead answering for that work until the lane closes.
    const ledger = loadLedger(caller.project.state);
    const task = taskOfPeer(ledger, sent.seat.id);
    if (task === undefined || ledger.lanes[task.lane]?.status !== "open") return no(`${sent.seat.id} has gone, so nothing raised about it would reach anyone.`);
  }
  const quote = sent.text.replace(/^R\d+\./, "");
  const { opened, place } = await notice(services, caller.project, sent.seat, [{ kind, level: found.level, quote, facts: [], by: "watcher" }]);
  ctx.event(caller.project, { kind: "watch.raised", agent: caller.id, seat: sent.seat.id, finding: kind, step: ref, why: mask(str(args.why)) });
  const item = Object.values(loadIncidents(caller.project.state).items).find((entry) => entry.open && entry.seat === sent.seat.id && entry.kind === kind && entry.by === "watcher");
  // A sighting leaves its words on the incident it joins; one settled as noise leaves them nowhere.
  if (!item || (item.quote !== quote && item.later !== quote)) return ok(`Not raised: ${kind} on ${place.where} in these words was marked noise before.`);
  return ok(opened.length > 0 ? `Raised ${item.id}, ${kind} on ${place.where}: ${state(item)}.` : `${item.id} already stands for ${kind} on ${place.where}; this is counted as seen again, and ${state(item)}.`);
};

/** No probability is given, so it is filed with p 1 for confirms and 0 for vetoes; the reason stays on the incident, never sent. */
export const judge: Tool = async (services, caller, args) => {
  const off = notBySeat(services, caller);
  if (off) return no(off);
  const { ctx } = services;
  const named = str(args.incident);
  // One of the two: the desk holds every call to the schema before it gets here.
  const says = str(args.says) as "confirms" | "vetoes";
  const [, id = named, count] = /^(I\d+)\.(\d+)$/.exec(named) ?? [];
  const item = loadIncidents(caller.project.state).items[id];
  if (!item) return no(`There is no incident ${id} in this project.`);
  if (count === undefined) return no(`Give the incident as the reading wrote it, like ${shownAs(item)}: its id and how many times it had been seen when you read it.`);
  const judges = ctx.kit.watcher?.judges ?? [];
  if (!judges.includes(item.kind)) return no(`${id} is ${item.kind}, which is not one you judge. You judge ${judges.join(", ") || "nothing in this kit"}.`);
  if (Number(count) !== item.count) return no(`${id} has been seen again since the reading you judged it from, so that judgement is about words it no longer stands on. A reading carries it again as ${shownAs(item)}.`);
  if (!awaitsWatcher(item, judges)) return no(`${id} no longer waits for a judgement: ${!item.open ? "it is closed" : item.told !== undefined ? "it has been told" : item.sensor ? "it has been judged" : "it is not at attention level"}.`);
  const seat = { id: item.seat, provider: item.provider ?? "" };
  const verdict = { kind: item.kind, question: WATCHER_JUDGED, p: says === "confirms" ? 1 : 0, model: judgedBy(caller, ctx.team(caller.project)), says, why: mask(str(args.why)) };
  await judgeIncidents(services, caller.project, seat, [verdict], Date.now(), { id, count: Number(count) });
  const after = loadIncidents(caller.project.state).items[id];
  if (after?.sensor?.question !== WATCHER_JUDGED || after.sensor.says !== says || after.sensor.why !== verdict.why) {
    return no(`${id} changed while you judged it: it was seen again, judged or told meanwhile. A reading carries it again if it still waits for you.`);
  }
  return ok(`${id} ${says === "confirms" ? "confirmed" : "vetoed"}: ${state(after)}.`);
};
