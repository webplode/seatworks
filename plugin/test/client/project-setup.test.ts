import assert from "node:assert/strict";
import { test } from "node:test";
import { attachProject } from "../../client/data.ts";
import { addSupervisedProject, workGrants } from "../../client/project-setup.ts";
import type { SupervisionView } from "../../shared/supervision.ts";

const root = "/fixture";
const binding = { version: 2 as const, revision: 7, active: false, supervisor: null, projects: [] };
test("setup refuses completion when settings could not be read or saved", async () => {
  const calls = { add: async () => ({ slug: "fixture", root }), settings: async () => ({ status: "ready" as const, revision: "1", values: {}, machine: {} }), write: async () => ({ status: "saved" as const, revision: "2", values: {} }) };
  await assert.rejects(attachProject(root, { rules: "keep" }, [], { ...calls, settings: async () => ({ status: "invalid" as const, error: "unreadable", revision: "1", machine: {} }) }), /unreadable/);
  await assert.rejects(attachProject(root, { rules: "keep" }, [], { ...calls, write: async () => ({ status: "conflict" as const, error: "stale", revision: "2" }) }), /stale/);
});

test("retry reuses the registered project and enrolls only after its settings are saved", async () => {
  let registered = false, saved = false, binds = 0, registrations = 0;
  const actions = {
    projects: async () => registered ? [{ id: "native", root }] : [],
    register: async () => { registered = true; registrations++; },
    attach: async () => saved ? "fixture" : null,
    read: async () => ({ binding }) as unknown as SupervisionView,
    bind: async (input: { projects: { id: string; grants: string[] }[]; revision: number; active: boolean }) => { binds++; assert.equal(input.revision, 7); assert.equal(input.active, false); assert.deepEqual(input.projects, [{ id: "native", grants: workGrants }]); },
  };
  const input = { root, name: "Fixture", values: {}, grants: workGrants };
  await assert.rejects(addSupervisedProject(input, actions), /not saved/);
  assert.equal(binds, 0);
  saved = true;
  assert.equal(await addSupervisedProject(input, actions), "fixture");
  assert.equal(registrations, 1); assert.equal(binds, 1);
});

test("setup preserves an existing project's grants and other projects from a fresh scope read", async () => {
  const existing = [{ id: "native", root, slug: "fixture", name: "Fixture", grants: ["observe" as const], leads: [] }, { id: "other", root: "/other", slug: "other", name: "Other", grants: workGrants, leads: [] }];
  await addSupervisedProject({ root, name: "Fixture", values: {}, grants: workGrants }, {
    projects: async () => [{ id: "native", root }], register: async () => { assert.fail("must reuse workspace"); }, attach: async () => "fixture",
    read: async () => ({ binding: { ...binding, revision: 9, projects: existing } }) as unknown as SupervisionView,
    bind: async (input) => { assert.equal(input.revision, 9); assert.deepEqual(input.projects, existing.map(({ id, grants }) => ({ id, grants }))); },
  });
});
