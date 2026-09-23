import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentBranch, headSha } from "../../core/git.ts";
import { workState } from "../../catalog/project-files.ts";
import { type Args, hash, no, ok, str } from "../context.ts";
import { taskGate } from "../gates.ts";
import { type Ask, type Task, loadLedger, nextAskId, taskOfPeer } from "../ledger.ts";
import { clip, letters } from "../letters.ts";
import type { Tool } from "../services.ts";

function handbackBody(task: Task, args: Args, commit: string | undefined, uncommitted: boolean): { outcome: string; body: string } {
  if (task.kind === "review") {
    const outcome = str(args.verdict) || "changes";
    return { outcome, body: [`Verdict: ${outcome}`, "", str(args.findings) || "No findings given.", "", `Checks: ${str(args.checks) || "not given"}`].join("\n") };
  }
  const outcome = str(args.outcome) || "complete";
  const lines = [
    `Outcome: ${outcome}`,
    `Commit: ${commit ?? "none"}${uncommitted ? " (the working copy still has uncommitted changes)" : ""}`,
    "",
    str(args.summary) || "No summary given.",
    "",
    `Checks: ${str(args.checks) || "not given"}`,
    `Left undone: ${str(args.leftUndone) || "nothing"}`,
    `Discovered: ${str(args.discovered) || "nothing"}`,
  ];
  return { outcome, body: lines.join("\n") };
}

export const done: Tool = async ({ ctx, roster }, caller, args) => {
  const { project } = caller;
  const ledger = loadLedger(project.state);
  const task = taskOfPeer(ledger, caller.id);
  if (!task) return no("No task is assigned to you.");
  if (["merged", "cut"].includes(task.status)) return no(`This task is already ${task.status === "merged" ? "accepted" : "cut"}; there is nothing to hand back.`);
  const review = task.kind === "review";
  const commit = review ? undefined : str(args.commit) || (task.worktree ? await headSha(task.worktree) : undefined);
  // Only what git actually said: a copy it could not read is not a copy with work left in it.
  const uncommitted = !review && task.worktree ? (await workState(task.worktree)) === "dirty" : false;
  const handed = handbackBody(task, args, commit, uncommitted);
  const { outcome } = handed;
  // Gated at hand-back so the Lead has the verdict in time; gating after accept undid a merge already chosen.
  const run = !review && task.worktree ? await taskGate(project, task.id, task.worktree) : undefined;
  const body = run
    ? `${handed.body}\n\nGate: ${run.ok ? run.note : `${run.note}. This is evidence for your decision, not a decision.\n\n${run.tail}\n\nFull log: ${run.logFile}`}`
    : handed.body;
  const file = join(project.state, "handbacks", `${task.id}-${Date.now()}.md`);
  mkdirSync(join(project.state, "handbacks"), { recursive: true });
  writeFileSync(file, `# ${task.id} ${task.title}\n\n${body}\n`);
  // Decided under the lock: an accept or cut can land during the gate, and `done` over `queued` made the merge queue skip it.
  const already = await ctx.ledger(project, (current) => {
    const entry = current.tasks[task.id];
    if (!entry) return "gone";
    if (["queued", "merging", "merged", "cut"].includes(entry.status)) return entry.status;
    entry.status = "done";
    entry.silent = 0;
    entry.handback = { file, outcome, commit, summary: clip(str(args.summary) || str(args.findings), 400), at: Date.now(), ...(run ? { gate: { ok: run.ok, note: run.note } } : {}) };
    return undefined;
  });
  if (already) {
    return no(
      already === "queued" || already === "merging"
        ? `${task.id} is already accepted and waiting to be merged; handing it back again would take it out of the queue. End your turn.`
        : `${task.id} is already ${already === "merged" ? "accepted" : already}; there is nothing to hand back.`,
    );
  }
  const heading = review ? { ...task, title: task.of ? `review of ${task.of}` : `review: ${task.title}` } : task;
  // A Lead no longer seated would never read it; the level above is told instead and can seat one.
  const lead = ledger.lanes[task.lane]?.lead;
  const reader = lead && (await roster.seated(lead)) ? lead : await roster.supervisorFor(project, ledger.lanes[task.lane]?.opener);
  await ctx.post(reader, `done:${task.id}:${hash(body)}`, letters.handback(heading, file, body, caller.id), caller.project);
  ctx.event(project, { kind: review ? "review.done" : "task.done", task: task.id, outcome, commit });
  // A commit made off the branch (mid-bisect) belongs to no branch and goes with the copy; said while fixable.
  const branch = review ? undefined : ledger.lanes[task.lane]?.branch;
  const meant = task.mode === "parallel" ? task.branch : branch;
  const adrift = !review && meant && task.worktree ? (await currentBranch(task.worktree)) !== meant : false;
  const reminder = uncommitted
    ? " Your working copy still has uncommitted changes: commit them before ending your turn."
    : adrift
      ? ` Your working copy is not on ${meant} any more, so anything you committed is on no branch and will be collected. Put it back — after a bisect that is git bisect reset — and commit there before your turn ends.`
      : "";
  return ok(`Handed back.${reminder} End your turn now; if anything changes you will get a message.`);
};

export const ask: Tool = async ({ ctx, roster }, caller, args) => {
  const question = str(args.question);
  const { project } = caller;
  const ledger = loadLedger(project.state);
  const task = taskOfPeer(ledger, caller.id);
  const lane = task ? ledger.lanes[task.lane] : undefined;
  if (!task || !lane?.lead) return no("Nobody is assigned to answer you; end your turn with the question.");
  // A gone Lead would never answer; it goes up a level instead, and the Peer is told so.
  const to = (await roster.seated(lane.lead)) ? lane.lead : await roster.supervisorFor(project, lane.opener);
  if (!to) return no("Your lead is not there and nobody above it is either, so nobody can answer now. Carry on with your default where you can, and end your turn with the question.");
  const tried = str(args.tried);
  const entry = await ctx.ledger(project, (current) => {
    const created: Ask = {
      id: nextAskId(current),
      from: caller.id,
      fromRole: caller.role.role,
      to,
      lane: lane.id,
      task: task.id,
      kind: "question",
      text: tried ? `${question}\n\nTried: ${tried}` : question,
      status: "open",
      openedAt: Date.now(),
      reminders: 0,
    };
    current.asks[created.id] = created;
    return { ...created };
  });
  await ctx.post(to, `ask:${entry.id}`, letters.askTo(entry, `the Peer on ${task.id} (${task.title})`), caller.project);
  ctx.event(project, { kind: "ask.opened", ask: entry.id, from: caller.id, to });
  return ok(`Asked as ${entry.id}${to === lane.lead ? "" : ", of the owner, because your lead is not there"}. End your turn; the answer arrives as a message.`);
};
