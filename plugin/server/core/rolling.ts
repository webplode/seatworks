import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

/** An append-only log that rolls into numbered files, packs the older ones and drops the oldest past `keepBytes`. */
export type Rolling = {
  dir: string;
  current: string;
  prefix: string;
  ext: string;
  rotateAt: number;
  keepBytes: number;
  plain: number;
};

const packed = promisify(gzip);
const packing = new Set<string>();
const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function rolledName(roll: Pick<Rolling, "prefix" | "ext">, stamp: string, packedToo = false): string {
  return `${roll.prefix}${stamp}${roll.ext}${packedToo ? ".gz" : ""}`;
}

/** The numbers of the rolled files, oldest first; `complete` leaves out one whose packing was cut short. */
export function rolledStamps(names: string[], roll: Pick<Rolling, "prefix" | "ext">, complete = false): string[] {
  const shape = new RegExp(`^${escape(roll.prefix)}(\\d{8})${escape(roll.ext)}(\\.gz(\\.part)?)?$`);
  const found = new Set<string>();
  for (const name of names) {
    const match = shape.exec(name);
    if (match && !(complete && match[3])) found.add(match[1]!);
  }
  return [...found].sort();
}

/** One packing per file at a time: two rotations close together would write the same `.part`. */
async function pack(plain: string): Promise<void> {
  if (packing.has(plain)) return;
  packing.add(plain);
  try {
    let data: Buffer;
    try {
      data = await readFile(plain);
    } catch (error) {
      if (gone(error)) return;
      throw error;
    }
    try {
      await writeFile(`${plain}.gz.part`, await packed(data));
      await rename(`${plain}.gz.part`, `${plain}.gz`);
    } catch (error) {
      await unlink(`${plain}.gz.part`).catch(() => undefined);
      throw error;
    }
    await unlink(plain).catch((error: unknown) => {
      if (!gone(error)) throw error;
    });
  } finally {
    packing.delete(plain);
  }
}

/** Newest first, rolled files are kept while their sizes on disk add up to `keepBytes`. */
function prune(roll: Rolling): void {
  const names = readdirSync(roll.dir);
  let total = 0;
  for (const stamp of rolledStamps(names, roll).reverse()) {
    const plain = rolledName(roll, stamp);
    const files = [plain, `${plain}.gz`, `${plain}.gz.part`].filter((name) => names.includes(name)).map((name) => join(roll.dir, name));
    for (const file of files) total += sizeOf(file);
    if (total > roll.keepBytes) for (const file of files) rmSync(file, { force: true });
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** The newest `plain` rolled files stay readable as text, for a reader that greps across the last roll. */
export function appendRolling(roll: Rolling, line: string): Promise<void> {
  mkdirSync(roll.dir, { recursive: true });
  const file = join(roll.dir, roll.current);
  if (!existsSync(file) || statSync(file).size + Buffer.byteLength(line) <= roll.rotateAt) {
    appendFileSync(file, line);
    return Promise.resolve();
  }
  const last = rolledStamps(readdirSync(roll.dir), roll).at(-1);
  renameSync(file, join(roll.dir, rolledName(roll, String(Number(last ?? 0) + 1).padStart(8, "0"))));
  appendFileSync(file, line);
  const names = readdirSync(roll.dir);
  const loose = rolledStamps(names, roll).filter((stamp) => names.includes(rolledName(roll, stamp)));
  // Pruned once packed, so a roll still plain is not charged at its unpacked size.
  return Promise.all(loose.slice(0, Math.max(0, loose.length - roll.plain)).map((stamp) => pack(join(roll.dir, rolledName(roll, stamp))))).finally(() => prune(roll)).then(() => undefined);
}
