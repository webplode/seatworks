import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { KEPT } from "../../shared/rpc.ts";
import { readJson, sortKeys, writeJson } from "../core/store.ts";
import { errorText } from "../core/errors.ts";

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

const RoleChoice = z.strictObject({
  harness: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: z.string().min(1).optional(),
  rules: z.string().optional(),
});

const Connect = z.strictObject({
  type: z.enum(["stdio", "http", "sse"]),
  command: z.array(z.string().min(1)).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpChoice = z.strictObject({
  enabled: z.boolean().optional(),
  removed: z.boolean().optional(),
  label: z.string().min(1).optional(),
  connect: Connect.optional(),
  roles: z.array(z.string()).optional(),
  tools: z.record(z.string(), z.array(z.string())).optional(),
  rule: z.string().optional(),
  settings: z.record(z.string(), Scalar).optional(),
});

export type Connect = z.infer<typeof Connect>;
export type McpChoice = z.infer<typeof McpChoice>;

const Pattern = z.string().min(1).refine(
  (value) => {
    try {
      new RegExp(value, "i");
      return true;
    } catch {
      return false;
    }
  },
  { message: "that is not a pattern this machine can read" },
);

export const AttentionChoice = z.strictObject({
  communication: z.enum(["off", "shadow"]).optional(),
  tickSeconds: z.number().int().min(5).optional(),
  leadIdleMinutes: z.number().int().min(1).optional(),
  askRemindMinutes: z.number().int().min(1).optional(),
  maxReminders: z.number().int().min(0).optional(),
  watch: z.boolean().optional(),
  by: z.enum(["seat", "jev"]).optional(),
  watcherQuietSeconds: z.number().int().min(5).optional(),
  watcherEveryMinutes: z.number().int().min(1).optional(),
  watcherChars: z.number().int().min(2000).optional(),
  watcherRotateAfter: z.number().int().min(1).optional(),
  watcherJudgeMinutes: z.number().int().min(1).optional(),
  destructive: Pattern.optional(),
  testPath: Pattern.optional(),
  repeatsAt: z.number().int().min(2).optional(),
  reworksAt: z.number().int().min(2).optional(),
  reviewsAt: z.number().int().min(2).optional(),
  suppressed: Pattern.optional(),
  longTurnMinutes: z.number().int().min(1).optional(),
  incidentsPerDay: z.number().int().min(0).optional(),
});

const FlowChoice = z.strictObject({
  live: z.boolean().optional(),
  everySeconds: z.number().int().min(2).max(120).optional(),
});

const shared = {
  roles: z.record(z.string(), RoleChoice).optional(),
  mcp: z.record(z.string(), McpChoice).optional(),
  rules: z.string().optional(),
  flow: FlowChoice.optional(),
};

const SensorChoice = z.strictObject({
  key: z.string().min(1).optional(),
});

export const ProjectLayerSchema = z.strictObject({ ...shared, attention: AttentionChoice.optional() });
export const MachineLayerSchema = z.strictObject({ ...shared, attention: AttentionChoice.optional(), sensor: SensorChoice.optional(), profiles: z.strictObject({ disabled: z.array(z.string().min(1)) }).optional() });

export type Layer = z.infer<typeof MachineLayerSchema>;
export type SensorChoice = z.infer<typeof SensorChoice>;
export type LayerSchema = typeof MachineLayerSchema | typeof ProjectLayerSchema;

/** The key buys paid calls, so the screen never reads it back: it sees KEPT, and a save carrying KEPT keeps the key on disk. */
export function withoutKey(layer: Layer): Layer {
  return layer.sensor?.key ? { ...layer, sensor: { ...layer.sensor, key: KEPT } } : layer;
}

export function withKey(values: unknown, stored: Layer): unknown {
  if (!values || typeof values !== "object") return values;
  const asked = values as { sensor?: { key?: unknown } };
  if (asked.sensor?.key !== KEPT) return values;
  const { sensor, ...rest } = asked;
  const key = stored.sensor?.key;
  return key ? { ...rest, sensor: { ...sensor, key } } : rest;
}

export type ReadResult = { status: "ready"; revision: string; values: Layer } | { status: "invalid"; revision: string; error: string };
export type SettingsView = ReadResult & { machine: Layer };
export type WriteResult = { status: "saved"; revision: string; values: Layer } | { status: "conflict"; error: string } | { status: "invalid"; error: string };

export function revisionOf(values: unknown): string {
  return createHash("sha1").update(JSON.stringify(sortKeys(values ?? {}))).digest("hex").slice(0, 16);
}

/** Only the position: V8 quotes the file's own text, which holds the sensor key and pasted tokens. */
function placeOf(error: unknown): string {
  const said = errorText(error);
  const where = /at position \d+(?: \(line \d+ column \d+\))?/.exec(said);
  return where ? `, ${where[0]}` : "";
}

/** `readJson` reads a broken file as `{}`, a valid empty layer, so the next save would overwrite all the owner wrote. */
function faultOf(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let held: unknown;
  try {
    held = JSON.parse(readFileSync(file, "utf-8"));
  } catch (error) {
    return `${file} is there but is not JSON${placeOf(error)}`;
  }
  return !held || typeof held !== "object" || Array.isArray(held) ? `${file} does not hold a settings object` : undefined;
}

export function readLayer(file: string, schema: LayerSchema): ReadResult {
  const fault = faultOf(file);
  if (fault) return { status: "invalid", revision: revisionOf(readJson<unknown>(file, {})), error: `${fault}\nRepair the file by hand, then read it again.` };
  const raw = readJson<unknown>(file, {});
  const revision = revisionOf(raw);
  const parsed = schema.safeParse(raw);
  return parsed.success ? { status: "ready", revision, values: parsed.data } : { status: "invalid", revision, error: z.prettifyError(parsed.error) };
}

export function layerValues(file: string, schema: LayerSchema): Layer {
  const read = readLayer(file, schema);
  return read.status === "ready" ? read.values : {};
}

export function writeLayer(file: string, schema: LayerSchema, revision: string, values: unknown, check: (values: Layer) => string[]): WriteResult {
  const fault = faultOf(file);
  if (fault) {
    return { status: "invalid", error: `${fault}, and saving over it would throw away what it holds.\nRepair the file by hand, then save again.` };
  }
  const current = readJson<unknown>(file, {});
  if (revisionOf(current) !== revision) {
    return { status: "conflict", error: "The settings changed after they were read; read them again and reapply the change." };
  }
  const held = schema.safeParse(current);
  if (!held.success) {
    return {
      status: "invalid",
      error: `${file} could not be read, and saving over it would throw away what it holds:\n${z.prettifyError(held.error)}\nRepair the file by hand, then save again.`,
    };
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success) return { status: "invalid", error: z.prettifyError(parsed.error) };
  const problems = check(parsed.data);
  if (problems.length > 0) return { status: "invalid", error: problems.join("\n") };
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, parsed.data);
  return { status: "saved", revision: revisionOf(parsed.data), values: parsed.data };
}
