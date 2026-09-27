import type { ArgSchema } from "../../catalog/kit/kit.ts";

const TYPE_WORDS: Record<string, string> = {
  string: "text",
  boolean: "true or false",
  number: "a number",
  integer: "a whole number",
  array: "a list",
  object: "an object",
};

const typeOf = (value: unknown): string => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);

const isType = (value: unknown, type: string): boolean =>
  type === "integer" ? Number.isInteger(value) : typeOf(value) === type;

const blank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.every(blank));

const absent = (value: unknown): boolean => value === undefined || value === null;

function fits(name: string, schema: ArgSchema, value: unknown): string[] {
  if (schema.type && !isType(value, schema.type)) return [`${name} must be ${TYPE_WORDS[schema.type] ?? schema.type}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${name} must be one of ${schema.enum.join(", ")}`];
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum)
    return [`${name} must be at least ${schema.minimum}`];
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum)
    return [`${name} must be at most ${schema.maximum}`];
  if (typeof value === "string" && schema.maxLength !== undefined && value.length > schema.maxLength)
    return [`${name} takes at most ${schema.maxLength} characters, and has ${value.length}`];
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength)
    return [`${name} must not be empty`];
  if (!Array.isArray(value) || !schema.items) return [];
  if (schema.minItems !== undefined && value.length < schema.minItems)
    return [`${name} takes at least ${schema.minItems}`];
  if (schema.maxItems !== undefined && value.length > schema.maxItems)
    return [`${name} takes at most ${schema.maxItems}`];
  for (const item of value) {
    const wrong = fits(`each of ${name}`, schema.items, item);
    // Inside a list's items only what the handler cannot take is refused: a blank there was never held against a call.
    const inner =
      wrong.length === 0 && schema.items.properties
        ? problems(schema.items, item as Record<string, unknown>, absent).map(
            (problem) => `${problem} in each of ${name}`,
          )
        : [];
    if (wrong.length + inner.length > 0) return [...wrong, ...inner];
  }
  return [];
}

function problems(schema: ArgSchema, args: Record<string, unknown>, missing: (value: unknown) => boolean): string[] {
  const properties = schema.properties ?? {};
  const found: string[] = [];
  for (const name of schema.required ?? []) {
    const what = properties[name]?.description;
    if (missing(args[name])) found.push(`needs ${name}${what ? ` (${what.replace(/\.$/, "")})` : ""}`);
  }
  for (const [name, value] of Object.entries(args)) {
    const field = properties[name];
    if (!field) found.push(`has no field ${name}`);
    else if (!absent(value)) found.push(...fits(name, field, value));
  }
  return found;
}

/** A value some harnesses send as text, read as the type its field asks for. Anything else is left as sent. */
function asTyped(schema: ArgSchema, value: unknown): unknown {
  if (typeof value !== "string" || !schema.type || schema.type === "string") return value;
  const text = value.trim();
  if (schema.type === "boolean") return text === "true" ? true : text === "false" ? false : value;
  if (schema.type === "number" || schema.type === "integer")
    return text !== "" && Number.isFinite(Number(text)) ? Number(text) : value;
  if (schema.type !== "array" && schema.type !== "object") return value;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeOf(parsed) === schema.type ? parsed : value;
  } catch {
    return value;
  }
}

/** `args` with each text value read as its field's type, for harnesses that do not type their calls. */
export function typedArgs(schema: ArgSchema, args: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties ?? {};
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => [name, properties[name] ? asTyped(properties[name], value) : value]),
  );
}

/** Why `args` miss the schema the seat was shown; empty when they fit. Some harnesses never check their own calls. */
export function argsProblems(schema: ArgSchema, args: Record<string, unknown>): string[] {
  return problems(schema, args, blank);
}

/** A call as its tool takes it: a field sent as null was read as left out, so it is left out. */
export function withoutNulls(args: Record<string, unknown>): Record<string, unknown> {
  const kept = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(kept)
      : value && typeof value === "object"
        ? withoutNulls(value as Record<string, unknown>)
        : value;
  return Object.fromEntries(
    Object.entries(args)
      .filter(([, value]) => value !== null)
      .map(([name, value]) => [name, kept(value)]),
  );
}

export function shapeOf(schema: ArgSchema): string {
  const required = schema.required ?? [];
  const optional = Object.keys(schema.properties ?? {}).filter((name) => !required.includes(name));
  if (required.length === 0 && optional.length === 0) return "It takes nothing.";
  return `It takes ${required.join(", ")}${required.length > 0 && optional.length > 0 ? ", and optionally " : optional.length > 0 ? "optionally " : ""}${optional.join(", ")}.`;
}
