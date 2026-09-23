import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Run = { code: number; stdout: string; stderr: string };

export function git(cwd: string, args: string[], timeout = 60_000): Promise<Run> {
  return new Promise((resolve) => {
    // core.quotePath=false: otherwise non-ASCII paths come back quoted and octal-escaped and match no owned path.
    execFile("git", ["-C", cwd, "-c", "core.quotePath=false", ...args], { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const run = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return run.code === 0 ? run.stdout.trim() : undefined;
}

export async function headSha(cwd: string, ref = "HEAD"): Promise<string | undefined> {
  const run = await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return run.code === 0 ? run.stdout.trim() : undefined;
}

/** Three states because a failed `status` (dir gone, not a repo, timeout, no git) must not read as dirty. */
export type Cleanliness = "clean" | "dirty" | "unknown";

async function cleanliness(cwd: string, args: string[]): Promise<Cleanliness> {
  const run = await git(cwd, args);
  if (run.code !== 0) return "unknown";
  return run.stdout.trim() === "" ? "clean" : "dirty";
}

/** Tracked files only; untracked files do not count. */
export function cleanState(cwd: string): Promise<Cleanliness> {
  return cleanliness(cwd, ["status", "--porcelain", "--untracked-files=no"]);
}

/** Uncommitted and untracked paths, or undefined when git cannot say; `besides` excuses a change that is nobody's work. */
export async function uncommittedPaths(cwd: string, besides: (path: string) => Promise<boolean> = async () => false): Promise<string[] | undefined> {
  const run = await git(cwd, ["status", "--porcelain"]);
  if (run.code !== 0) return undefined;
  const found: string[] = [];
  for (const line of run.stdout.split("\n").filter(Boolean)) if (!(await besides(line.slice(3)))) found.push(line.slice(3));
  return found;
}

/** Nothing uncommitted or untracked, as a lane takeover requires. */
export async function pristineState(cwd: string, besides?: (path: string) => Promise<boolean>): Promise<Cleanliness> {
  const paths = await uncommittedPaths(cwd, besides);
  return paths === undefined ? "unknown" : paths.length > 0 ? "dirty" : "clean";
}

export async function trackedFiles(cwd: string): Promise<string[]> {
  const run = await git(cwd, ["ls-files", "-z"]);
  return run.code === 0 ? run.stdout.split("\0").filter(Boolean) : [];
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

/** Undefined when git could not answer: zero read as "no commits beyond the lane branch", which is a claim. */
export async function commitsAhead(cwd: string, base: string, branch: string): Promise<number | undefined> {
  const run = await git(cwd, ["rev-list", "--count", `${base}..${branch}`]);
  if (run.code !== 0) return undefined;
  const count = Number(run.stdout.trim());
  return Number.isInteger(count) ? count : undefined;
}

/** Whether everything on `branch` is already in `into` — undefined when git could not say, because a branch is about to be deleted on this answer. */
export async function contains(cwd: string, into: string, branch: string): Promise<boolean | undefined> {
  if (!(await branchExists(cwd, branch))) return undefined;
  const run = await git(cwd, ["rev-list", "--count", `${into}..${branch}`]);
  const count = Number(run.stdout.trim());
  return run.code === 0 && Number.isInteger(count) ? count === 0 : undefined;
}

export async function addWorktree(root: string, path: string, branch: string, base: string): Promise<{ ok: boolean; message: string }> {
  if (!(await branchExists(root, base))) return { ok: false, message: `the base branch ${base} does not exist` };
  if (await branchExists(root, branch)) return { ok: false, message: `the branch ${branch} already exists` };
  const run = await git(root, ["worktree", "add", "-b", branch, path, base], 120_000);
  // git can fail with no output at all (timeout, missing binary); never report an empty reason.
  return { ok: run.code === 0, message: (run.stderr || run.stdout).trim() || `git worktree add exited ${run.code} with nothing to say` };
}

export async function removeWorktree(root: string, path: string | undefined): Promise<void> {
  if (!path) return;
  await git(root, ["worktree", "remove", "--force", path], 60_000);
  await git(root, ["worktree", "prune"], 30_000);
}

export type MergeResult = { ok: true; before: string; after: string } | { ok: false; conflicts: string[]; message: string };

export async function mergeBranch(cwd: string, branch: string, message: string): Promise<MergeResult> {
  const before = await headSha(cwd);
  if (!before) return { ok: false, conflicts: [], message: "the lane working copy has no HEAD" };
  const run = await git(cwd, ["-c", "user.name=seatworks", "-c", "user.email=seatworks@localhost", "merge", "--no-ff", "-m", message, branch], 120_000);
  if (run.code === 0) return { ok: true, before, after: (await headSha(cwd)) ?? before };
  const unmerged = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  const conflicts = unmerged.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  await git(cwd, ["merge", "--abort"]);
  return { ok: false, conflicts, message: (run.stdout + run.stderr).trim().slice(-1500) };
}

export async function resetHard(cwd: string, sha: string): Promise<boolean> {
  return (await git(cwd, ["reset", "--hard", sha])).code === 0;
}

export type Counts = { src: number; test: number; docs: number; files: string[] };

export function kindOf(path: string): "src" | "test" | "docs" {
  if (/(^|\/)(tests?|__tests__|spec|specs)\//i.test(path) || /\.(test|spec)\.[a-z0-9]+$/i.test(path) || /(Test|Tests|IT)\.(java|kt|scala|cs)$/.test(path) || /_test\.(go|py|rb)$/.test(path) || /(^|\/)test_[^/]+\.py$/.test(path)) {
    return "test";
  }
  if (/\.(md|mdx|txt|rst|adoc)$/i.test(path) || /(^|\/)docs?\//i.test(path)) return "docs";
  return "src";
}

/** Uses `-z` so a rename yields both real paths, not the `src/{old.ts => new.ts}` form that matches no owned path. */
export function countNumstat(numstat: string): Counts {
  const counts: Counts = { src: 0, test: 0, docs: 0, files: [] };
  const fields = numstat.split("\0");
  for (let index = 0; index < fields.length; index++) {
    const row = fields[index];
    if (!row?.trim()) continue;
    const [added, removed, inline] = row.split("\t");
    const lines = (Number(added) || 0) + (Number(removed) || 0);
    const paths: string[] = [];
    if (inline?.trim()) paths.push(inline.trim());
    else {
      // A rename or a copy: the two paths follow as their own fields.
      const from = fields[index + 1];
      const to = fields[index + 2];
      if (from) paths.push(from);
      if (to) paths.push(to);
      index += 2;
    }
    for (const path of paths) {
      counts[kindOf(path)] += lines;
      counts.files.push(path);
    }
  }
  return counts;
}

/** Undefined when git could not answer: zeroed counts read as "nothing changed", which is a claim. */
export async function diffCounts(cwd: string, from: string, to: string): Promise<Counts | undefined> {
  const run = await git(cwd, ["diff", "-z", "--numstat", `${from}..${to}`]);
  return run.code === 0 ? countNumstat(run.stdout) : undefined;
}

export function outsideOwned(files: string[], owned: string[]): string[] {
  if (owned.length === 0) return [];
  const prefixes = owned.map((path) => path.replace(/^\.\//, "").replace(/\*+.*$/, ""));
  // On a path boundary: an owned "src/app" is not ownership of "src/apparel/secret.ts".
  return files.filter((file) => !prefixes.some((prefix) => file === prefix || (prefix !== "" && file.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))));
}

export type LandResult = { landed: boolean; how: string };

/** Whether `base` is already contained in `branch`, so landing is a fast-forward rather than a merge. */
export async function isAncestor(root: string, base: string, branch: string): Promise<boolean> {
  return (await git(root, ["merge-base", "--is-ancestor", base, branch])).code === 0;
}

/** Fast-forwards `base` to `branch`: merges are made and gated in the lane's copy, so what lands is what the gate saw. */
export async function landLane(root: string, base: string, branch: string): Promise<LandResult> {
  if (!(await isAncestor(root, base, branch))) return { landed: false, how: `${branch} does not contain ${base}, so landing it would be a merge nobody has gated` };
  if ((await currentBranch(root)) === base) {
    const state = await cleanState(root);
    if (state === "dirty") return { landed: false, how: `the main working copy on ${base} has uncommitted changes` };
    if (state === "unknown") return { landed: false, how: `git could not read the main working copy at ${root}` };
    const run = await git(root, ["merge", "--ff-only", branch]);
    return run.code === 0 ? { landed: true, how: `fast-forwarded ${base} in the main working copy` } : { landed: false, how: run.stderr.trim() || "fast-forward failed" };
  }
  const used = await git(root, ["worktree", "list", "--porcelain"]);
  if (used.stdout.split("\n").some((line) => line.trim() === `branch refs/heads/${base}`)) {
    return { landed: false, how: `${base} is checked out in another working copy` };
  }
  const run = await git(root, ["branch", "-f", base, branch]);
  return run.code === 0 ? { landed: true, how: `moved ${base} to ${branch}` } : { landed: false, how: run.stderr.trim() || "branch update failed" };
}

export function gitCommonDir(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function excludeFromGit(repo: string, pattern: string): void {
  const common = gitCommonDir(repo);
  if (!common) return;
  try {
    const file = join(common, "info", "exclude");
    const current = existsSync(file) ? readFileSync(file, "utf-8") : "";
    if (current.split(/\r?\n/).includes(pattern)) return;
    mkdirSync(join(common, "info"), { recursive: true });
    appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
  } catch {}
}
