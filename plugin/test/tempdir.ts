import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

process.on("exit", () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** Removed when the test process exits, whatever the tests did with it. */
export function tempDir(prefix = "sw3-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
