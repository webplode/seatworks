import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitTeamFiles, diffStat, laneReports, uncommittedTeamFiles } from "../../server/runtime/landing.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-landing-"));
  git(dir, "init", "-q", "-b", "main"); writeFileSync(join(dir, "a.txt"), "a\n"); git(dir, "add", "."); git(dir, "commit", "-qm", "init");
  return dir;
};

test("the latest report per lane wins and torn lines are skipped", () => {
  const state = mkdtempSync(join(tmpdir(), "sw-events-"));
  appendFileSync(join(state, "events.log"), [
    JSON.stringify({ kind: "lane.report", lane: "L1", ready: false }),
    "{torn",
    JSON.stringify({ kind: "lane.report", lane: "L1", ready: true, gate: true, summary: "ok" }),
    JSON.stringify({ kind: "gate.passed", lane: "L1" }),
  ].join("\n") + "\n");
  assert.deepEqual(laneReports(state).get("L1"), { ready: true, gate: true, summary: "ok" });
  assert.equal(laneReports(join(state, "missing")).size, 0);
});

test("diffStat reads the branch against its base", () => {
  const dir = repo();
  git(dir, "checkout", "-qb", "work"); writeFileSync(join(dir, "b.txt"), "b\nc\n"); git(dir, "add", "."); git(dir, "commit", "-qm", "b");
  assert.equal(diffStat(dir, "main", "work"), "1 file · +2 −0");
  assert.equal(diffStat(dir, "main", "nope"), null);
});

test("only the team files with the Seatworks block are committed, nothing else staged", () => {
  const dir = repo();
  writeFileSync(join(dir, "AGENTS.md"), "# mine\n<!-- seatworks:begin -->\nteam\n<!-- seatworks:end -->\n");
  writeFileSync(join(dir, "CLAUDE.md"), "no block here\n");
  writeFileSync(join(dir, "a.txt"), "changed\n"); git(dir, "add", "a.txt");
  assert.deepEqual(uncommittedTeamFiles(dir), ["AGENTS.md"]);
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t"; process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@t";
  assert.deepEqual(commitTeamFiles(dir).committed, ["AGENTS.md"]);
  assert.equal(git(dir, "show", "--name-only", "--format=", "HEAD").trim(), "AGENTS.md");
  assert.match(git(dir, "status", "--porcelain"), /^M  a\.txt/m);
  assert.deepEqual(uncommittedTeamFiles(dir), []);
});

test("without a git identity nothing is staged and the Human is told what to set", () => {
  const dir = repo();
  writeFileSync(join(dir, "AGENTS.md"), "<!-- seatworks:begin -->\nteam\n<!-- seatworks:end -->\n");
  const env = { ...process.env };
  for (const key of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete process.env[key];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"; process.env.GIT_CONFIG_NOSYSTEM = "1";
  // Without this git makes up user@host when the host name has a domain, which depends on the network.
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" });
  try {
    assert.throws(() => commitTeamFiles(dir), /user\.name and user\.email/);
    assert.match(git(dir, "status", "--porcelain"), /^\?\? AGENTS\.md/m);
  } finally { process.env = env; }
});
