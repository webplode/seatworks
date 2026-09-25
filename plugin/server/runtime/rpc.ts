import type { z } from "zod";
import { contracts } from "../../shared/rpc.ts";
import type { Check } from "./doctor.ts";
import type { PaseoApi } from "../core/paseo.ts";
import type { SettingsView, WriteResult } from "../catalog/settings.ts";

export { contracts };

export interface Control {
  catalog(): unknown;
  readSettings(project?: string): SettingsView;
  writeSettings(project: string | undefined, revision: string, values: unknown): WriteResult;
  projects(): unknown;
  addProject(root: string): unknown;
  removeProject(project: string): Promise<unknown>;
  candidateProjects(roots: string[]): unknown;
  parseMcp(text: string): unknown;
  team(project?: string): unknown;
  doctor(project?: string): Promise<Check[]>;
  setGitIdentity(project: string, name: string, email: string): Check;
  status(project: string): Promise<unknown>;
  flow(project: string, since?: string, open?: string[]): Promise<unknown>;
  decidePlan(project: string, lane: string, approve: boolean, note: string): Promise<unknown>;
  decideLand(project: string, lane: string, approve: boolean, note: string): Promise<unknown>;
  listPaths(path?: string): unknown;
  findPaths(query: string): Promise<unknown>;
  refreshModels(): Promise<unknown>;
  decide(unit: string, choice: "new" | "mine" | "seen"): Promise<unknown>;
  clean(remove?: string[]): Promise<unknown>;
  update(apply: boolean, fetch?: boolean): Promise<unknown>;
  migrate(apply: boolean): Promise<unknown>;
}

type Contract = { name: string; input: z.ZodType; output: z.ZodType };
type Answer = (input: any) => unknown;
type Handle = (contract: Contract, handler: (input: any, context: { paseo: PaseoApi }) => unknown) => void;

/** Panel calls carry the live daemon handle: after a reload with no seat hooks yet, it is the desk's only way to get one. */
export function registerRpc(server: { handle: unknown }, control: Control, bind: (paseo: PaseoApi) => void): string[] {
  const register = (server.handle as Handle).bind(server);
  const handle = (contract: Contract, answer: Answer) =>
    register(contract, (input, context) => {
      if (context?.paseo) bind(context.paseo);
      return answer(input);
    });
  handle(contracts.catalog, () => control.catalog());
  handle(contracts.settingsRead, (input) => control.readSettings(input.project));
  handle(contracts.settingsWrite, (input) => control.writeSettings(input.project, input.revision, input.values));
  handle(contracts.projects, () => control.projects());
  handle(contracts.projectsAdd, (input) => control.addProject(input.root));
  handle(contracts.projectsRemove, (input) => control.removeProject(input.project));
  handle(contracts.projectsCandidates, (input) => control.candidateProjects(input.roots));
  handle(contracts.mcpParse, (input) => control.parseMcp(input.text));
  handle(contracts.team, (input) => control.team(input.project));
  handle(contracts.doctor, (input) => control.doctor(input.project));
  handle(contracts.gitIdentity, (input) => control.setGitIdentity(input.project, input.name, input.email));
  handle(contracts.status, (input) => control.status(input.project));
  handle(contracts.flow, (input) => control.flow(input.project, input.since, input.open));
  handle(contracts.planDecide, (input) => control.decidePlan(input.project, input.lane, input.approve, input.note));
  handle(contracts.landDecide, (input) => control.decideLand(input.project, input.lane, input.approve, input.note));
  handle(contracts.paths, (input) => control.listPaths(input.path));
  handle(contracts.pathsFind, (input) => control.findPaths(input.query));
  handle(contracts.models, () => control.refreshModels());
  handle(contracts.decide, (input) => control.decide(input.unit, input.choice));
  handle(contracts.clean, (input) => control.clean(input.remove));
  handle(contracts.update, (input) => control.update(input.apply, input.fetch));
  handle(contracts.migrate, (input) => control.migrate(input.apply));
  return Object.values(contracts).map((contract) => contract.name);
}
