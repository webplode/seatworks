import assert from "node:assert/strict";
import { test } from "node:test";
import type { SeatView } from "../../server/core/ports.ts";
import { flowView } from "../../server/desk/views/flow.ts";
import { emptyLedger } from "../../server/domain/ledger.ts";
import type { Project } from "../../server/desk/project/project.ts";

const now = Date.parse("2026-09-16T04:00:00.000Z");
const project: Project = { root: "/work/shop", slug: "shop-abc123", state: "/state/shop-abc123" };

const lane = (id: string) => ({
  id,
  title: `Lane ${id}`,
  outcome: "",
  acceptance: [],
  outOfScope: [],
  base: "main",
  branch: `lane-${id.toLowerCase()}`,
  writeSet: [],
  contracts: [],
  opener: "seat-sup",
  status: "open" as const,
  openedAt: now - 3_600_000,
  tasks: 0,
});

const seat = (id: string, provider: string): SeatView => ({
  id,
  provider,
  cwd: "/w",
  status: "idle",
  updatedAt: new Date(now - 60_000).toISOString(),
});

test("whoever supervises is shown by the capability the kit gives, one per concern, and at most 50 lanes are drawn", () => {
  const ledger = emptyLedger();
  ledger.agents["seat-sup"] = { id: "seat-sup", role: "supervisor" };
  ledger.agents["seat-arch"] = { id: "seat-arch", role: "architecture" };
  ledger.agents["seat-safety"] = { id: "seat-safety", role: "safety" };
  const seats = new Map([
    ["seat-sup", seat("seat-sup", "sw3-supervisor-claude")],
    ["seat-arch", seat("seat-arch", "sw3-architecture-claude")],
  ]);
  const labels: Record<string, string> = {
    supervisor: "Supervisor",
    architecture: "Architect",
    safety: "Safety officer",
  };
  const shown = (supervises: string[]) =>
    flowView(
      project,
      ledger,
      seats,
      now,
      new Set(),
      new Map(Object.entries(labels).map(([role, label]) => [role, { label, supervises: supervises.includes(role) }])),
    ).supervisors.map((entry) => [entry.label, entry.status]);
  assert.deepEqual(shown([]), []);
  assert.deepEqual(shown(["supervisor"]), [["Supervisor", "idle"]]);
  assert.deepEqual(
    shown(["supervisor", "architecture", "safety"]).sort(),
    [
      ["Architect", "idle"],
      ["Safety officer", "gone"],
      ["Supervisor", "idle"],
    ],
    "each named as the kit labels its role, for the canvas to show",
  );

  for (let index = 0; index < 60; index += 1) ledger.lanes[`L${index}`] = lane(`L${index}`);
  const view = flowView(project, ledger, new Map(), now);
  assert.deepEqual([view.lanes.length, view.moreLanes], [50, 10]);
});
