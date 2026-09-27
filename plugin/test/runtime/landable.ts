import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { contracts } from "../../shared/rpc.ts";
import { harness } from "./harness.ts";

/**
 * A lane with a gate that passes, one commit of `files` on it and a READY from its Lead between turns, whose Human asked to
 * be asked first about `askFirst`: in the loop by default when they did.
 */
export async function laneWith(
  files: Record<string, string>,
  askFirst: string[] = [],
  { isolate = false, hitl = askFirst.length > 0 } = {},
) {
  const h = harness();
  h.projectSettings({ hitl: { on: hitl } });
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "set_project", { base: "main", gate: "true", askFirst });
  const opened = await h.call(sup, "supervisor", "open_lane", {
    title: "Cart",
    outcome: "a cart",
    acceptance: ["a"],
    outOfScope: ["the rest"],
    writeSet: ["a.txt", "src/**"],
    isolate,
  });
  assert.equal(opened.ok, true, opened.text);
  const lane = h.ledger().lanes.L1!;
  const work = (more: Record<string, string>) => {
    for (const [path, text] of Object.entries(more)) {
      mkdirSync(dirname(join(lane.worktree!, path)), { recursive: true });
      writeFileSync(join(lane.worktree!, path), text);
    }
    h.git(lane.worktree!, "add", "-A");
    h.git(lane.worktree!, "commit", "-qm", "work");
  };
  work(files);
  await h.call(lane.lead!, "lead", "report", { summary: "done", ready: true });
  h.agents.get(lane.lead!)!.status = "idle";
  const land = () => h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  return {
    h,
    sup,
    lane,
    work,
    land,
    onMain: (path: string) => h.git(h.root, "ls-tree", "--name-only", "-r", "main").split("\n").includes(path),
  };
}

export const risky = { "src/auth/login.ts": "export const login = 1;\n" };

export const asked = "It changes src/auth/login.ts, under src/auth, which the Human asked to be asked about first.";

/** The Human's word on a held landing, as the panel sends it; what the desk answered, refusal or not. */
export async function decide(h: ReturnType<typeof harness>, approve: boolean, note: string): Promise<string> {
  const answer = await h.rpc(contracts.landDecide, { project: h.project.slug, lane: "L1", approve, note });
  return "decided" in answer ? answer.decided : answer.error;
}
