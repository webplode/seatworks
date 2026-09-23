import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SeatworksSurface } from "./client/surface.tsx";
import { SeatworksSettings } from "./client/profiles.tsx";
import { WorkspaceTeam, WorkspaceWork, WorkspaceSupervisor } from "./client/workspace.tsx";
import { BriefSchema } from "./shared/brief.ts";
import { TeamActivity, TeamStatusCard } from "./client/brief.tsx";
import { workspaceActions } from "./client/workspace-actions.ts";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addTimelineRenderer({ kind: "team-status", version: 1, schema: BriefSchema, Component: props => <TeamStatusCard {...props} openActivity={workspaceId => client.openPanel("activity", { workspaceId, location: "explorer" })} /> }),
    client.addWorkspacePanel({ id: "activity", title: "Team activity", icon: "Activity", context: "workspace", locations: ["workspace", "explorer"], Component: TeamActivity }),
    client.addSurface("seatworks", SeatworksSurface),
    client.addSidebarItem({ id: "seatworks", title: "Seatworks", icon: "Users", surface: "seatworks" }),
    client.addSettingsScreen({ id: "seatworks", title: "Seatworks", icon: "Users", Component: SeatworksSettings }),
    client.addWorkspacePanel({ id: "team", title: "Team & models", icon: "SlidersHorizontal", context: "workspace", locations: ["workspace", "explorer"], Component: WorkspaceTeam }),
    client.addWorkspacePanel({ id: "work", title: "Seatworks", icon: "Users", context: "workspace", locations: ["workspace", "explorer"], Component: WorkspaceWork }),
    client.addWorkspacePanel({ id: "supervisor", title: "Overall Supervisor", icon: "Network", context: "workspace", locations: ["workspace", "explorer"], Component: WorkspaceSupervisor }),
    client.addCommandCenterItem({ id: "team", title: "Seatworks: Team & models", icon: "SlidersHorizontal", context: "workspace", onSelect: ({ openPanel }) => openPanel("team", { location: "explorer" }) }),
    client.addCommandCenterItem({ id: "supervisor", title: "Seatworks: Overall Supervisor", icon: "Network", context: "workspace", onSelect: ({ openPanel }) => openPanel("supervisor") }),
    client.addSlashCommand({ name: "seatworks", description: "Open this project's team and models", argumentHint: "", context: "workspace", onSubmit: ({ openPanel }) => openPanel("team", { location: "explorer" }) }),
    workspaceActions(client),
  ];
  return () => cleanups.reverse().forEach((cleanup) => cleanup());
}
