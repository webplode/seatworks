import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { z } from "zod";
import type { ToolReply, ToolRequest } from "../../desk/context.ts";
import { daemonLog } from "../../core/logger.ts";

const FRAME_BYTES = 1024 * 1024;

const Heard = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), key: z.string(), role: z.string(), cwd: z.string() }),
  z.object({ type: z.literal("call"), id: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("cancel"), id: z.string() }),
  z.object({ type: z.literal("taken"), id: z.string() }),
]);

type Choices = Record<string, Record<string, string[]>>;

type LineDesk = {
  whose(key: string): { agent: string } | { refused: string };
  choices(role: string, cwd: string): Choices;
  answer(request: ToolRequest, cancelled: AbortSignal): Promise<ToolReply>;
  mailLost(request: ToolRequest, reply: ToolReply): Promise<unknown>;
};

type Call = { request: ToolRequest; stop: AbortController; reply?: ToolReply };
type Line = {
  socket: Socket;
  agent?: string;
  refused?: string;
  role: string;
  cwd: string;
  shown?: string;
  calls: Map<string, Call>;
};

const UNHEARD = "The desk does not know which agent this is: its team server has not said. Say so, and end your turn.";

/** Where seats' team servers reach the desk: one line each, a call answered on the line it came by. */
export class TeamSocket {
  private readonly path: string;
  private readonly pipe: boolean;
  private readonly desk: LineDesk;
  private readonly lines = new Set<Line>();
  private server: Server | undefined;

  constructor(path: string, desk: LineDesk) {
    this.path = path;
    this.pipe = path.startsWith("\\\\.\\pipe\\");
    this.desk = desk;
  }

  /** A socket file left by a plugin that stopped without closing it is taken over. */
  listen(): void {
    if (!this.pipe) rmSync(this.path, { force: true });
    const server = createServer((socket) => this.serve(socket));
    server.on("error", (error) => daemonLog.error("the desk's socket failed:", error));
    server.listen(this.path, () => {
      if (!this.pipe) chmodSync(this.path, 0o600);
    });
    this.server = server;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    for (const line of this.lines) line.socket.destroy();
    if (!this.pipe) rmSync(this.path, { force: true });
  }

  /** Whether the agent waits on a call: answered or not, until its server says the harness took the answer. */
  calling(agent: string): boolean {
    return [...this.lines].some((line) => line.agent === agent && line.calls.size > 0);
  }

  /** The sets seats' fields take may have changed: a line whose set did is sent the new one. */
  refresh(): void {
    for (const line of this.lines) if (line.agent) this.offer(line, "choices");
  }

  private serve(socket: Socket): void {
    const line: Line = { socket, role: "", cwd: "", calls: new Map() };
    this.lines.add(line);
    // A message ends at "\n" alone: separators that are legal inside JSON strings stay inside the message.
    let rest = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      rest += chunk;
      for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
        const text = rest.slice(0, at);
        rest = rest.slice(at + 1);
        if (Buffer.byteLength(text) > FRAME_BYTES) return this.oversized(line, socket);
        this.heard(line, text);
      }
      if (Buffer.byteLength(rest) > FRAME_BYTES) this.oversized(line, socket);
    });
    socket.on("error", () => {});
    socket.on("close", () => this.dropped(line));
  }

  private heard(line: Line, text: string): void {
    if (!text.trim()) return;
    let said: z.infer<typeof Heard>;
    try {
      said = Heard.parse(JSON.parse(text));
    } catch {
      daemonLog.error(
        `the desk's socket heard an unreadable line from ${line.agent ?? "an unknown seat"} (${Buffer.byteLength(text)} bytes)`,
      );
      return;
    }
    if (said.type === "hello") return this.hello(line, said);
    if (said.type === "call") return this.call(line, said);
    const call = line.calls.get(said.id);
    line.calls.delete(said.id);
    if (call && said.type === "cancel") this.lose(call);
  }

  private oversized(line: Line, socket: Socket): void {
    daemonLog.error(
      `the desk's socket heard an unreadable line from ${line.agent ?? "an unknown seat"} (more than ${FRAME_BYTES} bytes)`,
    );
    socket.destroy();
  }

  private hello(line: Line, said: { key: string; role: string; cwd: string }): void {
    if (line.agent) return;
    const whose = this.desk.whose(said.key);
    if ("refused" in whose) {
      line.refused = whose.refused;
      return this.send(line, { type: "refused", why: whose.refused });
    }
    Object.assign(line, { agent: whose.agent, role: said.role, cwd: said.cwd });
    this.offer(line, "welcome");
  }

  private offer(line: Line, type: "welcome" | "choices"): void {
    const choices = this.desk.choices(line.role, line.cwd);
    const shown = JSON.stringify(choices);
    if (type === "choices" && shown === line.shown) return;
    line.shown = shown;
    this.send(line, { type, choices });
  }

  private call(line: Line, said: { id: string; tool: string; args: Record<string, unknown> }): void {
    if (!line.agent) return this.send(line, { type: "result", id: said.id, ok: false, text: line.refused ?? UNHEARD });
    const call: Call = {
      request: {
        id: randomUUID(),
        agent: line.agent,
        role: line.role,
        tool: said.tool,
        args: said.args,
        cwd: line.cwd,
        at: Date.now(),
      },
      stop: new AbortController(),
    };
    line.calls.set(said.id, call);
    void this.desk.answer(call.request, call.stop.signal).then((reply) => {
      // Stopped, or its line gone: that answer goes as a letter instead.
      if (line.calls.get(said.id) !== call) return;
      call.reply = reply;
      this.send(line, { type: "result", id: said.id, ...reply });
    });
  }

  /** A call whose seat will not take its answer here: stopped before it came, the desk mails it when it does; after, it is mailed now. */
  private lose(call: Call): void {
    if (call.reply)
      void this.desk
        .mailLost(call.request, call.reply)
        .catch((error: unknown) => daemonLog.error("a reply that did not reach its seat could not be mailed:", error));
    else call.stop.abort();
  }

  private dropped(line: Line): void {
    this.lines.delete(line);
    for (const call of line.calls.values()) this.lose(call);
    line.calls.clear();
  }

  private send(line: Line, message: object): void {
    if (!line.socket.destroyed) line.socket.write(`${JSON.stringify(message)}\n`);
  }
}
