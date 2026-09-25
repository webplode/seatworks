import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BindingChange, LeadChange } from "./supervision.ts";

export const supervisionRpc = defineRpc({ name: "seatworks.supervision.read", input: z.object({}), output: z.json() });
export const bindingRpc = defineRpc({ name: "seatworks.supervision.bind", input: BindingChange, output: z.json() });
export const adoptRpc = defineRpc({ name: "seatworks.supervision.adopt", input: LeadChange, output: z.json() });
export const createSupervisorRpc = defineRpc({ name: "seatworks.supervision.create", input: z.object({ revision: z.number().int() }), output: z.json() });

const project = z.string().min(1).optional();

export const KEPT = "kept, not shown";

export const catalogRpc = defineRpc({ name: "seatworks.catalog.read", input: z.object({}), output: z.json() });
export const settingsReadRpc = defineRpc({ name: "seatworks.settings.read", input: z.object({ project }), output: z.json() });
export const settingsWriteRpc = defineRpc({ name: "seatworks.settings.write", input: z.object({ project, revision: z.string(), values: z.json() }), output: z.json() });
export const projectsRpc = defineRpc({ name: "seatworks.projects.list", input: z.object({}), output: z.json() });
export const projectsAddRpc = defineRpc({ name: "seatworks.projects.add", input: z.object({ root: z.string().min(1) }), output: z.json() });
export const projectsRemoveRpc = defineRpc({ name: "seatworks.projects.remove", input: z.object({ project: z.string().min(1) }), output: z.json() });
export const projectsCandidatesRpc = defineRpc({ name: "seatworks.projects.candidates", input: z.object({ roots: z.array(z.string()) }), output: z.json() });
export const mcpParseRpc = defineRpc({ name: "seatworks.mcp.parse", input: z.object({ text: z.string().min(1) }), output: z.json() });
export const teamRpc = defineRpc({ name: "seatworks.team.read", input: z.object({ project }), output: z.json() });
export const doctorRpc = defineRpc({ name: "seatworks.doctor.run", input: z.object({ project }), output: z.json() });
export const gitIdentityRpc = defineRpc({ name: "seatworks.git.identity", input: z.object({ project: z.string().min(1), name: z.string().trim().min(1), email: z.string().trim().email() }), output: z.json() });
export const statusRpc = defineRpc({ name: "seatworks.status.read", input: z.object({ project: z.string().min(1) }), output: z.json() });
export const flowRpc = defineRpc({ name: "seatworks.flow.read", input: z.object({ project: z.string().min(1), since: z.string().optional(), open: z.array(z.string()).optional() }), output: z.json() });
export const planDecideRpc = defineRpc({ name: "seatworks.plan.decide", input: z.object({ project: z.string().min(1), lane: z.string().min(1), approve: z.boolean(), note: z.string() }), output: z.json() });
export const landDecideRpc = defineRpc({ name: "seatworks.land.decide", input: z.object({ project: z.string().min(1), lane: z.string().min(1), approve: z.boolean(), note: z.string() }), output: z.json() });
export const landApproveRpc = defineRpc({ name: "seatworks.land.approve", input: z.object({ project: z.string().min(1), lane: z.string().min(1) }), output: z.json() });
export const modelsRpc = defineRpc({ name: "seatworks.models.refresh", input: z.object({}), output: z.json() });
export const decideRpc = defineRpc({ name: "seatworks.upkeep.decide", input: z.object({ unit: z.string().min(1), choice: z.enum(["new", "mine", "seen"]) }), output: z.json() });
export const cleanRpc = defineRpc({ name: "seatworks.upkeep.clean", input: z.object({ remove: z.array(z.string()).optional() }), output: z.json() });
export const updateRpc = defineRpc({ name: "seatworks.upkeep.update", input: z.object({ apply: z.boolean(), fetch: z.boolean().optional() }), output: z.json() });
export const migrateRpc = defineRpc({ name: "seatworks.upkeep.migrate", input: z.object({ apply: z.boolean() }), output: z.json() });
export const pathsRpc = defineRpc({ name: "seatworks.paths.list", input: z.object({ path: z.string().optional() }), output: z.json() });
export const pathsFindRpc = defineRpc({ name: "seatworks.paths.find", input: z.object({ query: z.string() }), output: z.json() });

export const contracts = {
  catalog: catalogRpc,
  settingsRead: settingsReadRpc,
  settingsWrite: settingsWriteRpc,
  projects: projectsRpc,
  projectsAdd: projectsAddRpc,
  projectsRemove: projectsRemoveRpc,
  projectsCandidates: projectsCandidatesRpc,
  mcpParse: mcpParseRpc,
  team: teamRpc,
  doctor: doctorRpc,
  gitIdentity: gitIdentityRpc,
  status: statusRpc,
  flow: flowRpc,
  planDecide: planDecideRpc,
  landDecide: landDecideRpc,
  landApprove: landApproveRpc,
  paths: pathsRpc,
  pathsFind: pathsFindRpc,
  models: modelsRpc,
  decide: decideRpc,
  clean: cleanRpc,
  update: updateRpc,
  migrate: migrateRpc,
} as const;
