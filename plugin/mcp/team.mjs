import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, watchFile, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const role = process.argv[2] ?? "";
const toolSet = process.argv[3] ?? "";
const spool = process.argv[4] ?? "";
const waitMs = Number(process.env.SEATWORKS_TOOL_WAIT_MS ?? 300000);

/** Codex filters the server's environment, so the agent id comes from the parent process, the agent's own. */
function agentId() {
  if (process.env.PASEO_AGENT_ID) return process.env.PASEO_AGENT_ID;
  try {
    const found = readFileSync(`/proc/${process.ppid}/environ`, "utf-8").split("\0").find((pair) => pair.startsWith("PASEO_AGENT_ID="));
    if (found) return found.slice("PASEO_AGENT_ID=".length);
  } catch {}
  try {
    const listed = execFileSync("ps", ["eww", "-o", "command=", "-p", String(process.ppid)], { encoding: "utf-8" });
    return /(?:^|\s)PASEO_AGENT_ID=(\S+)/.exec(listed)?.[1] ?? "";
  } catch {
    return "";
  }
}
const agent = agentId();
const toolsFile = join(dirname(fileURLToPath(import.meta.url)), "tools.json");
const readTools = () => JSON.parse(readFileSync(toolsFile, "utf-8"))[toolSet] ?? [];
let tools = readTools();
let started = false;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** A seat outlives plugin updates, so a tool added since it started reaches it by the list changing, not by a restart it never gets. */
watchFile(toolsFile, { interval: Number(process.env.SEATWORKS_TOOLS_POLL_MS ?? 5000) }, () => {
  let next;
  try {
    next = readTools();
  } catch {
    return;
  }
  if (JSON.stringify(next) === JSON.stringify(tools)) return;
  tools = next;
  if (started) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}).unref();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(name, args) {
  if (!spool) return { ok: false, text: "The team desk is not configured for this agent." };
  const id = randomUUID();
  const requests = join(spool, "requests");
  const replies = join(spool, "replies");
  mkdirSync(requests, { recursive: true });
  mkdirSync(replies, { recursive: true });
  const request = { id, agent, role, tool: name, args: args ?? {}, cwd: process.cwd(), at: Date.now() };
  const temp = join(requests, `${id}.tmp`);
  writeFileSync(temp, JSON.stringify(request));
  renameSync(temp, join(requests, `${id}.json`));
  const reply = join(replies, `${id}.json`);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (existsSync(reply)) {
      try {
        const value = JSON.parse(readFileSync(reply, "utf-8"));
        unlinkSync(reply);
        return value;
      } catch {
        await sleep(100);
        continue;
      }
    }
    await sleep(250);
  }
  // The desk answers or mails within four minutes; a retry served a second gate and landing beside the first.
  return { ok: false, text: "The team desk did not answer at all, so it is probably not running. Do not repeat the call; end your turn saying which call went unanswered." };
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "team", version: "2.0.0" } } });
    started = true;
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
  } else if (method === "tools/call") {
    const name = params?.name;
    if (!tools.some((tool) => tool.name === name)) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Unknown tool ${name}.` }], isError: true } });
      return;
    }
    const result = await call(name, params?.arguments);
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(result?.text ?? "") }], isError: !result?.ok } });
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
