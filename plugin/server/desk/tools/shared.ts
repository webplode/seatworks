import { type Kit, can, roleNamed, rolesThatCan } from "../../catalog/kit.ts";
import { uncommittedWork } from "../../catalog/project-files.ts";
import { currentBranch, headSha } from "../../core/git.ts";
import { hash, no, ok, str } from "../context.ts";
import { type Ask, findTask, laneOfLead, loadLedger } from "../ledger.ts";
import { letters } from "../letters.ts";
import { loadConfig } from "../project.ts";
import type { Tool } from "../services.ts";
import { type OwnCopy, statusText } from "../status.ts";

/** Names the roles that do hold the capability, since the kit is data and only the desk has read it. */
export function namedOrNot(kit: Kit, capability: string, named: string, doing: string): string {
  const holders = rolesThatCan(kit, capability).map((role) => role.role);
  if (holders.length === 0) return `No role in this kit can ${doing}.`;
  return `This kit has no ${named} that can ${doing}. These can: ${holders.sort().join(", ")}.`;
}

export const message: Tool = async ({ ctx, roster }, caller, args) => {
  const to = str(args.to);
  const text = str(args.text);
  const ledger = loadLedger(caller.project.state);
  // Keyed by the event, not the words: keyed on text, the same instruction sent again was dropped as a repeat.
  const key = `message:${caller.id}:${hash(to, text)}:${Date.now()}`;
  const unread = (who: string) => `${who} is not seated any more, so a message would wait for nobody.`;
  const settled = (task: { id: string; status: string }) =>
    ["merged", "cut"].includes(task.status) ? `${task.id} is ${task.status === "merged" ? "accepted" : "cut"}, and its Peer has been put away with it.` : undefined;
  const deliver = async (target: string, from: string, who: string): Promise<string> => {
    const reached = await roster.answerQuestion(target, `From ${from}: ${text}`);
    if (reached === "answered") {
      ctx.event(caller.project, { kind: "question.answered", agent: target, by: caller.id });
      return `It was stopped on a question, so this went to ${who} as the answer, and it carries on.`;
    }
    const posted = await ctx.post(target, key, letters.message(from, text), caller.project);
    if (posted === "sent") return `Delivered to ${who}.`;
    if (reached === "waiting") return `Queued for ${who}, which is stopped on a permission only the Human can give; it reads this once that is decided.`;
    return `Queued for ${who}; it reads this as soon as it can take it.`;
  };
  const lane = laneOfLead(ledger, caller.id);
  const task = findTask(ledger, to);
  if (!lane || !task || task.lane !== lane.id || !task.peer) return no(`${to} is not a task in your lane.`);
  const done = settled(task);
  if (done) return no(done);
  if (!(await roster.seated(task.peer))) return no(unread(`The Peer on ${task.id}`));
  return ok(await deliver(task.peer, "your lead", `the Peer on ${task.id}`));
};

export const answer: Tool = async ({ ctx, roster }, caller, args) => {
  const id = str(args.ask).toUpperCase();
  const text = str(args.text);
  const result = await ctx.ledger(caller.project, (ledger): { ask: Ask; waitingRole?: string } | string => {
    caller.revalidate?.();
    const ask = ledger.asks[id];
    if (!ask) return `There is no ask ${id}.`;
    if (ask.status !== "open") return `Ask ${id} is already answered.`;
    if (ask.to !== caller.id && !can(caller.role, "supervise")) return `Ask ${id} was not addressed to you.`;
    ask.status = "answered";
    ask.answer = text;
    return { ask: { ...ask }, waitingRole: ledger.agents[ask.to]?.role };
  });
  if (typeof result === "string") return no(result);
  const { ask } = result;
  const post = async (to: string, key: string, message: string) => {
    const guard = caller.deliveryGuard ? { ...caller.deliveryGuard, workspace: (await roster.look(to)).workspaceId ?? "" } : undefined;
    return ctx.post(to, key, message, caller.project, guard);
  };
  // Answering an ask put to someone else is allowed (the round escalates them), but that seat is told first.
  const waiting = ask.to === caller.id ? undefined : ask.to;
  const by = waiting && can(roleNamed(ctx.kit, result.waitingRole ?? ""), "supervise") ? `${caller.role.label} ${caller.id}` : "the owner";
  if (waiting) await post(waiting, `answeredFor:${ask.id}`, letters.answeredFor(ask, by, can(roleNamed(ctx.kit, result.waitingRole ?? ""), "lead")));
  const posted = await post(ask.from, `answer:${ask.id}`, letters.answered(ask));
  ctx.event(caller.project, { kind: "ask.answered", ask: ask.id, by: caller.id, told: waiting ?? null });
  return ok(`Answered ${ask.id}; the asker ${posted === "sent" ? "has it" : "reads it as soon as it can take it"}.${waiting ? " Whoever it was waiting on has been told what it was answered with." : ""}`);
};

async function ownCopy(root: string): Promise<OwnCopy> {
  const branch = await currentBranch(root);
  return { branch, head: branch ? undefined : (await headSha(root))?.slice(0, 7), work: await uncommittedWork(root) };
}

/** A supervisor also sees the Human's own checkout, read from git only here, when it asks. */
export const status: Tool = async ({ roster }, caller) => {
  const ledger = loadLedger(caller.project.state);
  const seats = new Map((await roster.open()).map((seat) => [seat.id, seat]));
  const lane = can(caller.role, "lead") ? laneOfLead(ledger, caller.id)?.id : undefined;
  const copy = can(caller.role, "supervise") ? await ownCopy(caller.project.root) : undefined;
  return ok(statusText(caller.project, ledger, loadConfig(caller.project.state), seats, Date.now(), { laneId: lane, copy }));
};
