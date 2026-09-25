import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointMode } from "../catalog/team.ts";
import type { Project } from "./project.ts";
import { appendRecord } from "./records.ts";

/** One time a checkpoint ran: what it was run on, what it found, and what it decided, whether or not that held anything. */
export type Run = {
  checkpoint: "plan" | "land";
  mode: CheckpointMode;
  lane: string;
  by: string;
  decision: "pass" | "hold" | "ask" | "approved" | "sent back";
  findings: string[];
  /** On a decision, how long what it held waited for it. */
  waitedMs?: number;
};

/** Every run is kept, passes too: they are the count a shadow period is read against before the check is turned on. */
export function keepRun(project: Project, run: Run): void {
  appendRecord(project.state, "checkpoints", `${JSON.stringify({ at: new Date().toISOString(), ...run })}\n`);
}

type Logged = Run & { at: string };

/** Every run the log holds since it last rolled; a line cut short by a stop mid-write is skipped, not allowed to take the status page down. */
function readRuns(project: Project): Logged[] {
  const file = join(project.state, "checkpoints.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Logged];
      } catch {
        return [];
      }
    });
}

/** What the log since it last rolled says of one checkpoint. */
export function runsOf(project: Project, checkpoint: Run["checkpoint"]): { runs: number; held: number; asked: number; last?: Logged } {
  const runs = readRuns(project).filter((run) => run.checkpoint === checkpoint && ["pass", "hold", "ask"].includes(run.decision));
  return { runs: runs.length, held: runs.filter((run) => run.decision === "hold").length, asked: runs.filter((run) => run.decision === "ask").length, last: runs.filter((run) => run.decision !== "pass").at(-1) };
}

const JUDGED_AFTER = 30;
const TOLERATED_A_DAY = 2;
const STAMPED_AFTER = 20;
const QUICK_MS = 10_000;

/**
 * What a checkpoint's log says to whoever decides its mode. In shadow: whether it has run enough to judge, and what it
 * would have stopped, "ready" once that is often enough to learn from and rare enough to live with. On: how its holds
 * were decided, "stamped" when the last twenty were all approved, since a gate nobody sends back through tells nothing.
 */
export function digestOf(project: Project, checkpoint: Run["checkpoint"], mode: CheckpointMode, now = Date.now()): { lines: string[]; state?: "ready" | "stamped" } {
  const runs = readRuns(project).filter((run) => run.checkpoint === checkpoint);
  if (mode === "shadow") {
    const checked = runs.filter((run) => ["pass", "hold", "ask"].includes(run.decision));
    if (checked.length < JUDGED_AFTER) return { lines: [`Not enough yet to judge: ${checked.length} of the ${JUDGED_AFTER} runs it takes.`], state: undefined };
    const stopped = checked.filter((run) => run.decision !== "pass");
    const days = Math.max(1, Math.round((now - Date.parse(checked[0]!.at)) / 86_400_000));
    const daily = Number((stopped.length / days).toFixed(1));
    const latest = stopped.slice(-3).reverse().map((run) => `${run.lane}: ${run.findings[0] ?? "no reason recorded"}`);
    const verdict = daily > TOLERATED_A_DAY ? "It would stop work more than twice a day: narrow what it stops (risky, not every) before turning it on." : "If most of those deserved a look, it is ready to turn on.";
    return {
      lines: [`Turned on, it would have stopped work ${stopped.length} times in ${checked.length} runs over ${days} day${days === 1 ? "" : "s"} (${daily} a day).`, `The latest it would have stopped: ${latest.join(" ") || "none"} ${verdict}`],
      state: daily > TOLERATED_A_DAY ? undefined : "ready",
    };
  }
  if (mode !== "on") return { lines: [], state: undefined };
  const decided = runs.filter((run) => run.decision === "approved" || run.decision === "sent back");
  if (decided.length === 0) return { lines: ["Nothing decided yet."], state: undefined };
  const approved = decided.filter((run) => run.decision === "approved").length;
  const waits = decided.map((run) => run.waitedMs ?? 0).sort((a, b) => a - b);
  const quick = waits.filter((ms) => ms < QUICK_MS).length;
  const lines = [`${decided.length} decided: ${approved} approved, ${decided.length - approved} sent back; a median wait of ${Math.round(waits[Math.floor(waits.length / 2)]! / 60_000)} min; ${quick} decided within 10 seconds of being held.`];
  const streak = decided.length - 1 - decided.findLastIndex((run) => run.decision === "sent back");
  if (streak < STAMPED_AFTER) return { lines, state: undefined };
  lines.push(`The last ${streak} were all approved, so it likely sends back fewer than ${Math.round(300 / streak)}% (3 in ${streak}) of what it holds: it may be adding nothing. Hold less, or move it back to shadow.`);
  return { lines, state: "stamped" };
}
