import { briefRpc, briefLabel } from "../shared/brief.ts";
import type { PluginClientContext } from "@getpaseo/plugin/client";

export function workspaceActions(client: PluginClientContext): () => void {
  let disposed = false;
  const headers = new Map<string, { remove(): void }>();
  const pills = new Map<string, { workspace: string; remove(): void; update(patch: { label: string }): void }>();
  const releases: (() => Promise<void>)[] = [];
  const button = (workspaceId: string) => ({ title: "Seatworks workspace actions", label: "Seatworks", icon: "Users", behavior: {
    kind: "menu" as const, items: [
      { kind: "item" as const, id: "activity", title: "Team activity", icon: "Activity", behavior: { kind: "action" as const, onPress: () => client.openPanel("activity", { workspaceId, location: "explorer" }) } },
      { kind: "item" as const, id: "team-models", title: "Team & models", icon: "SlidersHorizontal", behavior: { kind: "action" as const, onPress: () => client.openPanel("team", { workspaceId, location: "explorer" }) } },
      { kind: "item" as const, id: "overall-supervisor", title: "Overall Supervisor", icon: "Network", behavior: { kind: "action" as const, onPress: () => client.openPanel("supervisor", { workspaceId }) } },
      { kind: "item" as const, id: "start-work", title: "Start supervised work", icon: "Play", behavior: { kind: "action" as const, onPress: () => client.openPanel("work", { workspaceId }) } },
      { kind: "separator" as const, id: "settings-divider" },
      { kind: "item" as const, id: "profiles", title: "Agent launch profiles", icon: "Settings", behavior: { kind: "action" as const, onPress: () => client.openSettings("seatworks") } },
    ],
  } });
  const addWorkspace = (id: string) => { if (!disposed && !headers.has(id)) headers.set(id, client.addHeaderButton({ id: "seatworks", workspaceId: id, button: button(id) })); };
  const removeWorkspace = (id: string) => { headers.get(id)?.remove(); headers.delete(id); };
  const removeAgent = (id: string) => { pills.get(id)?.remove(); pills.delete(id); };
  const addAgent = (agent: { id: string; workspaceId?: string | null; archivedAt?: string | null }) => {
    if (disposed) return;
    if (!agent.workspaceId || agent.archivedAt) { removeAgent(agent.id); return; }
    if (pills.get(agent.id)?.workspace === agent.workspaceId) return;
    removeAgent(agent.id);
    const registration = client.addComposerPill({ id: "seatworks", workspaceId: agent.workspaceId, agentId: agent.id, button: button(agent.workspaceId) });
    pills.set(agent.id, { workspace: agent.workspaceId, remove: () => registration.remove(), update: patch => registration.update(patch) });
  };
  void client.paseo.workspaces.list({ subscribe: {}, page: { limit: 200 } }).then(async (directory) => {
    if (disposed) { await directory.subscription.release(); return; }
    releases.push(() => directory.subscription.release());
    directory.subscription.subscribe({ snapshot({ entries }) { entries.forEach((w) => addWorkspace(w.id)); }, update(event) {
      if (event.type !== "workspace_update") return;
      const value = event.payload;
      if (value.kind === "upsert") addWorkspace(value.workspace.id); else if (value.kind === "remove") removeWorkspace(value.id);
    } });
    let page = directory;
    while (page.pageInfo.hasMore && page.pageInfo.nextCursor && !disposed) {
      const next = await client.paseo.workspaces.list({ page: { limit: 200, cursor: page.pageInfo.nextCursor } });
      next.entries.forEach((w) => addWorkspace(w.id)); page = { ...next, subscription: directory.subscription, subscriptionId: directory.subscriptionId };
    }
  }).catch((error) => console.error("Seatworks workspace actions could not subscribe", error));
  void client.paseo.agents.list({ filter: { includeArchived: false }, subscribe: {}, page: { limit: 200 } }).then(async (directory) => {
    if (disposed) { await directory.subscription.release(); return; }
    releases.push(() => directory.subscription.release());
    directory.subscription.subscribe({ snapshot({ entries }) { entries.forEach(({ agent }) => addAgent(agent)); }, update(event) {
      if (event.type !== "agent_update") return;
      const value = event.payload;
      if (value.kind === "upsert") addAgent(value.agent); else if (value.kind === "remove") removeAgent(value.agentId);
    } });
    let page = directory;
    while (page.pageInfo.hasMore && page.pageInfo.nextCursor && !disposed) {
      const next = await client.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor: page.pageInfo.nextCursor } });
      next.entries.forEach(({ agent }) => addAgent(agent)); page = { ...next, subscription: directory.subscription, subscriptionId: directory.subscriptionId };
    }
  }).catch((error) => console.error("Seatworks composer actions could not subscribe", error));
  let reading = false;
  const refreshBrief = async () => {
    if (disposed || reading) return;
    reading = true;
    try { const brief = await client.rpc(briefRpc, {}); if (!disposed) pills.forEach((pill, id) => pill.update({ label: id === brief.supervisor ? briefLabel(brief) : "Seatworks" })); }
    catch { if (!disposed) pills.forEach(pill => pill.update({ label: "Team · unavailable" })); }
    finally { reading = false; }
  };
  void refreshBrief(); const timer = setInterval(() => void refreshBrief(), 5000);
  return () => { disposed = true; clearInterval(timer); headers.forEach((r) => r.remove()); pills.forEach((r) => r.remove()); releases.forEach((release) => void release()); };
}
