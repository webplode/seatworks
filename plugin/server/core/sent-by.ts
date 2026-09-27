import { randomUUID } from "node:crypto";

/** The start of every message id the desk sends, which no person's client uses. */
const DESK_MARK = "sw3-";

export const deskId = (kinds: string[]) => `${DESK_MARK}${kinds.join(".")}-${randomUUID()}`;

/**
 * Paseo gives every message sent into a chat an id, and a daemon restart rebuilds a history from the agent's transcript
 * without them.
 */
export function sentBy(item: Record<string, unknown>): string[] {
  const id = item.clientMessageId;
  if (typeof id !== "string" || id === "") return ["unknown"];
  return id.startsWith(DESK_MARK) ? id.slice(DESK_MARK.length).split("-")[0]!.split(".") : ["person"];
}
