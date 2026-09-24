import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "../tempdir.ts";

const teamServer = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "mcp", "team.mjs");

// Codex starts MCP servers with a filtered environment; its app-server, the server's parent, carries the agent id.
test("a desk call names its agent even when the server was started without the agent's environment", async () => {
  const spool = tempDir("sw2-spool-");
  const parent = spawn(
    process.execPath,
    ["-e", `require("node:child_process").spawn(process.execPath, ${JSON.stringify([teamServer, "lead", "lead", spool])}, { env: { PATH: process.env.PATH }, stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0))`],
    { env: { PATH: process.env.PATH, PASEO_AGENT_ID: "agent-7" }, stdio: ["pipe", "ignore", "inherit"], detached: true },
  );
  try {
    parent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: {} } })}\n`);
    const requests = join(spool, "requests");
    const deadline = Date.now() + 5000;
    let file: string | undefined;
    while (!file && Date.now() < deadline) {
      file = existsSync(requests) ? readdirSync(requests).find((name) => name.endsWith(".json")) : undefined;
      if (!file) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(file, "the call reached the spool");
    assert.equal(JSON.parse(readFileSync(join(requests, file!), "utf-8")).agent, "agent-7");
  } finally {
    // The server waits minutes for a reply, so its whole group goes, not only the parent.
    process.kill(-parent.pid!, "SIGKILL");
  }
});

test("a seat started before a tool was added is told the list changed and then sees it", async () => {
  const dir = join(tempDir("sw2-mcp-"), "mcp");
  mkdirSync(dir);
  copyFileSync(teamServer, join(dir, "team.mjs"));
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} } });
  writeFileSync(join(dir, "tools.json"), JSON.stringify({ supervisor: [tool("status")] }));
  const server = spawn(process.execPath, [join(dir, "team.mjs"), "supervisor", "supervisor", ""], { env: { PATH: process.env.PATH, SEATWORKS_TOOLS_POLL_MS: "20" }, stdio: ["pipe", "pipe", "inherit"] });
  const lines: Record<string, unknown>[] = [];
  let rest = "";
  server.stdout.on("data", (chunk: Buffer) => {
    const parts = (rest + chunk.toString()).split("\n");
    rest = parts.pop()!;
    lines.push(...parts.filter(Boolean).map((line) => JSON.parse(line)));
  });
  const until = async (found: () => unknown) => {
    const deadline = Date.now() + 5000;
    while (!found() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return found();
  };
  const ask = (id: number, method: string) => server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`);
  try {
    ask(1, "initialize");
    const init = await until(() => lines.find((line) => line.id === 1)) as { result: { capabilities: { tools: { listChanged: boolean } } } };
    assert.equal(init.result.capabilities.tools.listChanged, true);
    writeFileSync(join(dir, "tools.json"), JSON.stringify({ supervisor: [tool("status"), tool("amend_lane")] }));
    assert.ok(await until(() => lines.find((line) => line.method === "notifications/tools/list_changed")), "the seat was told");
    ask(2, "tools/list");
    const listed = await until(() => lines.find((line) => line.id === 2)) as { result: { tools: { name: string }[] } };
    assert.deepEqual(listed.result.tools.map((t) => t.name), ["status", "amend_lane"]);
  } finally {
    server.kill("SIGKILL");
  }
});
