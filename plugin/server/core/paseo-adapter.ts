import { createPaseoClient, type PaseoClientConfig } from "@getpaseo/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { paseoConfigPath } from "./paths.ts";
import type { HostInventory } from "../../shared/supervision.ts";
import type { PaseoApi, PendingPermission, PermissionResponse, SeatView } from "./paseo.ts";
import type { SeatLook, SeatSpec, Seats, Workspace, Workspaces } from "./ports.ts";
import { type TimelineHandle, follow } from "./stream.ts";

export type Bound = () => PaseoApi | undefined;

type Handle = {
  id: string;
  status?: string | null;
  cwd?: string | null;
  archivedAt?: string | null;
  pendingPermissions?: PendingPermission[];
  refresh(): Promise<unknown>;
  current(): { id?: string; workspaceId?: string | null; labels?: Record<string, string>; provider?: string; cwd?: string | null; title?: string | null } | null | undefined;
  send(text: string, options?: { activeTurnBehavior?: "steer" }): Promise<unknown>;
  respondToPermission(options: { requestId: string; response: PermissionResponse }): Promise<unknown>;
  archive(): Promise<unknown>;
  timeline: TimelineHandle;
};

const reach = (bound: Bound): PaseoApi => {
  const paseo = bound();
  if (!paseo) throw new Error("the daemon has not reached this plugin yet");
  return paseo;
};

function lookOf(handle: Handle): SeatLook {
  const snapshot = handle.current();
  return {
    id: handle.id,
    workspaceId: snapshot?.workspaceId,
    labels: snapshot?.labels,
    provider: snapshot?.provider,
    title: snapshot?.title ?? null,
    cwd: handle.cwd ?? snapshot?.cwd ?? null,
    status: handle.status ?? null,
    archivedAt: handle.archivedAt ?? null,
    pendingPermissions: handle.pendingPermissions ?? [],
  };
}

export function seatsOn(bound: Bound): Seats {
  const ref = (id: string): Handle => reach(bound).agents.ref(id) as unknown as Handle;
  return {
    /** Paged: an unpaged read is capped by the daemon, and a seat missing from this list is treated as gone. */
    async open(): Promise<SeatView[]> {
      const paseo = bound();
      if (!paseo) throw new Error("Paseo is not connected; agent coverage is unknown.");
      const found: SeatView[] = [];
      let cursor: string | undefined;
      const visited = new Set<string>();
      for (;;) {
        const result = await paseo.agents.list({ filter: { includeArchived: false }, page: cursor ? { limit: 200, cursor } : { limit: 200 } });
        for (const entry of result.entries) {
          const seat = entry.agent as unknown as SeatView;
          if (!seat.archivedAt) found.push(seat);
        }
        if (!result.pageInfo?.hasMore) break;
        if (!result.pageInfo.nextCursor || visited.has(result.pageInfo.nextCursor)) throw new Error("Paseo returned incomplete agent pagination.");
        cursor = result.pageInfo.nextCursor;
        visited.add(cursor);
      }
      return found;
    },
    async look(id: string): Promise<SeatLook> {
      const handle = ref(id);
      await handle.refresh();
      if (!handle.current()) throw new Error(`Agent ${id} is unavailable.`);
      const seat = lookOf(handle);
      if (seat.workspaceId) {
        const placement = await reach(bound).workspaces.ref(seat.workspaceId).refresh();
        if (!placement || placement.archivingAt) throw new Error(`Workspace ${seat.workspaceId} is unavailable.`);
        seat.projectId = placement.projectId;
      }
      return seat;
    },
    async send(id: string, text: string, steer = false): Promise<void> {
      // The daemon takes `activeTurnBehavior` though the SDK's type leaves it out.
      await ref(id).send(text, steer ? { activeTurnBehavior: "steer" } : undefined);
    },
    async respond(id: string, requestId: string, response: PermissionResponse): Promise<void> {
      await ref(id).respondToPermission({ requestId, response });
    },
    async archive(id: string): Promise<void> {
      await ref(id).archive();
    },
    watch(id, see) {
      const handle = ref(id);
      return follow(handle.timeline, see, {
        // A failed lookup reads as not archived: a seat stopped on a passing failure is never followed again.
        archived: async () => {
          try {
            await handle.refresh();
          } catch {
            return false;
          }
          return Boolean(handle.archivedAt);
        },
      });
    },
  };
}

