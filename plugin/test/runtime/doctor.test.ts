// First, so this file has a HOME of its own even run alone: what it writes under HOME would otherwise land in the owner's.
import "../setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { z } from "zod";
import { home } from "../../server/core/paths.ts";
import { contracts } from "../../shared/rpc.ts";
import { makeKit } from "../kit.ts";
import { tempDir } from "../tempdir.ts";
import { fakeIde } from "./code-fakes.ts";
import { fakeConfig } from "./fake-paseo.ts";
import { daemon, served, which } from "./served.ts";

/** A port nothing listens on: one this machine gave out and took back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("the doctor over the panel names what this machine lacks for the team, a server at a time", async (t) => {
  const config = fakeConfig();
  const { call } = served(daemon(config));
  const bins = tempDir("sw3-bin-");
  const gitHome = execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim();
  const path = process.env.PATH;
  process.env.PATH = [bins, gitHome].join(delimiter);
  t.after(() => void (process.env.PATH = path));
  const install = (...names: string[]) => {
    for (const name of names) {
      writeFileSync(join(bins, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bins, name), 0o755);
    }
  };
  // Claude as it answers `auth status`, exiting 1 when logged out: by a token in its env, or by the login the Human made
  // once outside any seat, which a seat's own settings folder reaches only with its secure storage pointed back home.
  const claudeAuth = () => {
    const script = `#!/bin/sh
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || { [ "\${CLAUDE_SECURESTORAGE_CONFIG_DIR+set}" = set ] && [ -z "$CLAUDE_SECURESTORAGE_CONFIG_DIR" ] && [ -f "$HOME/.claude/logged-in" ]; }; then echo '{"loggedIn": true}'; else echo '{"loggedIn": false}'; exit 1; fi
`;
    writeFileSync(join(bins, "claude"), script);
    chmodSync(join(bins, "claude"), 0o755);
  };
  const claudeLogin = (yes: boolean) => {
    const marker = join(home(), ".claude", "logged-in");
    if (!yes) return rmSync(marker, { force: true });
    mkdirSync(join(home(), ".claude"), { recursive: true });
    writeFileSync(marker, "");
  };

  const login = join(home(), ".omp", "agent", "agent.db");
  const loggedIn = (yes: boolean) => {
    if (!yes) return rmSync(login, { force: true });
    mkdirSync(join(home(), ".omp", "agent"), { recursive: true });
    writeFileSync(login, "");
  };
  const setUp = async (values: z.input<typeof contracts.settingsWrite.input>["values"]) => {
    const read = which(await call(contracts.settingsRead, {}), "values");
    assert.equal((await call(contracts.settingsWrite, { revision: read.revision, values })).status, "saved");
  };
  const checked = async () => Object.fromEntries((await call(contracts.doctor, {})).map((check) => [check.id, check]));
  // Paseo's own tools, which the test kit's Supervisor keeps on, against the list the kit ships of them.
  const shipped = makeKit().paseoTools;
  const paseo = await fakeIde(t, { tools: shipped });
  process.env.PASEO_LISTEN = `127.0.0.1:${paseo.port}`;
  t.after(() => delete process.env.PASEO_LISTEN);
  const partial = await fakeIde(t, { tools: ["ide_find_references", "ide_open_project"] });
  const full = await fakeIde(t, { tools: ["ide_find_references", "ide_refactor_rename", "ide_open_project"] });
  const nowhere = await closedPort();
  const at = (port: number) => ({ type: "http" as const, url: `http://127.0.0.1:${port}/mcp` });

  install("claude");
  claudeAuth();
  claudeLogin(true);
  loggedIn(true);
  await setUp({ mcp: { ide: { settings: { port: [partial.port] } }, docs: { enabled: true, connect: at(nowhere) } } });
  const short = await checked();
  assert.equal(short.settings!.ok, true);
  assert.deepEqual(
    Object.keys(short).filter((id) => id.startsWith("bin:")),
    ["bin:git"],
    "the desk's own git: what a skill runs, its own compatibility line names",
  );
  assert.deepEqual([short["harness:claude"]!.ok, short["harness:omp"]!.ok], [true, false], "an agent a role runs on");
  assert.equal(short["mcp:ide"]!.ok, false);
  assert.match(short["mcp:ide"]!.detail, /ide_refactor_rename/, "the IDE tool a role uses and the IDE does not offer");
  assert.equal(short["mcp:docs"]!.ok, false, "a server that does not answer");

  install("omp");
  await setUp({ mcp: { ide: { settings: { port: [nowhere, full.port] } } } });
  const whole = await call(contracts.doctor, {});
  assert.ok(
    whole.every((check) => check.ok),
    JSON.stringify(whole),
  );
  assert.match(
    whole.find((check) => check.id === "mcp:ide")!.detail,
    new RegExp(
      `at http://127\\.0\\.0\\.1:${full.port}/mcp exposes every tool[^]*Nothing answered at http://127\\.0\\.0\\.1:${nowhere}/mcp`,
    ),
    "of several ports, the one serving every tool passes it, and the silent one is named",
  );
  assert.equal(
    whole.some((check) => check.id === "mcp:docs"),
    false,
    "a server nobody uses is skipped",
  );
  await setUp({ mcp: { ide: { settings: { port: [nowhere] } } } });
  assert.match((await checked())["mcp:ide"]!.detail, /No IDE server answered/);

  claudeLogin(false);
  const unsigned = (await checked())["harness:claude:login"]!;
  assert.equal(unsigned.ok, false, "a seat logs in as the Human, so a Human never logged in leaves every seat out");
  assert.match(
    unsigned.detail,
    /Supervisor, Lead would stop at "Not logged in"\. Log in with claude once, outside any seat/,
  );
  await config.api.patch({ providers: { claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } } } });
  assert.equal(
    (await checked())["harness:claude:login"]!.ok,
    true,
    "a token on Paseo's own provider reaches every seat",
  );
  await config.api.patch({ providers: { claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: "" } } } });
  claudeLogin(true);
  assert.equal((await checked())["harness:claude:login"]!.ok, true, "the Human's own login reaches a seat's folder");

  loggedIn(false);
  const unlogged = (await checked())["harness:omp:HOME/.omp/agent/agent.db"]!;
  assert.equal(unlogged.ok, false, "what a harness says its seats need on this machine is checked");
  assert.match(unlogged.detail, /agent\.db for Peer, Scribe\. Log in with omp once/, "and how to get it is said");
  loggedIn(true);
  assert.equal((await checked())["harness:omp:HOME/.omp/agent/agent.db"]!.ok, true);

  const newer = await fakeIde(t, { tools: [...shipped.filter((tool) => tool !== "speak"), "draw_diagram"] });
  process.env.PASEO_LISTEN = `127.0.0.1:${newer.port}`;
  const unlisted = (await checked())["paseo:tools"]!;
  assert.equal(unlisted.ok, false, "the list is out of step with the Paseo this machine runs");
  assert.match(unlisted.detail, /Paseo has draw_diagram, which catalog\/paseo\.json lacks/);
  assert.match(unlisted.detail, /catalog\/paseo\.json names speak, which Paseo does not have/);
  process.env.PASEO_LISTEN = `127.0.0.1:${paseo.port}`;
  assert.equal((await checked())["paseo:tools"]!.ok, true);

  // A null in an outside server's tools list once threw out of the report, taking every check with it.
  const hostile = await fakeIde(t, { malformed: true });
  await setUp({
    mcp: { ide: { settings: { port: [hostile.port] } }, docs: { enabled: true, connect: at(full.port) } },
  });
  const survived = await checked();
  assert.equal(survived["mcp:ide"]!.ok, false, "a server whose list cannot be read costs its own check");
  assert.deepEqual([survived.settings!.ok, survived["mcp:docs"]!.ok], [true, true], "and not the rest of the report");
});
