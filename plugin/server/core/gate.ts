import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type GateResult = { ok: boolean; code: number | null; timedOut: boolean; seconds: number; tail: string };

const TAIL_LINES = 40;
const TAIL_CHARS = 3000;

export function tailOf(text: string): string {
  const kept = text.trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join("\n");
  return kept.length > TAIL_CHARS ? kept.slice(-TAIL_CHARS) : kept;
}

/** Reads only the tail: a gate log can grow past what a whole-file read survives. Drops a partial first line. */
export function lastBytes(file: string, limit = 64 * 1024): string {
  try {
    const size = statSync(file).size;
    const from = Math.max(0, size - limit);
    const buffer = Buffer.alloc(Math.min(size, limit));
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, from);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString("utf-8");
    return from === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch {
    return "";
  }
}

export function runGate(command: string, cwd: string, logFile: string, timeoutMs: number): Promise<GateResult> {
  mkdirSync(dirname(logFile), { recursive: true });
  const started = Date.now();
  const fd = openSync(logFile, "w");
  writeSync(fd, `$ ${command}\n`);
  return new Promise((resolve) => {
    // Straight to the log fd: a pipe would be inherited by leftover processes and hold "close" open indefinitely.
    const child = spawn("/bin/sh", ["-c", command], { cwd, env: { ...process.env, CI: "1" }, detached: true, stdio: ["ignore", fd, fd] });
    let timedOut = false;
    let answered = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      // Kill the group: a leftover watcher, dev server or `&` job would keep writing into the lane's copy and this log.
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      try {
        closeSync(fd);
      } catch {}
      resolve({ ok: code === 0 && !timedOut, code, timedOut, seconds: Math.round((Date.now() - started) / 1000), tail: tailOf(lastBytes(logFile)) });
    };
    child.on("error", () => finish(127));
    // exit, not close: the command's own answer, whatever it left running behind it.
    child.on("exit", (code, signal) => finish(code ?? (signal ? null : 0)));
  });
}