export async function activityOn(bound: Bound, id: string, limit: number) {
  const page = await reach(bound).agents.ref(id).timeline.refetch({ direction: "tail", projection: "canonical", limit });
  if (page.error || page.staleCursor || page.gap) throw new Error(page.error || "Native timeline coverage is incomplete. Retry the read.");
  const entries = page.entries.slice(-limit);
  const chars = Math.min(4000, Math.floor(48000 / Math.max(entries.length, 1)));
  return { agent: id, observedAt: new Date().toISOString(), epoch: page.epoch, hasOlder: page.hasOlder,
    entries: entries.map((entry) => {
      const text = JSON.stringify(entry.item);
      return { seqStart: entry.seqStart, seqEnd: entry.seqEnd, turnId: entry.turnId ?? null,
        content: text.slice(0, chars), truncated: text.length > chars };
    }) };
}

export async function inventoryOn(bound: Bound): Promise<HostInventory> {
  const api = reach(bound);
  const listed = await api.projects.list();
  const projects = listed.projects.map((p) => ({ id: p.projectId, root: p.projectRootPath, name: p.projectDisplayName }));
  const workspaces: HostInventory["workspaces"] = [];
  let cursor: string | undefined;
  const visited = new Set<string>();
  for (;;) {
    const page = await api.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const w of page.entries) if (!w.archivingAt) workspaces.push({ id: w.id, project: w.projectId, path: w.workspaceDirectory });
    if (!page.pageInfo.hasMore) break;
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (!cursor || visited.has(cursor)) throw new Error("Paseo returned incomplete workspace pagination.");
    visited.add(cursor);
  }
  return { projects, workspaces };
}

export function startupConnection(config: PaseoClientConfig) {
  return createPaseoClient({ ...config, reconnect: { enabled: true }, connectTimeoutMs: 10_000 });
}

export async function connectLocal() {
  const { stdout } = await promisify(execFile)("paseo", ["daemon", "status", "--json"], { timeout: 10_000 });
  const status = JSON.parse(stdout);
  if (status.localDaemon !== "running" || status.home !== dirname(paseoConfigPath())) throw new Error("The local daemon's identity could not be verified for startup recovery.");
  const address = status.listen;
  if (typeof address !== "string" || !/^(127\.0\.0\.1|localhost):\d+$/.test(address)) throw new Error("Startup recovery requires a verified local loopback daemon.");
  const client = startupConnection({ url: `ws://${address}/ws`, ...(process.env.SEATWORKS_PASEO_PASSWORD ? { password: process.env.SEATWORKS_PASEO_PASSWORD } : {}) });
  try { await client.connect(); return client; }
  catch (error) { await client.close(); throw error; }
}

export function workspacesOn(bound: Bound): Workspaces {
  return {
    async named(name: string): Promise<Workspace | undefined> {
      const paseo = reach(bound);
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await paseo.workspaces.list({ page: cursor ? { limit: 200, cursor } : { limit: 200 } });
        for (const entry of result.entries) {
          if (entry.name === name && !entry.archivingAt) return { id: entry.id, project: entry.projectId };
        }
        if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) return undefined;
        cursor = result.pageInfo.nextCursor;
      }
      return undefined;
    },
    async owned(prefix: string): Promise<{ id: string; name: string }[]> {
      const paseo = bound();
      if (!paseo) return [];
      const found: { id: string; name: string }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await paseo.workspaces.list({ page: cursor ? { limit: 200, cursor } : { limit: 200 } });
        for (const entry of result.entries) {
          const name = entry.name ?? "";
          if (!entry.archivingAt && (name === prefix || name.startsWith(`${prefix} `))) found.push({ id: entry.id, name });
        }
        if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
        cursor = result.pageInfo.nextCursor;
      }
      return found;
    },
    async make(title: string, path: string, project?: string): Promise<Workspace> {
      const source = project ? { kind: "directory" as const, path, projectId: project } : { kind: "directory" as const, path };
      const workspace = await reach(bound).workspaces.create({ title, source });
      return { id: workspace.id, project: workspace.projectId ?? "" };
    },
    async archive(workspace: string): Promise<void> {
      // The daemon reports a refusal as `error` in the payload, not as a throw.
      const result = (await reach(bound).workspaces.archive(workspace)) as { error?: string | null } | undefined;
      if (result?.error) throw new Error(result.error);
    },
    async seat(workspace: string, spec: SeatSpec): Promise<SeatLook> {
      const handle = (await reach(bound)
        .workspaces.ref(workspace)
        .agents.create({
          ...(spec.idempotencyKey ? { idempotencyKey: spec.idempotencyKey } : {}),
          config: spec.config as never,
          parent: spec.parent,
          title: spec.title.slice(0, 60),
          prompt: spec.prompt,
          labels: spec.labels,
        })) as unknown as Handle;
      await handle.refresh();
      return lookOf(handle);
    },
  };
}
