import type { Seen, Stream, StreamRow } from "./ports.ts";

type Cursor = { epoch: string; seq: number };

export type StreamMessage = {
  event: { type: string; item?: Record<string, unknown>; turnId?: string | null; error?: string; epoch?: string };
  seq?: number;
  epoch?: string;
};

export type Page = {
  epoch: string;
  entries: { item: Record<string, unknown>; seqStart: number; seqEnd: number; turnId?: string | null }[];
  agent?: { activeTurn?: { turnId?: string | null; startedAt?: string | null } | null } | null;
  reset?: boolean;
  staleCursor?: boolean;
  error?: string | null;
};

export type TimelineHandle = {
  subscribe(handler: (message: StreamMessage) => void): (() => void) & { readonly ready: Promise<void> };
  refetch(options: { direction: "tail" | "after"; cursor?: Cursor; limit?: number; projection: "canonical" | "projected" }): Promise<Page>;
};

export type FollowOptions = { readyMs?: number; log?: (line: string, error?: unknown) => void; archived?: () => Promise<boolean> };

const ENDED: Record<string, "completed" | "failed" | "canceled"> = { turn_completed: "completed", turn_failed: "failed", turn_canceled: "canceled" };

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export function follow(timeline: TimelineHandle, see: (seen: Seen) => void, options: FollowOptions = {}): Stream {
  const { readyMs = 10_000, log = (line, error) => console.error(`seatworks-v2: ${line}`, error ?? ""), archived = async () => false } = options;
  const seedRows = 200;
  let stopped = false;
  let joined = false;
  let epoch: string | undefined;
  let last = 0;
  let chain: Promise<void> = Promise.resolve();
  const early: StreamMessage[] = [];

  const tell = (seen: Seen) => {
    if (stopped) return;
    try {
      see(seen);
    } catch (error) {
      log("a watched row could not be read:", error);
    }
  };

  const take = (item: Record<string, unknown> | undefined, seq: number, turnId: string | null | undefined, replay: boolean) => {
    if (seq <= last || !epoch) return;
    last = seq;
    if (!item || item.type === "plugin") return;
    const row: StreamRow = { item, seq, epoch, turnId: turnId ?? null, replay };
    tell({ kind: "row", row });
  };

  // Stop once archived: Paseo resumes an archived agent to serve its history and never closes it again.
  const gone = async (): Promise<boolean> => {
    if (!stopped && (await archived())) {
      stopped = true;
      unsubscribe();
    }
    return stopped;
  };

  const seed = async () => {
    if (await gone()) return;
    const page = await timeline.refetch({ direction: "tail", limit: seedRows, projection: "canonical" });
    if (page.error) throw new Error(page.error);
    epoch = page.epoch;
    last = 0;
    const live = new Set(early.flatMap((message) => (message.event.type === "timeline" && message.epoch === page.epoch && typeof message.seq === "number" ? [message.seq] : [])));
    for (const entry of page.entries) take(entry.item, entry.seqEnd, entry.turnId, !entry.turnId || !live.has(entry.seqEnd));
    const active = page.agent?.activeTurn;
    if (active) {
      const at = Date.parse(active.startedAt ?? "");
      tell({ kind: "turn", phase: "started", turnId: active.turnId ?? null, ...(Number.isFinite(at) ? { at } : {}) });
    }
  };

  const fill = async (from: number) => {
    if (await gone()) return;
    const page = await timeline.refetch({ direction: "after", cursor: { epoch: epoch!, seq: from }, projection: "canonical" });
    if (page.error) throw new Error(page.error);
    if (page.reset || page.staleCursor || page.epoch !== epoch) {
      tell({ kind: "reset" });
      await seed();
      return;
    }
    for (const entry of page.entries) take(entry.item, entry.seqEnd, entry.turnId, !entry.turnId);
  };

  const handle = async (message: StreamMessage) => {
    const { event } = message;
    if (event.type === "replacement") {
      tell({ kind: "reset" });
      await seed();
      return;
    }
    if (event.type === "turn_started") {
      tell({ kind: "turn", phase: "started", turnId: event.turnId ?? null });
      return;
    }
    const ended = ENDED[event.type];
    if (ended) {
      tell({ kind: "turn", phase: ended, turnId: event.turnId ?? null, ...(event.error ? { error: event.error } : {}) });
      return;
    }
    if (event.type !== "timeline" || typeof message.seq !== "number" || !message.epoch) return;
    if (message.epoch !== epoch) {
      tell({ kind: "reset" });
      if (message.seq === 1) {
        epoch = message.epoch;
        last = 0;
      } else await seed();
    }
    if (message.seq <= last) return;
    if (message.seq > last + 1) await fill(last);
    take(event.item, message.seq, event.turnId, !event.turnId);
  };

  const queue = (message: StreamMessage) => {
    chain = chain.then(() => handle(message)).catch((error) => log("a watched timeline could not be followed:", error));
  };

  const unsubscribe = timeline.subscribe((message) => {
    if (stopped) return;
    if (joined) queue(message);
    else early.push(message);
  });

  const ready = (async () => {
    await within(unsubscribe.ready, readyMs, "joining a seat's timeline");
    await seed();
    joined = true;
    for (const message of early.splice(0)) queue(message);
  })();
  ready.catch(() => {
    stopped = true;
    unsubscribe();
  });

  return {
    ready,
    stop() {
      stopped = true;
      unsubscribe();
    },
  };
}
