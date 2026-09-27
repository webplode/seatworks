import type { SeatLook } from "../../core/ports.ts";
import { mailbox } from "../../desk/letters/envelope.ts";
import { projectOf } from "../../desk/project/project.ts";
import { loadLedger } from "../../desk/store/ledger.ts";
import { openAsksTo } from "../../domain/ledger.ts";
import type { Letter } from "./outbox.ts";

/** What a seat is sent at once: its letters, and the asks still waiting on it where its project can be read. */
export function composeMail(seat: SeatLook, list: Letter[], remaining: number): string {
  const items = list.map((letter) => letter.text);
  if (!seat.cwd) return mailbox(items, [], remaining);
  try {
    return mailbox(items, openAsksTo(loadLedger(projectOf(seat.cwd).state), seat.id), remaining);
  } catch {
    // A ledger that cannot be read holds back no letter: the asks are only a reminder beside them.
    return mailbox(items, [], remaining);
  }
}
