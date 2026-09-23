import type { PendingPermission, PermissionResponse, SeatView } from "./paseo.ts";

export type { PendingPermission, PermissionResponse, SeatView };

export type SeatLook = {
  id: string;
  projectId?: string | null;
  workspaceId?: string | null;
  labels?: Record<string, string>;
  provider?: string;
  title?: string | null;
  cwd?: string | null;
  status?: string | null;
  archivedAt?: string | null;
  pendingPermissions?: PendingPermission[];
};

export type SeatSpec = {
  idempotencyKey?: string;
  config: Record<string, unknown>;
  parent?: string;
  title: string;
  prompt?: string;
  labels: Record<string, string>;
};

export type StreamRow = { item: Record<string, unknown>; seq: number; epoch: string; turnId: string | null; replay: boolean };

export type Seen =
  | { kind: "row"; row: StreamRow }
  | { kind: "turn"; phase: "started" | "completed" | "failed" | "canceled"; turnId: string | null; error?: string; at?: number }
  | { kind: "reset" };

export type Stream = { readonly ready: Promise<void>; stop(): void };

export type Seats = {
  open(): Promise<SeatView[]>;
  look(id: string): Promise<SeatLook>;
  send(id: string, text: string, steer?: boolean): Promise<void>;
  respond(id: string, requestId: string, response: PermissionResponse): Promise<void>;
  archive(id: string): Promise<void>;
  watch(id: string, see: (seen: Seen) => void): Stream;
};

export type Workspace = { id: string; project: string };

export type Workspaces = {
  named(name: string): Promise<Workspace | undefined>;
  owned(prefix: string): Promise<{ id: string; name: string }[]>;
  make(title: string, path: string, project?: string): Promise<Workspace>;
  seat(workspace: string, spec: SeatSpec): Promise<SeatLook>;
  archive(workspace: string): Promise<void>;
};
