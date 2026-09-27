import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { z } from "zod";
import { deskSocket } from "../../server/core/paths.ts";
import type { TeamSocket } from "../../server/runtime/seat/team-socket.ts";
import { contracts } from "../../shared/rpc.ts";
import { harness } from "../runtime/harness.ts";
import { tempDir } from "../tempdir.ts";

const TEAM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "mcp", "team.mjs");
const data = (file: string, set: string) =>
  (JSON.parse(readFileSync(join(dirname(TEAM), file), "utf-8")) as Record<string, unknown>)[set];

type Harness = ReturnType<typeof harness>;
type Schema = { properties: Record<string, Schema>; items?: Schema; enum?: string[] };
type Replied = { isError?: boolean; content: { text: string }[] };

/** Resolves once `check` holds, polling while the processes on either end do their part; fails after five seconds. */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; !(await check()); tries++) {
    assert.ok(tries < 250, `never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A lane with its Lead, the desk's socket listening as the plugin's start opens it, and the Lead's key bound as Paseo opens it. */
async function lineUp(t: TestContext) {
  const h = harness();
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", {
    title: "Build",
    outcome: "a.txt changes",
    acceptance: ["a"],
    outOfScope: ["anything else in the repository"],
  });
  const lead = h.ledger().lanes.L1!.lead!;
  const socket = (h.runtime as unknown as { socket: TeamSocket }).socket;
  socket.listen();
  t.after(() => socket.close());
  bind(h, lead, "k-lead");
  return { h, sup, lead, socket };
}

function bind(h: Harness, agent: string, key: string): void {
  const { provider } = h.agents.get(agent)!;
  h.runtime.sessionOpen({ agentId: agent, reason: "create", provider, cwd: h.root, env: { SEATWORKS_DESK_KEY: key } });
}

/** The seat's team server as its harness starts it in the project, with the key it was given; `changed` hears list_changed. */
async function served(t: TestContext, h: Harness, set: string, key: string, env = {}, changed?: () => void) {
  const client = new Client(
    { name: "probe", version: "0" },
    changed ? { listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: changed } } } : {},
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TEAM, set, set, deskSocket()],
    cwd: h.root,
    env: { PATH: process.env.PATH ?? "", SEATWORKS_DESK_KEY: key, ...env },
    stderr: "inherit",
  });
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}, options = {}) =>
    (await client.callTool({ name, arguments: args }, options)) as Replied;
  const schema = async (tool: string) =>
    (await client.listTools()).tools.find((entry) => entry.name === tool)!.inputSchema as unknown as Schema;
  return { client, call, schema };
}

/** A line to the desk spoken on directly, as a seat's server speaks: what it heard, and a way to say something. */
async function line(t: TestContext, h: Harness, key: string, role: string) {
  const socket = connect(deskSocket());
  await new Promise((resolve) => socket.on("connect", resolve));
  t.after(() => socket.destroy());
  const heard: { type: string }[] = [];
  createInterface({ input: socket }).on("line", (text) => heard.push(JSON.parse(text) as { type: string }));
  const say = (message: object) => socket.write(`${JSON.stringify(message)}\n`);
  say({ type: "hello", key, role, cwd: h.root });
  await until(() => heard.length > 0, "the desk answers the hello");
  return { socket, heard, say, types: () => heard.map((said) => said.type) };
}

/** A gate that holds until `release` is called, so a call it runs is stopped or dropped while the desk is still at it. */
function heldGate(t: TestContext) {
  const go = join(tempDir("sw3-gate-"), "go");
  const release = () => writeFileSync(go, "");
  t.after(release);
  return { command: `until [ -f '${go}' ]; do sleep 0.02; done`, release };
}

const task = {
  key: "t",
  title: "Clean build",
  goal: "g",
  acceptance: ["a"],
  hints: ["a.txt"],
  outOfScope: ["the rest"],
};

test("a seat's harness is shown its tools with the desk's choices, and its calls are carried out as the keyed seat's, or refused for an unknown key", async (t) => {
  const { h, lead, socket } = await lineUp(t);
  const stranger = await served(t, h, "lead", "k-nope");
  const recorded = h.events("tool").length;
  for (const tool of ["status", "add_tasks"])
    assert.match((await stranger.call(tool)).content[0]!.text, /^The desk does not know this agent's key/, tool);
  assert.equal(h.events("tool").length, recorded, "nothing is carried out from a key the desk does not hold");

  const seat = await served(t, h, "lead", "k-lead");
  assert.equal(seat.client.getInstructions(), data("instructions.json", "lead"), "told what the server is for");
  const shown = (list: { name: string; title?: string; annotations?: object }[]) =>
    list.map(({ name, title, annotations }) => ({ name, title, annotations }));
  assert.deepEqual(
    shown((await seat.client.listTools()).tools),
    shown(data("tools.json", "lead") as { name: string }[]),
    "each tool's title and what it changes",
  );
  // The desk's choices come with the first list, or as a changed list soon after when the desk is slow to say them.
  await until(async () => ((await seat.schema("note")).properties.kind!.enum ?? []).length > 0, "choices shown");
  const fields = (await seat.schema("add_tasks")).properties.tasks!.items!.properties;
  assert.deepEqual(fields.role!.enum, ["peer"], "the desk's choices as enums");
  assert.ok(fields.skills!.items!.enum!.includes("test-first"), "a list takes the set for its items");
  assert.ok((await seat.schema("note")).properties.kind!.enum!.includes("plans"));
  assert.equal(fields.title!.enum, undefined, "a field the desk names nothing for is left open");

  const added = await seat.call("add_tasks", { tasks: [task] });
  assert.equal(added.isError, false, added.content[0]!.text);
  assert.ok(h.ledger().tasks["L1-T1"]!.peer, "carried out as the Lead the key belongs to");
  await until(() => !socket.calling(lead), "the harness took the answer, so no mail waits on the call");
  assert.equal((await seat.call("accept", { task: "L9-T9" })).isError, true, "a refusal is marked an error");
  await assert.rejects(seat.client.callTool({ name: "no_such_tool", arguments: {} }), "the protocol's own error");
});

test("a call and its answer holding a line or paragraph separator cross the line whole", async (t) => {
  const { h, lead, socket } = await lineUp(t);
  const seat = await served(t, h, "lead", "k-lead");
  const title = "Clean\u2028build\u2029now";
  const added = await seat.call("add_tasks", { tasks: [{ ...task, title }] });
  assert.equal(added.isError, false, added.content[0]!.text);
  assert.equal(h.ledger().tasks["L1-T1"]!.title, title, "the call was read as one line");
  assert.ok(added.content[0]!.text.includes(title), "and so was its answer");
  await until(() => !socket.calling(lead), "the harness took the answer");
});

test("a call the desk never answers is given up on in time, told to the desk, and an unreadable line is said", async (t) => {
  const heard: { type: string; id?: string }[] = [];
  const path = join(tempDir("sw3-desk-"), "desk.sock");
  const desk = createServer((socket) => {
    createInterface({ input: socket }).on("line", (text) => {
      const said = JSON.parse(text) as { type: string; id?: string };
      heard.push(said);
      if (said.type === "hello")
        socket.write(`not json secret-marker\n${JSON.stringify({ type: "welcome", choices: {} })}\n`);
    });
  });
  await new Promise<void>((resolve) => desk.listen(path, resolve));
  t.after(() => desk.close());
  const client = new Client({ name: "probe", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TEAM, "lead", "lead", path],
    env: { PATH: process.env.PATH ?? "", SEATWORKS_DESK_KEY: "k", SEATWORKS_ANSWER_MS: "200" },
    stderr: "pipe",
  });
  let said = "";
  transport.stderr!.on("data", (chunk: Buffer) => (said += chunk.toString()));
  await client.connect(transport);
  t.after(() => client.close());

  const replied = (await client.callTool({
    name: "report",
    arguments: { summary: "done", ready: true },
  })) as Replied;
  assert.equal(replied.isError, true);
  assert.match(replied.content[0]!.text, /^The team desk did not answer report in time\./);
  const call = heard.find((message) => message.type === "call")!;
  await until(
    () => heard.some((message) => message.type === "cancel" && message.id === call.id),
    "the desk is told the call was given up",
  );
  assert.match(said, /team: an unreadable line from the desk \(\d+ bytes\)/);
  assert.doesNotMatch(said, /not json|secret-marker/, "an unreadable desk payload is never copied into logs");
});

test("a call its harness stops, or whose line drops, is answered by mail, and the next call finds the desk again", async (t) => {
  const { h, sup, lead, socket } = await lineUp(t);
  const letters = () => h.heard(lead).join("\n");
  const gated = async () => {
    const gate = heldGate(t);
    await h.call(sup, "supervisor", "set_project", { gate: gate.command, gateOn: "lane" });
    return gate;
  };
  const seat = await served(t, h, "lead", "k-lead", { SEATWORKS_PROGRESS_MS: "50" });
  const ready = { summary: "done", ready: true };

  let gate = await gated();
  const notes: string[] = [];
  const long = seat.call("report", ready, {
    onprogress: (note: { message?: string }) => notes.push(note.message ?? ""),
  });
  await until(() => notes.length > 1, "a harness that asked for progress hears that a long call still runs");
  gate.release();
  await long;
  assert.ok(
    notes.every((note) => note === "The desk is still working on report."),
    notes.join(" | "),
  );

  gate = await gated();
  const stopping = new AbortController();
  const stopped = seat.call("report", ready, { signal: stopping.signal });
  await until(() => socket.calling(lead), "the call reaches the desk");
  stopping.abort();
  await assert.rejects(stopped);
  await until(() => !socket.calling(lead), "the desk hears it was stopped");
  gate.release();
  await until(() => /ANSWER to your report call/.test(letters()), "the answer is mailed once it comes");
  assert.match(letters(), /ANSWER to your report call, which was stopped on your side before its answer reached you\./);

  gate = await gated();
  const dropping = seat.call("report", { summary: "done again", ready: true });
  await until(() => socket.calling(lead), "the call reaches the desk");
  socket.close();
  const dropped = await dropping;
  assert.equal(dropped.isError, true);
  assert.equal(
    dropped.content[0]!.text,
    "The line to the team desk dropped while report ran, so its answer did not come back here. If the desk took the call, its answer comes as mail: look before calling report again, since a second call may do it twice.",
  );
  assert.equal(socket.calling(lead), false);
  gate.release();
  await until(
    () => letters().match(/ANSWER to your report call/g)?.length === 2,
    "the dropped call's answer is mailed",
  );
  socket.listen();
  assert.equal((await seat.call("status")).isError, false, "the next call finds the desk again");

  const raw = await line(t, h, "k-lead", "lead");
  raw.say({ type: "call", id: "1", tool: "status", args: {} });
  await until(() => raw.types().includes("result"), "answered on the line");
  raw.socket.destroy();
  await until(
    () => /ANSWER to your status call/.test(letters()),
    "answered and never taken, it is mailed once the line drops",
  );
});

test("new choices reach a harness as a changed tool list, only where its set changed", async (t) => {
  const { h, lead } = await lineUp(t);
  await h.call(lead, "lead", "add_tasks", { tasks: [task] });
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  bind(h, peer, "k-peer");
  let told = 0;
  const seat = await served(t, h, "lead", "k-lead", {}, () => told++);
  const skills = async () =>
    (await seat.schema("add_tasks")).properties.tasks!.items!.properties.skills!.items!.enum ?? [];
  await until(
    async () => (await skills()).includes("ide-index-mcp"),
    "Peers have the IDE server, so its skill is a choice",
  );
  const leadLine = await line(t, h, "k-lead", "lead");
  const peerLine = await line(t, h, "k-peer", "peer");

  const save = async (values: z.input<typeof contracts.settingsWrite.input>["values"]) => {
    const read = await h.rpc(contracts.settingsRead, { project: h.project.slug });
    const saved = await h.rpc(contracts.settingsWrite, { project: h.project.slug, revision: read.revision, values });
    assert.equal(saved.status, "saved", JSON.stringify(saved));
  };
  await save({ attention: { reworksAt: 4 } });
  await save({ mcp: { "intellij-index": { enabled: false } } });
  await until(() => leadLine.heard.length > 1, "the change reaches the Lead's line");
  assert.deepEqual(leadLine.types(), ["welcome", "choices"], "a save that changes no choice sends nothing");
  await until(() => told > 0, "the Lead's harness is told the list changed");
  assert.equal((await skills()).includes("ide-index-mcp"), false, "without the server, its skill is no choice");
  peerLine.say({ type: "call", id: "1", tool: "ask", args: {} });
  await until(() => peerLine.types().includes("result"), "the Peer's line answers");
  assert.deepEqual(peerLine.types(), ["welcome", "result"], "a line whose set did not change is sent nothing");
});
