import { spawn } from "node:child_process";
import { PLUGIN_ID } from "../core/paths.ts";

/** Paseo hands a plugin a client that never reconnects, so after the daemon drops it (a lapsed lease, often a sleep) only a reload brings it back. */
export class Relink {
  private last = -Infinity;
  private readonly reload: () => void;
  private readonly gapMs: number;

  constructor(reload: () => void, gapMs = 5 * 60_000) {
    this.reload = reload;
    this.gapMs = gapMs;
  }

  // Only "not connected": "Transport closed" also fires while Paseo stops the plugin on purpose.
  failed(error: string, now = Date.now()): boolean {
    if (!/Transport not connected \(status: disconnected\)/.test(error) || now - this.last < this.gapMs) return false;
    this.last = now;
    this.reload();
    return true;
  }
}

/** Detached, because the reload stops the process that asked for it. */
export function reloadPlugin(): void {
  const child = spawn("paseo", ["plugin", "reload", PLUGIN_ID], { detached: true, stdio: "ignore" });
  child.on("error", (error) => console.error("seatworks-v2: could not reload itself:", error.message));
  child.unref();
}
