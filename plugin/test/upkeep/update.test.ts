import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type UpdateContext, applyUpdate, checkUpdate } from "../../server/upkeep/update.ts";
import { tempDir } from "../tempdir.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf-8" }).trim();

function commit(dir: string, files: Record<string, string>, subject: string): void {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", subject);
}

/** A checkout following origin/main, and another clone that pushes to it. */
function world() {
  const origin = tempDir("sw2-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const upstream = tempDir("sw2-up-");
  git(upstream, "clone", "-q", origin, ".");
  git(upstream, "checkout", "-q", "-b", "main");
  commit(upstream, { "paseo-plugin.json": '{"requirements":{"paseo":">=0.8.0 <0.9.0"}}', "package.json": '{"version":"2.0.0"}' }, "Start");
  git(upstream, "push", "-q", "origin", "main");
  const dir = tempDir("sw2-plugin-");
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

test("check lists what is new upstream and what the update will need, and moves nothing", async () => {
  const { dir, ctx, publish } = world();
  const before = git(dir, "rev-parse", "HEAD");
  publish({ "a.txt": "a" }, "Add a");
  publish({ "package.json": '{"dependencies":{"zod":"4"}}', "paseo-plugin.json": '{"requirements":{"paseo":">=0.9.0"}}' }, "Need zod and a newer Paseo");

  const view = await checkUpdate(ctx);
  assert.deepEqual([view.behind, view.ahead, view.blocked], [2, 0, null]);
  assert.deepEqual(view.commits.map((entry) => entry.subject), ["Need zod and a newer Paseo", "Add a"]);
  assert.deepEqual([view.installs, view.paseo], [true, ">=0.9.0"]);
  assert.equal(git(dir, "rev-parse", "HEAD"), before);
});

test("the version shows without asking the remote, and a check that does not fetch sees only what the last fetch saw", async () => {
  const { ctx, publish } = world();
  publish({ "a.txt": "a" }, "Add a");
  const local = await checkUpdate(ctx, false);
  assert.deepEqual([local.version, local.behind, local.fetched], ["2.0.0", 0, false]);
  assert.match(local.date ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await checkUpdate(ctx)).behind, 1);
});

test("update moves the checkout forward, installs only when the packages changed, and reloads", async () => {
  const { dir, ctx, calls, publish } = world();
  publish({ "a.txt": "a" }, "Add a");
  await applyUpdate(ctx);
  assert.deepEqual(calls, { install: 0, reload: 1 });

  publish({ "package.json": '{"dependencies":{"zod":"4"}}' }, "Need zod");
  const view = await applyUpdate(ctx);
  assert.equal(view.updated?.to, git(dir, "rev-parse", "--short", "HEAD"));
  assert.equal(git(dir, "log", "-1", "--format=%s"), "Need zod");
  assert.deepEqual(calls, { install: 1, reload: 2 });
});

test("update refuses a checkout with uncommitted changes or commits of its own, and reloads nothing", async () => {
  const { dir, ctx, calls, publish } = world();
  publish({ "a.txt": "a" }, "Add a");
  writeFileSync(join(dir, "package.json"), '{"mine":true}');
  assert.equal((await applyUpdate(ctx)).blocked, "It has local changes, so it does not update itself.");

  git(dir, "checkout", "-q", "--", "package.json");
  commit(dir, { "b.txt": "b" }, "Mine");
  assert.match((await applyUpdate(ctx)).blocked ?? "", /has 1 commit origin\/main does not/);
  assert.equal(git(dir, "log", "-1", "--format=%s"), "Mine");
  assert.deepEqual(calls, { install: 0, reload: 0 });
});

test("update waits until no seat runs in any project, and moves nothing meanwhile", async () => {
  const { dir, ctx, calls, publish } = world();
  const before = git(dir, "rev-parse", "HEAD");
  publish({ "a.txt": "a" }, "Add a");
  const view = await applyUpdate({ ...ctx, busy: ["shop-abc123: 3 agents", "api-def456: 1 agent"] });
  assert.equal(view.blocked, "Stop every Seatworks agent before updating. Still running: shop-abc123: 3 agents, api-def456: 1 agent.");
  assert.equal(git(dir, "rev-parse", "HEAD"), before);
  assert.deepEqual(calls, { install: 0, reload: 0 });
});

test("an install that fails puts the checkout back where it was", async () => {
  const { dir, ctx, calls, publish, failInstall } = world();
  const before = git(dir, "rev-parse", "HEAD");
  publish({ "package.json": '{"dependencies":{"nope":"1"}}' }, "Need nope");
  failInstall("404 nope");
  assert.match((await applyUpdate(ctx)).blocked ?? "", /npm install failed, so the checkout is back on \w+: 404 nope/);
  assert.equal(git(dir, "rev-parse", "HEAD"), before);
  assert.equal(calls.reload, 0);
});

test("a copy Paseo installed from Git is left to Paseo's own update", async () => {
  const { ctx } = world();
  const view = await checkUpdate({ ...ctx, dir: "/home/me/.paseo/plugins/seatworks-v2/abc/checkout/plugin", managedRoot: "/home/me/.paseo/plugins" });
  assert.equal(view.blocked, "Paseo installed this copy from Git: run `paseo plugin update seatworks-v2`.");
});
