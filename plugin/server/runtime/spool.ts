import type { ToolReply, ToolRequest } from "../desk/context.ts";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";


const STALE_MS = 10 * 60_000;

export function spoolDirs(spool: string): { requests: string; replies: string } {
  const requests = join(spool, "requests");
  const replies = join(spool, "replies");
  mkdirSync(requests, { recursive: true });
  mkdirSync(replies, { recursive: true });
  return { requests, replies };
}

export function takeRequests(spool: string, now = Date.now()): ToolRequest[] {
  const { requests, replies } = spoolDirs(spool);
  const taken: ToolRequest[] = [];
  for (const name of readdirSync(requests).sort()) {
    const path = join(requests, name);
    if (name.endsWith(".tmp")) {
      try {
        if (now - statSync(path).mtimeMs > STALE_MS) unlinkSync(path);
      } catch {}
      continue;
    }
    if (!name.endsWith(".json")) continue;
    try {
      const request = JSON.parse(readFileSync(path, "utf-8")) as ToolRequest;
      unlinkSync(path);
      if (now - request.at > STALE_MS) continue;
      taken.push(request);
    } catch {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  for (const name of readdirSync(replies)) {
    const path = join(replies, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_MS) unlinkSync(path);
    } catch {}
  }
  return taken;
}

export function replyFile(spool: string, id: string): string {
  return join(spoolDirs(spool).replies, `${id}.json`);
}

export function writeReply(spool: string, id: string, reply: ToolReply): void {
  const temp = join(spoolDirs(spool).replies, `${id}.tmp`);
  writeFileSync(temp, JSON.stringify(reply));
  renameSync(temp, replyFile(spool, id));
}
