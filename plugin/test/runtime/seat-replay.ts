import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../server/catalog/kit/kit.ts";
import { watchPatterns } from "../../server/catalog/kit/ecosystem-patterns.ts";
import type { Quirks } from "../../server/catalog/kit/timeline.ts";
import type { Seen } from "../../server/core/ports.ts";
import type { StreamMessage } from "../../server/adapters/paseo/stream.ts";
import type { Fact } from "../../server/domain/incident.ts";
import type { Rules } from "../../server/runtime/watch/facts.ts";
import type { HandedBack } from "../../server/runtime/watch/turn-facts.ts";
import { type SeatContext, SeatWatch } from "../../server/runtime/watch/watches.ts";

const here = dirname(fileURLToPath(import.meta.url));

export const kit = loadKit(join(here, "..", ".."));

export const fixture = (name: string): StreamMessage[] =>
  readFileSync(join(here, "..", "fixtures", "stream", `${name}.jsonl`), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamMessage);

export const rules = (extra: Partial<Rules> = {}): Rules => ({
  ...watchPatterns(kit, kit.attention),
  gates: [],
  repeatsAt: 3,
  recoverWithin: 10,
  refusalsAt: 3,
  stuckWithin: 20,
  monologueAt: 10,
  compactionsAt: 2,
  ...extra,
});

function toSeen(message: StreamMessage, epochs: Map<string, number>): Exclude<Seen, { kind: "lost" }> | undefined {
  const { event } = message;
  if (event.type === "turn_started") return { kind: "turn", phase: "started", turnId: event.turnId ?? null };
  if (event.type === "turn_completed") return { kind: "turn", phase: "completed", turnId: event.turnId ?? null };
  if (event.type !== "timeline" || typeof message.seq !== "number") return undefined;
  if (!epochs.has(message.epoch!)) epochs.set(message.epoch!, epochs.size);
  const replay = epochs.get(message.epoch!)! > 0;
  return {
    kind: "row",
    row: {
      item: event.item!,
      seqStart: message.seq,
      seq: message.seq,
      epoch: message.epoch!,
      turnId: event.turnId ?? null,
      replay,
    },
  };
}

/** A seat's watch over `context`, told recorded messages as the follower tells them: each fact carries the seq it came on. */
export function watchOver(context: () => SeatContext | undefined, quirks?: Quirks) {
  const watch = new SeatWatch({ id: "s1", provider: "sw3-peer-claude", cwd: "/work" }, context, quirks);
  const epochs = new Map<string, number>();
  let now = 1_000;
  return (messages: StreamMessage[]) => {
    const facts: (Fact & { seq?: number })[] = [];
    for (const message of messages) {
      const fresh = typeof message.epoch === "string" && epochs.size > 0 && !epochs.has(message.epoch);
      const seen = toSeen(message, epochs);
      if (!seen) continue;
      if (fresh) watch.see({ kind: "reset" }, now);
      now += 1_000;
      for (const fact of watch.see(seen, now)) facts.push({ ...fact, seq: message.seq });
    }
    return facts;
  };
}

/** `handed` is a hand-back the turn made, if it made one, or only its outcome; `quirks` are the harness's way of writing its timeline. */
export function play(messages: StreamMessage[], given: Rules, handed?: string | HandedBack, quirks?: Quirks) {
  const back = typeof handed === "string" ? { outcome: handed, summary: "" } : handed;
  return watchOver(() => ({ rules: given, handedBack: () => back, heard: () => true, placed: true }), quirks)(messages);
}

export const kinds = (facts: Fact[]) => facts.map((fact) => fact.kind);

/** A completed edit to borrow the shape of: each test sets the path and text it needs. */
export const editCall = () =>
  fixture("codex").find(
    (message) => message.event.item?.name === "apply_patch" && message.event.item?.status === "completed",
  )!;

export const piRow = (seq: number) =>
  fixture("pi").find((message) => message.seq === seq && message.epoch === fixture("pi")[1]!.epoch)!;

export function again(
  message: StreamMessage,
  callId: string,
  seq: number,
  change: (detail: Record<string, unknown>) => void = () => {},
): StreamMessage {
  const copy = JSON.parse(JSON.stringify(message)) as StreamMessage;
  copy.event.item!.callId = callId;
  change(copy.event.item!.detail as Record<string, unknown>);
  copy.seq = seq;
  copy.epoch = fixture("pi")[1]!.epoch;
  return copy;
}

export const opening = (): StreamMessage[] => [fixture("pi")[0]!, fixture("pi")[1]!];

export const claudeTurn2 = () =>
  fixture("claude")
    .filter((message) => message.epoch === fixture("claude")[1]!.epoch || !message.epoch)
    .map(
      (message) =>
        JSON.parse(JSON.stringify(message).replace(/sleep 5; echo (alpha|beta|gamma)/g, "npm test")) as StreamMessage,
    )
    .map((message) => {
      const item = message.event.item;
      if (item?.type === "tool_call" && item.name === "Bash" && item.status === "completed")
        Object.assign(item, { status: "failed", error: { content: "1 failing" } });
      return message;
    });
