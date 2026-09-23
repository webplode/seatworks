import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

export type LaneReport = { ready: boolean; gate?: boolean; summary?: string };

/** The latest report each Lead gave on its lane, from the tail of the project's event log. */
export function laneReports(state: string, tailBytes = 512 * 1024): Map<string, LaneReport> {
  const reports = new Map<string, LaneReport>();
  const file = join(state, "events.log");
  if (!existsSync(file)) return reports;
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    for (const line of lines) {
      if (!line.includes('"lane.report"')) continue;
      try {
        const event = JSON.parse(line) as { kind?: string; lane?: string; ready?: boolean; gate?: boolean; summary?: string };
        if (event.kind === "lane.report" && event.lane) reports.set(event.lane, { ready: event.ready === true, gate: event.gate, summary: event.summary });
      } catch { /* a torn line at the tail */ }
    }
  } finally { closeSync(fd); }
  return reports;
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();

/** "4 files changed, 395 insertions(+), 96 deletions(-)" as "4 files · +395 −96", or null when git cannot say. */
export function diffStat(cwd: string, base: string, branch: string): string | null {
  try {
    const raw = git(cwd, ["diff", "--shortstat", `${base}...${branch}`]);
    if (!raw) return "No changes against the base branch";
    const n = (re: RegExp) => Number(raw.match(re)?.[1] ?? 0);
    const files = n(/(\d+) files? changed/);
    return `${files} ${files === 1 ? "file" : "files"} · +${n(/(\d+) insertions?/)} −${n(/(\d+) deletions?/)}`;
  } catch { return null; }
}

const TEAM_FILES = ["AGENTS.md", "CLAUDE.md"];

/** The team instruction files Seatworks wrote into the project that git does not have committed yet. */
export function uncommittedTeamFiles(root: string): string[] {
  let status: string;
  try { status = git(root, ["status", "--porcelain", "--", ...TEAM_FILES]); } catch { return []; }
  if (!status) return [];
  return TEAM_FILES.filter((name) => status.split("\n").some((line) => line.slice(3) === name) && readText(join(root, name)).includes("seatworks:begin"));
}

function readText(file: string): string { try { return readFileSync(file, "utf8"); } catch { return ""; } }

/** Commit only the team instruction files, never anything else the Human has staged or changed. */
export function commitTeamFiles(root: string): { committed: string[] } {
  const files = uncommittedTeamFiles(root);
  if (!files.length) return { committed: [] };
  try { git(root, ["var", "GIT_AUTHOR_IDENT"]); }
  catch { throw new Error("Git doesn't know who you are in this repository yet, so it can't sign the commit. Set user.name and user.email (git config), then press Commit again."); }
  const tracked = files.filter((name) => { try { git(root, ["ls-files", "--error-unmatch", "--", name]); return true; } catch { return false; } });
  git(root, ["add", "--", ...files]);
  try {
    execFileSync("git", ["commit", "--only", "-m", "chore: add Seatworks team instructions", "--", ...files], { cwd: root, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // Leave the index as it was: new files unstaged again, tracked ones back to HEAD.
    const added = files.filter((name) => !tracked.includes(name));
    try { if (added.length) git(root, ["rm", "--cached", "-q", "--", ...added]); if (tracked.length) git(root, ["reset", "-q", "--", ...tracked]); } catch { /* best effort */ }
    const detail = (error as { stderr?: string }).stderr?.trim().split("\n").slice(-3).join(" ") ?? String(error);
    throw new Error(`Git refused the commit: ${detail.slice(0, 300)}`);
  }
  return { committed: files };
}
