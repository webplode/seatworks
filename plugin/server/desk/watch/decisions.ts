import { join } from "node:path";
import type { Kit } from "../../catalog/kit/kit.ts";
import { isRecord } from "../../core/json.ts";
import { keptFault, readKept, writeJson } from "../../core/store.ts";
import type { Project } from "../project/project.ts";

/** A seat's thinking or saying as the brains read it, or the desk call a decision was made in. */
export type Item = { kind: "thought" | "said" | "call"; text: string };

/** A desk call a pattern is judged at: which one, and what the seat wrote in it. */
type Decision = { tool: string; text: string };
type Pending = { calls: Decision[]; words: Item[] };
type Stored = Record<string, Pending>;

const isItem = (value: unknown): value is Item =>
  isRecord(value) && ["thought", "said", "call"].includes(String(value.kind)) && typeof value.text === "string";
const isDecision = (value: unknown): value is Decision =>
  isRecord(value) && typeof value.tool === "string" && typeof value.text === "string";
const isStored = (value: unknown): value is Stored =>
  isRecord(value) &&
  Object.values(value).every(
    (entry) =>
      isRecord(entry) &&
      Array.isArray(entry.calls) &&
      entry.calls.every(isDecision) &&
      Array.isArray(entry.words) &&
      entry.words.every(isItem),
  );

/**
 * The decisions a seat made through the desk since the watch last read it, and its words since its last decision was
 * judged: a decision is judged at the seat's next look, with the words that led to it, newest kept. Kept per project so
 * a restart between the call and that look loses neither.
 */
export class Decisions {
  private readonly kit: Kit;

  constructor(kit: Kit) {
    this.kit = kit;
  }

  /** A call made through the desk: kept when some pattern is judged at it, in the words the seat wrote. */
  took(project: Project, seat: string, tool: string, args: unknown): void {
    if (!Object.values(this.kit.patterns).some((pattern) => pattern.tools?.includes(tool))) return;
    const stored = this.read(project);
    this.of(stored, seat).calls.push({ tool, text: rendered(args) });
    writeJson(this.file(project), stored);
  }

  /** A look's words join the seat's since its last decision; with a decision made meanwhile, it and those words, now taken. */
  take(project: Project, seat: string, words: Item[], limit: number): Pending | undefined {
    const stored = this.read(project);
    const entry = this.of(stored, seat);
    entry.words = newest([...entry.words, ...words], limit);
    if (entry.calls.length === 0) {
      writeJson(this.file(project), stored);
      return undefined;
    }
    delete stored[seat];
    writeJson(this.file(project), stored);
    return entry;
  }

  forget(project: Project, seat: string): void {
    const stored = this.read(project);
    if (!stored[seat]) return;
    delete stored[seat];
    writeJson(this.file(project), stored);
  }

  private file(project: Project): string {
    return join(project.state, "watch-decisions.json");
  }

  private read(project: Project): Stored {
    const read = readKept<Stored>(this.file(project), {}, isStored);
    if ("fault" in read) throw keptFault(read.fault);
    return read.value;
  }

  private of(stored: Stored, seat: string): Pending {
    return (stored[seat] ??= { calls: [], words: [] });
  }
}

/** The latest items whose text fits in `limit` characters together. */
function newest(items: Item[], limit: number): Item[] {
  let left = limit;
  let from = items.length;
  while (from > 0 && items[from - 1]!.text.length <= left) left -= items[--from]!.text.length;
  return items.slice(from);
}

const said = (value: unknown) =>
  value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);

/** A call's arguments as lines a reader can quote: each field by its name, a list one item a line. */
function rendered(value: unknown, indent = ""): string {
  if (Array.isArray(value))
    return value.map((item) => `${indent}- ${rendered(item, `${indent}  `).trimStart()}`).join("\n");
  if (typeof value === "object" && value !== null)
    return Object.entries(value)
      .filter(([, field]) => said(field))
      .map(([name, field]) =>
        typeof field === "object"
          ? `${indent}${name}:\n${rendered(field, `${indent}  `)}`
          : `${indent}${name}: ${String(field)}`,
      )
      .join("\n");
  return `${indent}${String(value)}`;
}
