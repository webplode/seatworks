import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../core/errors.ts";
import { STATE_VERSION } from "../core/state.ts";
import { readJson, writeJson } from "../core/store.ts";

/** Steps run in order at plugin start, which an update only does once every seat has stopped. */
export type StateStep = { to: number; machine?: (root: string) => void; project?: (state: string) => void };

export const STEPS: StateStep[] = [{ to: 2, machine(root) {
  const file = join(root, "outbox.json");
  if (existsSync(file)) {
    const old = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(old) || old.some((l) => typeof l?.id !== "string" || typeof l?.to !== "string" || typeof l?.key !== "string" || typeof l?.text !== "string" || typeof l?.at !== "number")) throw new Error("Invalid version 1 outbox; nothing was migrated.");
    writeJson(file, old.map((l) => ({ ...l, state: "queued" })));
  }
} }];

const MACHINE_FILES = ["state.json", "settings.json", "outbox.json", "content.json", "supervision.json", "dependencies.json", "jev-budget.json"];
const PROJECT_FILES = ["ledger.json", "incidents.json", "project.json", "meta.json", "settings.json"];

export const STATE_BACKUP = /^backup-state-\d+-\d{8}-\d{6}$/;

export type StateReport = { upgraded: string[]; failed: { where: string; error: string }[] };

const machineFile = (root: string) => join(root, "state.json");

/** A machine with no number predates it, and so holds the first format. */
function machineVersion(root: string): number {
  const held = readJson<{ version?: unknown }>(machineFile(root), {}).version;
  return typeof held === "number" ? held : 1;
}

function stampOf(now: number): string {
  const digits = new Date(now).toISOString().replace(/\D/g, "").slice(0, 14);
  return `${digits.slice(0, 8)}-${digits.slice(8)}`;
}

/** Set aside first and put back whole when a step throws, so a failed upgrade leaves the place refused, not half-moved. */
function upgrade(where: string, dir: string, files: string[], from: number, current: number, steps: StateStep[], apply: (step: StateStep) => void, finish: () => void, now: number, report: StateReport): void {
  if (from === current) return;
  if (from > current) {
    report.failed.push({ where, error: `its state is at ${from}, made by a newer Seatworks than this one, which reads ${current}` });
    return;
  }
  const backup = join(dir, `backup-state-${from}-${stampOf(now)}`);
  const kept = files.filter((name) => existsSync(join(dir, name)));
  mkdirSync(backup, { recursive: true });
  for (const name of kept) copyFileSync(join(dir, name), join(backup, name));
  try {
    for (let to = from + 1; to <= current; to++) {
      const step = steps.find((entry) => entry.to === to);
      if (!step) throw new Error(`there is no step to state ${to}`);
      apply(step);
    }
    finish();
    report.upgraded.push(`${where}: ${from} → ${current}`);
  } catch (error) {
    for (const name of files.filter((name) => !kept.includes(name))) rmSync(join(dir, name), { force: true });
    for (const name of kept) copyFileSync(join(backup, name), join(dir, name));
    report.failed.push({ where, error: `could not go from state ${from} to ${current}: ${errorText(error)}; its files are as they were, and a copy is in ${backup}` });
  }
}

export function upgradeState(root: string, steps = STEPS, current = STATE_VERSION, now = Date.now()): StateReport {
  const report: StateReport = { upgraded: [], failed: [] };
  if (!existsSync(root)) return report;
  upgrade("machine", root, MACHINE_FILES, machineVersion(root), current, steps, (step) => step.machine?.(root), () => writeJson(machineFile(root), { version: current }), now, report);
  const projects = join(root, "projects");
  for (const slug of existsSync(projects) ? readdirSync(projects) : []) {
    const state = join(projects, slug);
    const ledger = join(state, "ledger.json");
    // A project's number is its ledger's; one with no ledger has no work on record to carry.
    if (!existsSync(ledger)) continue;
    const version = readJson<{ version?: unknown }>(ledger, {}).version;
    if (typeof version !== "number") continue;
    upgrade(slug, state, PROJECT_FILES, version, current, steps, (step) => step.project?.(state), () => writeJson(ledger, { ...readJson<object>(ledger, {}), version: current }), now, report);
  }
  return report;
}
