import { sentBy } from "../../core/paseo-adapter.ts";
import type { StreamRow } from "../../core/ports.ts";

export type Detail = {
  type?: string;
  command?: string;
  filePath?: string;
  oldString?: string;
  newString?: string;
  content?: string;
  output?: string;
  exitCode?: number | null;
  [key: string]: unknown;
};

const UNITS = 80;

export type Call = {
  id: string;
  name: string;
  status: string;
  detail: Detail;
  error: unknown;
  ended: boolean;
  pseudo: boolean;
};

export type Unit =
  | { kind: "user"; text: string }
  | { kind: "call"; call: Call }
  | { kind: "said"; text: string; messageId?: string }
  | { kind: "thought"; text: string }
  | { kind: "compaction" }
  | { kind: "error"; text: string };

export type Change = { call?: Call; detailed: boolean; settled: boolean };

const TERMINAL = new Set(["completed", "failed", "canceled"]);

/** Devin names a file it creates "Wrote <path>": the path is what every reader of a write compares. */
function withPath(detail: Detail): Detail {
  const path = detail.filePath;
  return typeof path === "string" && path.startsWith("Wrote ") ? { ...detail, filePath: path.slice("Wrote ".length) } : detail;
}

function pseudo(item: Record<string, unknown>): boolean {
  const metadata = item.metadata as { synthetic?: unknown } | undefined;
  const detail = item.detail as { type?: unknown } | undefined;
  return metadata?.synthetic === true || (item.name === "terminal" && detail?.type === "plain_text");
}
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export class Window {
  readonly units: Unit[] = [];
  private readonly calls = new Map<string, Call>();
  private readonly limit: number;
  private instruction: { text: string; from: string[] } = { text: "", from: [] };
  private instructionAt = -1;
  private pushed = 0;

  constructor() {
    this.limit = UNITS;
  }

  add(row: StreamRow): Change {
    const item = row.item;
    const type = text(item.type);
    if (type === "tool_call") return this.called(row);
    if (type === "user_message") {
      this.instruction = { text: text(item.text), from: sentBy(item) };
      this.push({ kind: "user", text: this.instruction.text });
      this.instructionAt = this.pushed - 1;
    }
    else if (type === "assistant_message") this.join("said", text(item.text), text(item.messageId) || undefined);
    else if (type === "reasoning") this.join("thought", text(item.text));
    else if (type === "compaction") this.push({ kind: "compaction" });
    else if (type === "error") this.push({ kind: "error", text: text(item.message) || text(item.text) });
    return { detailed: false, settled: false };
  }

  closeRunning(): void {
    for (const call of this.calls.values()) {
      if (call.ended) continue;
      call.ended = true;
      call.status = "canceled";
    }
  }

  clear(): void {
    this.units.length = 0;
    this.calls.clear();
    this.instruction = { text: "", from: [] };
    this.instructionAt = -1;
    this.pushed = 0;
  }

  sinceInstruction(): Unit[] {
    return this.units.slice(Math.max(0, this.instructionAt + 1 - (this.pushed - this.units.length)));
  }

  lastInstruction(): { text: string; from: string[] } {
    return this.instruction;
  }

  lostSinceInstruction(): number {
    return Math.max(0, this.pushed - this.units.length - (this.instructionAt + 1));
  }

  private called(row: StreamRow): Change {
    const item = row.item;
    const id = text(item.callId) || `seq-${row.seq}`;
    const status = text(item.status) || "running";
    const detail = withPath((item.detail && typeof item.detail === "object" ? item.detail : {}) as Detail);
    const seen = this.calls.get(id);
    if (!seen) {
      const call: Call = {
        id,
        name: text(item.name),
        status,
        detail,
        error: item.error ?? null,
        ended: TERMINAL.has(status),
        pseudo: pseudo(item),
      };
      this.calls.set(id, call);
      this.push({ kind: "call", call });
      return { call, detailed: detail.type !== undefined && detail.type !== "unknown", settled: call.ended };
    }
    const known = seen.detail.type !== undefined && seen.detail.type !== "unknown";
    const better = detail.type !== undefined && detail.type !== "unknown";
    const detailed = !known && better;
    if (better) seen.detail = { ...seen.detail, ...detail };
    if (seen.ended) return { call: seen, detailed, settled: false };
    seen.status = status;
    if (status === "failed") seen.error = item.error ?? seen.error;
    const settled = TERMINAL.has(status);
    seen.ended = settled;
    return { call: seen, detailed, settled };
  }

  private join(kind: "said" | "thought", piece: string, messageId?: string): void {
    if (!piece) return;
    const last = this.units[this.units.length - 1];
    if (last?.kind === kind && (kind === "thought" || (last as { messageId?: string }).messageId === messageId)) {
      last.text += piece;
      return;
    }
    this.push(kind === "said" ? { kind, text: piece, ...(messageId ? { messageId } : {}) } : { kind, text: piece });
  }

  private push(unit: Unit): void {
    this.units.push(unit);
    this.pushed += 1;
    if (this.units.length <= this.limit) return;
    const dropped = this.units.shift();
    if (dropped?.kind === "call") this.calls.delete(dropped.call.id);
  }
}
