import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { type Socket, connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ToolReply } from "../../server/desk/context.ts";
import { TeamSocket } from "../../server/runtime/seat/team-socket.ts";
import { reported } from "../console.ts";
import { tempDir } from "../tempdir.ts";

const TEAM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "mcp", "team.mjs");

/** Resolves once `check` holds, polling while the other end does its part; fails after five seconds. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    assert.ok(tries < 250, `never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the line's ends: no desk, a socket file left behind, a pipe closed under a server, and a line that fails", async (t) => {
  const client = new Client({ name: "probe", version: "0" });
  const nowhere = join(tempDir("sw3-desk-"), "none.sock");
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [TEAM, "lead", "lead", nowhere],
      env: { PATH: process.env.PATH ?? "", SEATWORKS_DESK_KEY: "k1" },
      stderr: "inherit",
    }),
  );
  t.after(() => client.close());
  const called = (await client.callTool({ name: "status", arguments: {} })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  assert.equal(called.isError, true);
  assert.match(
    called.content[0]!.text,
    /^The team desk is not running, so status was not carried out\. Do not call it again/,
  );

  const cancelled: AbortSignal[] = [];
  const path = join(tempDir("sw3-sock-"), "d.sock");
  writeFileSync(path, "left behind");
  const socket = new TeamSocket(path, {
    whose: (key) => (key === "k1" ? { agent: "agent-1" } : { refused: "unknown" }),
    choices: () => ({}),
    answer: (_request, stop) => (cancelled.push(stop), new Promise<ToolReply>(() => {})),
    mailLost: async () => undefined,
  });
  socket.listen();
  t.after(() => socket.close());
  const mode = () => {
    try {
      return statSync(path).isSocket() ? statSync(path).mode & 0o777 : 0;
    } catch {
      return 0;
    }
  };
  await until(() => mode() === 0o600, "a file a stopped plugin left behind is taken over, the socket its user's alone");

  const lines: Socket[] = [];
  const open = createServer((line) => lines.push(line));
  const held = join(tempDir("sw3-desk-"), "held.sock");
  await new Promise<void>((resolve) => open.listen(held, resolve));
  t.after(() => {
    for (const line of lines) line.destroy();
    open.close();
  });
  const server = spawn(process.execPath, [TEAM, "peer", "peer", held], {
    env: { PATH: process.env.PATH ?? "", SEATWORKS_DESK_KEY: "k1" },
    stdio: ["pipe", "ignore", "inherit"],
  });
  t.after(() => server.kill());
  const exited = new Promise<boolean>((resolve) => server.on("exit", () => resolve(true)));
  await until(() => lines.length === 1, "its line to the desk is open");
  server.stdin.end();
  const late = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000).unref());
  assert.ok(
    await Promise.race([exited, late]),
    "a server whose harness closes its pipe exits, though its line is open",
  );

  // The desk's own welcome echoes back on this fake pipe, and is logged as a line it cannot read.
  const said = reported(t);
  const failing = Object.assign(new PassThrough(), { destroyed: false, destroy() {} }) as unknown as Socket;
  (socket as unknown as { serve(line: Socket): void }).serve(failing);
  failing.write(`${JSON.stringify({ type: "hello", key: "k1", role: "lead", cwd: "/work" })}\n`);
  failing.write(`${JSON.stringify({ type: "call", id: "1", tool: "status", args: {} })}\n`);
  await until(() => cancelled.length === 1 && socket.calling("agent-1"), "the call is on the line");
  assert.doesNotThrow(() => {
    failing.emit("error", new Error("reset by the seat's end"));
    failing.emit("close");
  }, "a line that fails is dropped, and the desk goes on");
  assert.equal(cancelled[0]!.aborted, true, "and its call goes to the mail");
  assert.equal(socket.calling("agent-1"), false);

  const tooLarge = connect(path);
  await new Promise((resolve) => tooLarge.on("connect", resolve));
  const closed = new Promise<void>((resolve) => tooLarge.on("close", () => resolve()));
  tooLarge.write(`secret-marker-${"x".repeat(1024 * 1024)}`);
  await closed;
  assert.match(said(), /unreadable line from an unknown seat \(more than \d+ bytes\)/);
  assert.doesNotMatch(said(), /secret-marker/, "an oversized frame is never copied into the daemon log");
});
