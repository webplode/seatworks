import type { Binding, Operation, SupervisionView } from "../shared/supervision.ts";
import type { Layer } from "./data.ts";

export const workGrants: Operation[] = ["observe", "message", "answer", "open_lane", "set_project", "ack", "coordinate"];

export async function addSupervisedProject(input: { root: string; name: string; values: Layer; grants: Operation[] }, actions: {
  projects(): Promise<{ id: string; root: string }[]>;
  register(root: string, name: string): Promise<void>;
  attach(root: string, values: Layer): Promise<string | null>;
  read(): Promise<SupervisionView>;
  bind(input: { revision: number; active: boolean; supervisor: string | null; projects: { id: string; grants: Operation[] }[] }): Promise<unknown>;
}): Promise<string> {
  let native = (await actions.projects()).find((p) => p.root === input.root);
  if (!native) {
    await actions.register(input.root, input.name);
    native = (await actions.projects()).find((p) => p.root === input.root);
  }
  if (!native) throw new Error("The workspace was registered, but its project is not available yet. Retry to finish setup.");
  const slug = await actions.attach(input.root, input.values);
  if (!slug) throw new Error("Project settings were not saved. Your selections are kept; retry to finish setup.");
  const { binding } = await actions.read();
  const projects = binding.projects.map((p) => ({ id: p.id, grants: p.grants }));
  if (!projects.some((p) => p.id === native.id)) projects.push({ id: native.id, grants: input.grants });
  await actions.bind({ revision: binding.revision, active: binding.active, supervisor: binding.supervisor?.agent ?? null, projects });
  return slug;
}

export function bindingInput(binding: Binding, active: boolean, supervisor = binding.supervisor?.agent ?? null) {
  return { revision: binding.revision, active, supervisor, projects: binding.projects.map(({ id, grants }) => ({ id, grants })) };
}
