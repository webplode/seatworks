import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const BriefSchema = z.object({
  supervisor: z.string().nullable(), workspace: z.string().nullable(), active: z.boolean(),
  lines: z.number(), needsYou: z.number(), questions: z.number(), held: z.number(),
  projects: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
  items: z.array(z.object({ id: z.string(), project: z.string(), title: z.string(), detail: z.string(), agent: z.string().nullable(), kind: z.enum(["permission", "question", "tests", "review", "error"]) })),
  omitted: z.number(),
});
export type TeamBrief = z.infer<typeof BriefSchema>;
export const briefRpc = defineRpc({ name: "seatworks.team.brief", input: z.object({}), output: BriefSchema });
export const briefLabel = (brief: TeamBrief) => !brief.active ? "Team · paused" : `${brief.lines ? `${brief.lines} work streams` : "Team"} · ${brief.needsYou ? `${brief.needsYou} needs you` : brief.questions ? `${brief.questions} questions` : brief.items.length ? "needs attention" : "ready"}`;
