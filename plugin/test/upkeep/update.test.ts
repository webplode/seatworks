import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type UpdateContext, applyUpdate, checkUpdate } from "../../server/upkeep/update.ts";
import { tempDir } from "../tempdir.ts";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
/** Piped: git warns on stderr when it clones the empty origin, and a failure still carries what it said. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf-8", stdio: "pipe" }).trim();

function commit(dir: string, files: Record<string, string>, subject: string): void {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", subject);
}

/** A checkout following origin/main, and another clone that pushes to it. */
function world() {
  const origin = tempDir("sw3-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const upstream = tempDir("sw3-up-");
  git(upstream, "clone", "-q", origin, ".");
  git(upstream, "checkout", "-q", "-b", "main");
  commit(
    upstream,
    { "paseo-plugin.json": '{"requirements":{"paseo":">=0.8.0 <0.9.0"}}', "package.json": '{"version":"2.0.0"}' },
    "Start",
  );
  git(upstream, "push", "-q", "origin", "main");
  const dir = tempDir("sw3-plugin-");
  git(dir, "clone", "-q", origin, ".");
  const calls = { install: 0, reload: 0 };
  let installFails: string | undefined;
  const ctx: UpdateContext = {
    dir,
    managedRoot: "/nowhere/.paseo/plugins",
    busy: [],
    install: async () => {
      calls.install++;
      return installFails;
    },
    reload: () => void calls.reload++,
  };
  const publish = (files: Record<string, string>, subject: string) => {
    commit(upstream, files, subject);
    git(upstream, "push", "-q", "origin", "main");
  };
  return { dir, ctx, calls, publish, failInstall: (why: string) => (installFails = why) };
}

test("check says where the checkout stands and what the update will need, and moves nothing", async () => {
  const { dir, ctx, publish } = world();
  const before = git(dir, "rev-parse", "HEAD");
  publish({ "a.txt": "a" }, "Add a");
  const local = await checkUpdate(ctx, false);
  assert.deepEqual(
    [local.version, local.behind, local.fetched],
    ["2.0.0", 0, false],
    "the version shows without asking the remote, and what is behind is as of the last fetch",
  );
  assert.match(local.date ?? "", /^\d{4}-\d{2}-\d{2}$/);

  publish(
    { "package.json": '{"dependencies":{"zod":"4"}}', "paseo-plugin.json": '{"requirements":{"paseo":">=0.9.0"}}' },
    "Need zod and a newer Paseo",
  );
  const view = await checkUpdate(ctx);
  assert.deepEqual([view.behind, view.ahead, view.blocked], [2, 0, null]);
  assert.deepEqual(
    view.commits.map((entry) => entry.subject),
    ["Need zod and a newer Paseo", "Add a"],
  );
  assert.deepEqual([view.installs, view.paseo], [true, ">=0.9.0"]);
  assert.equal(git(dir, "rev-parse", "HEAD"), before);

  publish({ "package.json": "{ not json" }, "Break the package");
  const broken = await checkUpdate(ctx);
  assert.deepEqual(
    [broken.behind, broken.next, broken.installs],
    [3, null, true],
    "a package that does not parse is a change to install from, not a check that throws",
  );

  const managed = await checkUpdate({
    ...ctx,
    dir: "/home/me/.paseo/plugins/seatworks-v3/abc/checkout/plugin",
    managedRoot: "/home/me/.paseo/plugins",
  });
  assert.equal(
    managed.blocked,
    "Paseo installed this copy from Git: run `paseo plugin update seatworks-v3 --ref <branch>`, naming the branch it came from, since without --ref Paseo takes the remote's default branch.",
    "a copy Paseo installed from Git is left to Paseo's own update",
  );
});

test("update moves the checkout forward only when it safely can, installs only when the packages changed, and otherwise moves nothing and reloads nothing", async () => {
  const { dir, ctx, calls, publish, failInstall } = world();
  publish({ "a.txt": "a" }, "Add a");
  await applyUpdate(ctx);
  assert.deepEqual(calls, { install: 0, reload: 1 }, "moved forward and reloaded, with nothing to install");
  publish({ "package.json": '{"version":"2.0.1"}' }, "Raise the version");
  await applyUpdate(ctx);
  assert.deepEqual(calls, { install: 0, reload: 2 }, "a raised version asks for no package");

  publish({ "package.json": '{"dependencies":{"zod":"4"}}' }, "Need zod");
  const waiting = git(dir, "rev-parse", "HEAD");
  const seated = { ...ctx, busy: ["shop-abc123 3 seats", "api-def456 1 seat"] };
  const stop = "Stop every seat first: shop-abc123 3 seats, api-def456 1 seat.";
  assert.equal((await checkUpdate(seated)).blocked, stop, "said before the owner asks for it, by the check itself");
  assert.equal((await applyUpdate(seated)).blocked, stop, "a seat keeps the version it started with");
  assert.equal(git(dir, "rev-parse", "HEAD"), waiting);
  const view = await applyUpdate(ctx);
  assert.equal(view.updated?.to, git(dir, "rev-parse", "--short", "HEAD"));
  assert.equal(git(dir, "log", "-1", "--format=%s"), "Need zod");
  assert.deepEqual(calls, { install: 1, reload: 3 });

  const installed = git(dir, "rev-parse", "HEAD");
  publish({ "package.json": '{"dependencies":{"nope":"1"}}' }, "Need nope");
  failInstall("404 nope");
  assert.match((await applyUpdate(ctx)).blocked ?? "", /npm install failed, so the checkout is back on \w+: 404 nope/);
  assert.equal(git(dir, "rev-parse", "HEAD"), installed, "an install that fails puts the checkout back where it was");

  writeFileSync(join(dir, "package.json"), '{"mine":true}');
  assert.equal((await applyUpdate(ctx)).blocked, "It has local changes, so it does not update itself.");
  git(dir, "checkout", "-q", "--", "package.json");
  commit(dir, { "b.txt": "b" }, "Mine");
  assert.match((await applyUpdate(ctx)).blocked ?? "", /has 1 commit origin\/main does not/);
  assert.equal(git(dir, "log", "-1", "--format=%s"), "Mine");
  assert.deepEqual(calls, { install: 2, reload: 3 }, "and nothing refused is reloaded");
});
