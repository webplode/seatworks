import { clip } from "../../core/text.ts";
import type { Ask } from "../../domain/ask.ts";

export const list = (items: string[] | undefined, empty = "none") =>
  items && items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
export const firstLine = (text: string) =>
  text
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim() ?? "";

/** A person's note as a sentence: theirs often ends in a full stop already, and one more reads as a typo. */
export const ended = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * Every kind of letter the desk mails: a letter's key starts with its kind, as does the id Paseo shows for its message.
 */
type Kind =
  | "answer"
  | "answeredFor"
  | "ask"
  | "audit"
  | "amended"
  | "baseconflict"
  | "basemoved"
  | "beside"
  | "blockchanged"
  | "case"
  | "closed"
  | "detour"
  | "done"
  | "evidence"
  | "failed"
  | "gone"
  | "halfopen"
  | "held"
  | "hold"
  | "humananswered"
  | "humanwrote"
  | "incident"
  | "land"
  | "landback"
  | "landheld"
  | "lanebeside"
  | "lapsed"
  | "later"
  | "leadgone"
  | "merge"
  | "message"
  | "notstarted"
  | "nudge"
  | "opened"
  | "pastappetite"
  | "pending"
  | "permission"
  | "permitted"
  | "reconcile"
  | "report"
  | "resumed"
  | "rework"
  | "settled"
  | "settling"
  | "silent"
  | "started"
  | "unanswered"
  | "withdrawn";

/**
 * A letter to a seat: a second one with its key is the same letter, and `wakes` false is word that asks nothing of its
 * reader now, which rides along with the next letter that does.
 */
export type Letter = { key: string; text: string; wakes?: false };

/**
 * Keyed by its kind and the ids that make it this letter, never where it is posted; it ends with what it asks, `next`.
 */
export const mail = (kind: Kind, ids: (string | number)[], text: string, next: string): Letter => ({
  key: [kind, ...ids].join(":"),
  text: `${text}\n\nNext: ${next}`,
});

export const fyi = (letter: Letter): Letter => ({ ...letter, wakes: false });

/**
 * What a seat is sent at once. Several letters come under an index of their heads, each numbered, so a reader takes in
 * the whole queue before any one of it and never reads one letter as part of the next.
 */
export function mailbox(items: string[], open: Ask[], remaining = 0): string {
  const count = items.length;
  const index = items.map((item, at) => `${at + 1} ${clip(firstLine(item), 100)}`).join(" · ");
  const body =
    count === 1
      ? items[0]!
      : [`${count} messages: ${index}`, ...items.map((item, at) => `--- ${at + 1} of ${count} ---\n\n${item}`)].join(
          "\n\n",
        );
  const overflow =
    remaining > 0
      ? `\n\n---\n\n${remaining} more ${remaining === 1 ? "message remains" : "messages remain"} queued for your next intake boundary.`
      : "";
  if (open.length === 0) return `${body}${overflow}`;
  const asks = open.map((ask) => `- ${ask.id} (${ask.kind}): ${clip(firstLine(ask.text), 160)}`).join("\n");
  return `${body}${overflow}\n\n---\n\nOpen asks waiting on you:\n${asks}`;
}
