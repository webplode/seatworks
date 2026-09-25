import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const BriefSchema = z.object({
  supervisor: z.string().nullable(), workspace: z.string().nullable(), active: z.boolean(), signIn: z.string().nullable(),
  lines: z.number(), needsYou: z.number(), questions: z.number(), held: z.number(),
  projects: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(),
    streams: z.array(z.object({ id: z.string(), title: z.string(), state: z.string(), agent: z.string().nullable() })).optional() })),
  items: z.array(z.object({ id: z.string(), project: z.string(), title: z.string(), detail: z.string(), plain: z.string().optional(), agent: z.string().nullable(), kind: z.enum(["permission", "question", "plan", "land", "tests", "review", "commit", "error"]),
    scope: z.string().optional(), lane: z.string().optional(), diff: z.string().optional(), stays: z.boolean().optional(), held: z.boolean().optional(), files: z.array(z.string()).optional(), action: z.enum(["reload", "models"]).optional() })),
  omitted: z.number(),
});
export type TeamBrief = z.infer<typeof BriefSchema>;
/** Cards one Approve all click may act on: landing or finishing work whose tests did not fail, and committing team files. A plan or a landing the project holds for a closer look gets its own answer. */
export const approvable = (item: TeamBrief["items"][number]) => (item.kind === "land" && !item.held && Boolean(item.scope && item.lane)) || (item.kind === "commit" && Boolean(item.scope));
export const briefRpc = defineRpc({ name: "seatworks.team.brief", input: z.object({}), output: BriefSchema });
/** "1 question", "2 questions". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const briefLabel = (brief: TeamBrief) => !brief.active ? "Paused" : `${brief.lines ? count(brief.lines, "piece of work", "pieces of work") : "No work yet"} · ${brief.needsYou ? `${brief.needsYou} waiting for you` : brief.questions ? count(brief.questions, "team question") : brief.items.length ? "something to check" : "all good"}`;
export const commitTeamFilesRpc = defineRpc({ name: "seatworks.team.commit-files", input: z.object({ scope: z.string() }), output: z.object({ committed: z.array(z.string()) }) });
export const reloadSupervisorRpc = defineRpc({ name: "seatworks.supervision.reload", input: z.object({}), output: z.object({ agent: z.string() }) });
