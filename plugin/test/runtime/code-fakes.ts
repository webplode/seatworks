import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { tempDir } from "../tempdir.ts";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROXY = join(PLUGIN, "mcp", "code.mjs");

type Entry = {
  label: string;
  instructions: string;
  proxy: Record<string, unknown> & { wait: Record<string, unknown>; descriptions: Record<string, string> };
};

export const entry = (id: string) =>
  JSON.parse(readFileSync(join(PLUGIN, "catalog", "mcp", id, "mcp.json"), "utf-8")) as Entry;

export type Call = { name: string; args: Record<string, unknown> };

export type IdeOptions = {
  openEnabled?: boolean;
  dumbCalls?: number;
  routeRequired?: boolean;
  session?: boolean;
  streamed?: boolean;
  syncMs?: number;
  port?: number;
  held?: boolean;
  tools?: string[];
  malformed?: boolean;
};

type Message = { id?: number; method: string; params?: Record<string, unknown> };

/**
 * An IDE's MCP server over HTTP, plain JSON by default. `session` asks for its session id after the handshake, `streamed`
 * answers a call as a stream, a progress note first, `held` keeps calls until `release()`, `tools` is what it lists.
 */
export async function fakeIde(t: TestContext, options: IdeOptions = {}) {
  const calls: Call[] = [];
  const received: string[] = [];
  const notified: string[] = [];
  const order: string[] = [];
  const open = new Set<string>();
  const waiting: (() => void)[] = [];
  let dumb = options.dumbCalls ?? 0;
  const listed = options.tools ?? ["ide_find_references"];
  const reply = (message: Message, response: ServerResponse, result: unknown) => {
    const answer = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    const headers = options.session ? { "Mcp-Session-Id": "s1" } : {};
    if (!options.streamed || message.method !== "tools/call")
      return void response.writeHead(200, { "Content-Type": "application/json", ...headers }).end(answer);
    const token = (message.params?._meta as { progressToken?: unknown } | undefined)?.progressToken;
    const progress = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: token, progress: 1, message: "indexing" },
    };
    const note = token === undefined ? "" : `event: message\ndata: ${JSON.stringify(progress)}\n\n`;
    // The note while the work goes on, the answer a moment later, as a call that takes a while streams them.
    response.writeHead(200, { "Content-Type": "text/event-stream", ...headers }).write(note);
    setTimeout(() => response.end(`event: message\ndata: ${answer}\n\n`), 200);
  };
  const answerCall = (message: Message, response: ServerResponse) => {
    const name = String(message.params?.name);
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name, args });
    order.push(name);
    const text = (value: string, isError = false) =>
      reply(message, response, { content: [{ type: "text", text: value }], isError });
    if (name === "ide_open_project") {
      if (options.openEnabled === false) return text(`Tool ${name} not found`, true);
      if (options.routeRequired && !args.project_path) {
        const available = [{ name: "main", path: "/already/open" }];
        const refusal = {
          error: "multiple_projects_open",
          message: "Multiple projects are open.",
          available_projects: available,
        };
        return text(JSON.stringify(refusal), true);
      }
      open.add(String(args.path));
      return text("opened");
    }
    if (name === "ide_close_project") {
      open.delete(String(args.project_path));
      return text("closed");
    }
    if (name === "ide_sync_files")
      return void setTimeout(() => (order.push("synced"), text("synced")), options.syncMs ?? 0);
    if (name === "ide_index_status") return text(JSON.stringify({ isDumbMode: dumb > 0 }));
    if (name === "ide_find_symbol") return text(`Tool ${name} not found`, true);
    if (name === "ide_diagnostics")
      return text(
        "java.util.concurrent.ExecutionException: com.redhat.devtools.lsp4ij.server.CannotStartProcessException: harper-ls",
        true,
      );
    if (!open.has(String(args.project_path)))
      return text('{"error":"project_not_found","message":"No open project matches"}', true);
    if (dumb > 0) {
      dumb--;
      return text("IDE index is not ready (dumb mode) — IntelliJ is indexing in the background.", true);
    }
    text(`references in ${String(args.project_path)}`);
  };
  const handle = (request: IncomingMessage, response: ServerResponse, body: string) => {
    const message = JSON.parse(body) as Message;
    if (options.session && message.method !== "initialize" && request.headers["mcp-session-id"] !== "s1")
      return void response.writeHead(400).end("no session");
    if (message.id === undefined) {
      notified.push(message.method);
      return void response.writeHead(202).end();
    }
    if (message.method === "initialize")
      return reply(message, response, {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-ide", version: "0" },
      });
    if (message.method === "tools/list") {
      const schema = {
        type: "object",
        properties: { project_path: { type: "string" }, file: { type: "string" } },
        required: ["project_path"],
      };
      const describe = (name: string) =>
        name === "ide_find_references"
          ? {
              name,
              title: "Find references",
              annotations: { readOnlyHint: true, openWorldHint: false },
              description: "refs",
              inputSchema: schema,
            }
          : { name, description: name, inputSchema: schema };
      return reply(message, response, { tools: options.malformed ? [null] : listed.map(describe) });
    }
    received.push(String(message.params?.name));
    if (options.held) return void waiting.push(() => answerCall(message, response));
    answerCall(message, response);
  };
  const server = createServer((request, response) => {
    if (request.method !== "POST") return void response.writeHead(405).end();
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => handle(request, response, body));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const release = () => {
    for (const answer of waiting.splice(0)) answer();
  };
  const close = () => {
    release();
    server.closeAllConnections();
    if (server.listening) server.close();
  };
  t.after(close);
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, port, calls, received, notified, order, open, release, close };
}

