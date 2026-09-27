import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { IndexedProxy } from "../../server/catalog/seat/servers.ts";
import { codeIndex } from "../../server/runtime/seat/code-index.ts";
import { tempDir } from "../tempdir.ts";
import { entry, fakeIde, fakeSemble, gone, ideConfig, proxy, repo, searchConfig, within } from "./code-fakes.ts";

/** The desk's own client of the shipped IntelliJ entry, reaching `url`, each in turn when there are several. */
const deskIndex = (url: string | string[]) =>
  codeIndex({
    ...(entry("intellij-index").proxy as unknown as IndexedProxy),
    id: "intellij-index",
    label: "IntelliJ",
    backend: { type: "http", urls: [url].flat() },
  });

test("a call or a proxy its harness stops stops what it started", async (t) => {
  const ide = await fakeIde(t, { held: true });
  const cwd = repo();
  ide.open.add(cwd);
  const code = await proxy(t, cwd, ideConfig(ide.url, ["ide_find_references"]));
  const stopping = new AbortController();
  const calling = code.client.callTool({ name: "ide_find_references", arguments: {} }, { signal: stopping.signal });
  assert.ok(await within(3000, () => ide.received.includes("ide_find_references")), "the call reaches the IDE");
  stopping.abort();
  await assert.rejects(calling);
  assert.ok(await within(3000, () => ide.notified.includes("notifications/cancelled")), "stopped at the backend too");

  const indexing = await fakeIde(t, { dumbCalls: 1000 });
  indexing.open.add(cwd);
  const config = {
    ...ideConfig(indexing.url, ["ide_find_references"]),
    wait: { ...entry("intellij-index").proxy.wait, seconds: 30, pollSeconds: 0.02 },
  };
  const waiting = await proxy(t, cwd, config, undefined, { SEATWORKS_PROGRESS_MS: "50" });
  const heard: string[] = [];
  const halting = new AbortController();
  const polling = waiting.client.callTool(
    { name: "ide_find_references", arguments: {} },
    { signal: halting.signal, onprogress: (note) => heard.push(note.message ?? "") },
  );
  assert.ok(await within(3000, () => heard.length > 0));
  assert.match(
    heard[0]!,
    /is still working on ide_find_references\./,
    "a harness that asked hears a call waiting on the index",
  );
  halting.abort();
  await assert.rejects(polling);
  const polls = () => indexing.calls.filter((call) => call.name === "ide_index_status").length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = polls();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(polls(), after, "a stopped call no longer asks whether the index is ready");

  const semble = fakeSemble();
  const up = await fakeIde(t);
  up.open.add(cwd);
  for (const shipped of [ideConfig(up.url, ["ide_find_references"]), searchConfig([process.execPath, semble])]) {
    const running = await proxy(t, cwd, shipped);
    assert.ok(!(await running.call(shipped.tools[0]!, { query: "a" })).isError);
    const started = Date.now();
    await running.stop();
    // A harness gives a server two seconds to go by itself before it signals it.
    assert.ok(Date.now() - started < 1500, `${shipped.name} stays until its harness forces it`);
  }
  assert.ok(
    gone(Number(readFileSync(`${semble}.pid`, "utf-8"))),
    "a proxy closing its input closes the backend it started",
  );

  // Never answers, like a cold start still fetching its package; the list once waited out init's budget, then its own.
  const pidFile = join(tempDir("sw3-slow-"), "pid");
  const silent = [
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
    pidFile,
  ];
  const cold = await proxy(t, repo(), {
    name: "code-search",
    label: "Code search",
    tools: ["search"],
    descriptions: { search: "Search the code." },
    listSeconds: 0.3,
    backend: { type: "stdio", command: silent },
  });
  const listing = Date.now();
  const [only] = (await cold.tools()) as {
    name: string;
    description: string;
    inputSchema: { additionalProperties?: boolean };
  }[];
  assert.ok(Date.now() - listing < 10_000, "a server slow to start does not hold the list for the whole call budget");
  assert.equal(only!.name, "search");
  assert.match(only!.description, /Search the code\./, "the preset's own description is kept");
  assert.match(only!.description, /not reachable/, "and the seat is told the server is not there");
  assert.equal(only!.inputSchema.additionalProperties, true, "with a schema that refuses no arguments");
  // As a harness that signals its servers rather than closing their input: the proxy may not go before its backend.
  process.kill(cold.pid, "SIGTERM");
  const backend = Number(readFileSync(pidFile, "utf-8"));
  t.after(() => void (gone(backend) || process.kill(backend)));
  assert.ok(
    await within(5000, () => gone(backend)),
    "a backend that ignores its input closing is stopped with its proxy",
  );
});

test("the desk's own calls to the IDE open a copy through an open project, close only it, keep a session, and read a refusal", async (t) => {
  const off = await fakeIde(t, { openEnabled: false });
  const refused = await deskIndex(off.url).open("/slots/S1");
  assert.deepEqual(
    [refused.ok, refused.text],
    [false, "Tool ide_open_project not found"],
    "a refusal is a failed call",
  );

  const busy = await fakeIde(t, { routeRequired: true });
  const index = deskIndex(busy.url);
  const opened = await index.open("/slots/S1");
  assert.equal(opened.ok, true, opened.text);
  assert.deepEqual(
    busy.calls.map((call) => [call.args.path, call.args.project_path]),
    [
      ["/slots/S1", undefined],
      ["/slots/S1", "/already/open"],
    ],
    "routed through an open project",
  );
  assert.ok(busy.open.has("/slots/S1"));
  const closed = await index.close("/slots/S1");
  assert.equal(closed.ok, true, closed.text);
  assert.deepEqual(
    busy.calls.at(-1),
    { name: "ide_close_project", args: { project_path: "/slots/S1" } },
    "the close names the copy, never whichever project the IDE has in front",
  );
  assert.equal(busy.open.has("/slots/S1"), false);

  const kept = await fakeIde(t, { session: true });
  const cwd = repo();
  kept.open.add(cwd);
  assert.equal((await deskIndex(kept.url).sync(cwd)).ok, true, "a backend that keeps a session is spoken to within it");
  assert.equal(
    (await deskIndex(["http://127.0.0.1:9/mcp", kept.url]).sync(cwd)).ok,
    true,
    "of several ports, a dead one is passed over for the next that answers",
  );
});
