import { z } from "zod";

export const Operation = z.enum(["observe", "message", "answer", "open_lane", "set_project", "close_lane", "land", "ack", "coordinate"]);
export type Operation = z.infer<typeof Operation>;
export const Association = z.object({
  agent: z.string().min(1), workspace: z.string().min(1), objective: z.string().min(1),
  ownership: z.array(z.string()).min(1), origin: z.enum(["managed", "external"]), lane: z.string().optional(),
});
export const ScopeProject = z.object({
  id: z.string().min(1), root: z.string().min(1), slug: z.string().min(1), name: z.string(),
  grants: z.array(Operation), leads: z.array(Association),
});
export const Binding = z.object({
  version: z.literal(2), revision: z.number().int().nonnegative(), active: z.boolean(),
  supervisor: z.object({ agent: z.string().min(1), workspace: z.string().min(1) }).nullable(),
  projects: z.array(ScopeProject),
});
export type Binding = z.infer<typeof Binding>;
export type ScopeProject = z.infer<typeof ScopeProject>;
export const BindingChange = z.object({
  revision: z.number().int().nonnegative(), active: z.boolean(), supervisor: z.string().nullable(),
  projects: z.array(z.object({ id: z.string(), grants: z.array(Operation) })),
});
export const LeadChange = z.object({
  revision: z.number().int().nonnegative(), project: z.string(), agent: z.string(),
  objective: z.string().min(1), ownership: z.array(z.string()).min(1), remove: z.boolean().optional(),
});
export const Dependency = z.object({
  id: z.string(), revision: z.number().int().nonnegative(),
  producer: z.object({ project: z.string(), agent: z.string() }),
  consumer: z.object({ project: z.string(), agent: z.string() }),
  request: z.string(), checkpoint: z.string(), artifact: z.string().nullable(),
  state: z.enum(["requested", "accepted", "delivered", "confirmed", "blocked", "canceled"]),
  by: z.string(), at: z.number(),
});
export type Dependency = z.infer<typeof Dependency>;
export type DeliveryGuard = { revision: number; actor: string; project: string; workspace: string; operation: Operation; recipient?: "supervisor" };
export type HostInventory = {
  projects: { id: string; root: string; name: string }[];
  workspaces: { id: string; project: string; path: string }[];
};
export type SupervisionView = {
  problems: Record<string, string>;
  binding: Binding; candidates: { id: string; root: string; name: string }[];
  supervisors: { id: string; title: string; workspace: string }[];
  agents: { id: string; title: string; workspace: string; project: string; capable: boolean; status: string; updatedAt: string; waiting: boolean }[];
  deliveries: { id: string; to: string; state: string; detail?: string; at: number; text: string; project: string }[];
  dependencies: Dependency[];
  communication: Record<string, { status: string; detail: string; at: number; callsToday: number }>;
};