export function repo(): string {
  const dir = tempDir("sw3-code-");
  execFileSync("git", ["init", "-q", dir]);
  return realpathSync(dir);
}

/** A code search server over stdio that writes its pid beside itself; `listMs` holds its first tool list back that long after a quick handshake. */
export function fakeSemble(listMs = 0): string {
  const file = join(tempDir("sw3-semble-"), "semble.mjs");
  writeFileSync(
    file,
    `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.argv[1] + ".pid", String(process.pid));
const tools = [
  { name: "search", description: "semble search", inputSchema: { type: "object", properties: { query: { type: "string" }, repo: { type: "string" } }, required: ["query", "repo"] } },
  { name: "find_related", description: "related", inputSchema: { type: "object", properties: {} } },
];
let first = true;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const hello = { protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-semble", version: "0" } };
  const result = m.method === "tools/call" ? { content: [{ type: "text", text: JSON.stringify(m.params.arguments) }] } : m.method === "tools/list" ? { tools } : m.method === "initialize" ? hello : {};
  const answer = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "tools/list" && first) setTimeout(answer, ${listMs});
  else answer();
  if (m.method === "tools/list") first = false;
});
`,
  );
  return file;
}

/** The shipped IntelliJ entry as the desk hands it to a seat's proxy, reaching `url` (each in turn) and waiting briefly on its index. */
export function ideConfig(url: string | string[], tools: string[]) {
  const { label, instructions, proxy } = entry("intellij-index");
  return {
    name: "intellij-index",
    label,
    instructions,
    tools,
    ...proxy,
    backend: { type: "http", urls: [url].flat() },
    wait: { ...proxy.wait, seconds: 2, pollSeconds: 0.01 },
  };
}

/** The shipped code search entry as the desk hands it to a seat's proxy, started as `command`. */
export function searchConfig(command: string[], extra: object = {}) {
  const { label, instructions, proxy } = entry("code-search");
  return {
    name: "code-search",
    label,
    instructions,
    tools: ["search"],
    ...proxy,
    ...extra,
    backend: { type: "stdio", command },
  };
}

type Replied = { isError?: boolean; content: { text: string }[] };

/** A harness with the proxy for `config` started in `cwd`, as an SDK client over its stdio. */
export async function proxy(
  t: TestContext,
  cwd: string,
  config: object,
  changed?: () => void,
  env: Record<string, string> = {},
) {
  const client = new Client(
    { name: "probe", version: "0" },
    changed ? { listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: changed } } } : {},
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [PROXY, JSON.stringify(config)],
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "inherit",
  });
  await client.connect(transport);
  const stop = () => client.close();
  t.after(stop);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as Replied;
  const tools = async () => (await client.listTools()).tools;
  return { client, call, tools, pid: transport.pid!, stop };
}

export const work = (calls: Call[]) =>
  calls.filter((call) => !["ide_sync_files", "ide_index_status"].includes(call.name)).map((call) => call.name);

/** Whether no process has this id any more. */
export function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** Resolves once `check` holds, polling while the processes do their part; false if it never does within `ms`. */
export const within = async (ms: number, check: () => boolean | Promise<boolean>) => {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 20)))
    if (Date.now() > end) return false;
  return true;
};
