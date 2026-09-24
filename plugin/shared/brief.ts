import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const BriefSchema = z.object({
  supervisor: z.string().nullable(), workspace: z.string().nullable(), active: z.boolean(), signIn: z.string().nullable(),
  lines: z.number(), needsYou: z.number(), questions: z.number(), held: z.number(),
  projects: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(),
    streams: z.array(z.object({ id: z.string(), title: z.string(), state: z.string(), agent: z.string().nullable() })).optional() })),
  items: z.array(z.object({ id: z.string(), project: z.string(), title: z.string(), detail: z.string(), agent: z.string().nullable(), kind: z.enum(["permission", "question", "land", "tests", "review", "commit", "error"]),
    scope: z.string().optional(), lane: z.string().optional(), diff: z.string().optional(), stays: z.boolean().optional(), files: z.array(z.string()).optional(), action: z.enum(["reload"]).optional() })),
  omitted: z.number(),
});
export type TeamBrief = z.infer<typeof BriefSchema>;
export const briefRpc = defineRpc({ name: "seatworks.team.brief", input: z.object({}), output: BriefSchema });
/** "1 work stream", "2 work streams". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const briefLabel = (brief: TeamBrief) => !brief.active ? "Team · paused" : `${brief.lines ? count(brief.lines, "work stream") : "Team"} · ${brief.needsYou ? `${brief.needsYou} need${brief.needsYou === 1 ? "s" : ""} you` : brief.questions ? count(brief.questions, "question") : brief.items.length ? "needs attention" : "ready"}`;
export const commitTeamFilesRpc = defineRpc({ name: "seatworks.team.commit-files", input: z.object({ scope: z.string() }), output: z.object({ committed: z.array(z.string()) }) });
export const reloadSupervisorRpc = defineRpc({ name: "seatworks.supervision.reload", input: z.object({}), output: z.object({ agent: z.string() }) });
