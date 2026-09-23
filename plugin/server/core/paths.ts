import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

export const PLUGIN_ID = "seatworks-v2";

export function home(): string {
  return process.env.HOME || homedir();
}

export function expandHome(value: string, homeDir = home()): string {
  if (value === "HOME" || value === "~") return homeDir;
  if (value.startsWith("HOME/")) return join(homeDir, value.slice(5));
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

export function paseoConfigPath(homeDir = home()): string {
  return join(process.env.PASEO_HOME || join(homeDir, ".paseo"), "config.json");
}

export function stateRoot(homeDir = home()): string {
  return join(homeDir, ".local", "share", "seatworks-v2");
}

export function guidesDir(homeDir = home()): string {
  return join(stateRoot(homeDir), "guides");
}

/** Copies of what seats read, one folder per version. Safe to delete whole: the next seat to start rebuilds what it needs. */
export function contentRoot(homeDir = home()): string {
  return join(stateRoot(homeDir), "content");
}

export function worktreeRoot(homeDir = home()): string {
  return join(stateRoot(homeDir), "worktrees");
}

export function spoolDir(homeDir = home()): string {
  return join(stateRoot(homeDir), "spool");
}

export function nodeBin(): string {
  if (basename(process.execPath) === "node") return process.execPath;
  for (const dir of (process.env.PATH ?? "").split(delimiter).concat(["/opt/homebrew/bin", "/usr/local/bin"])) {
    const candidate = join(dir, "node");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return "node";
}

export function outboxPath(homeDir = home()): string {
  return join(stateRoot(homeDir), "outbox.json");
}

export function pluginDir(configPath = paseoConfigPath()): string | undefined {
  if (process.env.SEATWORKS_PLUGIN_DIR) return process.env.SEATWORKS_PLUGIN_DIR;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const entry = config?.plugins?.[PLUGIN_ID];
    return entry?.source === "directory" && typeof entry.path === "string" ? entry.path : undefined;
  } catch {
    return undefined;
  }
}
