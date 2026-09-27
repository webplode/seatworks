import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type OlderContext, olderSeats, stampKit } from "../../server/upkeep/older-seats.ts";
import { makeKit } from "../kit.ts";
import { tempDir } from "../tempdir.ts";

const NOW = Date.parse("2026-09-22T07:12:30Z");

function world(): OlderContext {
  return { kit: makeKit(), home: tempDir("sw3-home-"), live: [], now: NOW };
}

test("the seats started before this version are named, and nothing about them changes", () => {
  const ctx = world();
  const version = (named: string) =>
    writeFileSync(join(ctx.kit.dir, "package.json"), JSON.stringify({ version: named }));
  version("3.0.0-dev.1");
  const { since } = stampKit(ctx.kit, ctx.home, NOW);
  assert.equal(stampKit(ctx.kit, ctx.home, NOW + 30_000).since, since, "one version keeps the time it started");
  version("3.0.0-dev.2");
  const next = stampKit(ctx.kit, ctx.home, NOW + 60_000);
  assert.ok(
    next.since > since,
    "a raised version is a new one, whichever file a seat reads raised it: the git shim too",
  );
  ctx.live.push(
    {
      provider: "sw3-lead-claude",
      slug: "shop-abc123",
      createdAt: new Date(NOW).toISOString(),
      name: "Lead · Claude Code",
    },
    {
      provider: "sw3-peer-omp",
      slug: "shop-abc123",
      createdAt: new Date(NOW + 120_000).toISOString(),
      name: "Peer · Oh My Pi",
    },
  );
  assert.deepEqual(
    olderSeats(ctx).projects.map((older) => [older.where, older.detail.slice(0, -1)]),
    [["shop-abc123", ["Lead · Claude Code"]]],
  );
});
