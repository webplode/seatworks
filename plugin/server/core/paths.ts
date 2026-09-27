import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, extname, join, resolve } from "node:path";
import { getPath, isRecord } from "./json.ts";

export const PLUGIN_ID = "seatworks-v3";

export function home(): string {
  return process.env.HOME || homedir();
}

export function expandHome(value: string, homeDir = home()): string {
  if (value === "HOME" || value === "~") return homeDir;
  if (value.startsWith("HOME/")) return join(homeDir, value.slice(5));
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

/** Where Paseo keeps its config and plugins: PASEO_HOME when the daemon was given one, read as Paseo reads it. */
export function paseoHome(homeDir = home()): string {
  const given = process.env.PASEO_HOME;
  return given ? resolve(expandHome(given, homeDir)) : join(homeDir, ".paseo");
}

export function paseoConfigPath(homeDir = home()): string {
  return join(paseoHome(homeDir), "config.json");
}

export const RECORDS = ["events", "attention", "assessments", "reviews"] as const;

export const DESK_OWNED = new Set([
  "ledger.json",
  "incidents.json",
  "project.json",
  "meta.json",
  "settings.json",
  "status.md",
  "report.json",
  ...RECORDS.map((name) => `${name}.log`),
  "handbacks",
  "gates",
  "archive",
]);

export function stateRoot(homeDir = home()): string {
  return join(homeDir, ".local", "share", "seatworks-v3");
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

/**
 * Where seats' team servers reach the desk: a socket beside the state it keeps, open to this user alone; on Windows, which
 * has no socket files, a named pipe named for that state.
 */
export function deskSocket(homeDir = home()): string {
  const root = stateRoot(homeDir);
  if (process.platform !== "win32") return join(root, "desk.sock");
  return `\\\\.\\pipe\\seatworks-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

export function nodeBin(): string {
  if (/^node(\.exe)?$/i.test(basename(process.execPath))) return process.execPath;
  return executableIn([...pathDirs(), "/opt/homebrew/bin", "/usr/local/bin"], "node") ?? "node";
}

/** The directories on this process's PATH, in order; an empty one is the working directory, as the shell reads it. */
export function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(delimiter);
}

/** The first of `dirs` holding a `name` this process may run; on Windows, `name` with an extension `PATHEXT` names. */
export function executableIn(dirs: string[], name: string): string | undefined {
  const names =
    process.platform === "win32" && !extname(name)
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").flatMap((ext) => (ext ? [`${name}${ext}`] : []))
      : [name];
  for (const dir of dirs)
    for (const file of names.map((each) => join(dir, each)))
      try {
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        // Not there, or not ours to run: the next name or directory may have it.
      }
  return undefined;
}

/** How to start `name` from `dirs`: on Windows an npm-installed command is a .cmd, which only a shell starts, its path quoted. */
export function commandIn(dirs: string[], name: string): { file: string; shell: boolean } {
  const found = executableIn(dirs, name) ?? name;
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(found)
    ? { file: `"${found}"`, shell: true }
    : { file: found, shell: false };
}

export function pluginDir(configPath = paseoConfigPath()): string | undefined {
  try {
    const entry = getPath(JSON.parse(readFileSync(configPath, "utf-8")) as unknown, ["plugins", PLUGIN_ID]);
    return isRecord(entry) && entry.source === "directory" && typeof entry.path === "string" ? entry.path : undefined;
  } catch {
    return undefined;
  }
}
