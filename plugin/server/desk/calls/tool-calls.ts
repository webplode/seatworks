import { z } from "zod";
import type { ArgSchema } from "../../catalog/kit/kit.ts";
import { schemaOf, seatOf } from "../../catalog/kit/roles.ts";
import { errorText } from "../../core/errors.ts";
import { KeyedQueue } from "../../core/keyed-queue.ts";
import { sortKeys } from "../../core/json.ts";
import { clip } from "../../core/text.ts";
import { argsProblems, shapeOf, typedArgs, withoutNulls } from "./args.ts";
import { type Args, type Caller, type ToolReply, type ToolRequest, no } from "../context.ts";
import { inTime } from "./in-time.ts";
import { decisionFacts } from "../watch/decision-facts.ts";
import { callLetters } from "../letters/call-letters.ts";
import { type Project, projectOf } from "../project/project.ts";
import type { DeskServices, ToolDef } from "../services.ts";
import { recordEvent } from "../store/event-log.ts";
import type { Intents } from "../store/intents.ts";

/** How long a harness waits on one call before it gives up; the desk answers first. */
export const ANSWER_WITHIN_MS = 240_000;

export class ToolCalls {
  private readonly running = new Map<string, { reply: Promise<ToolReply>; started: number }>();
  private readonly desk: DeskServices;
  private readonly tools: ToolDef[];
  private readonly intents: Intents;
  /** What the record shows at each decision, being read: one key per call, so none waits on another. */
  private readonly deciding = new KeyedQueue();
  private decided = 0;

  constructor(desk: DeskServices, tools: ToolDef[], intents: Intents) {
    this.desk = desk;
    this.tools = tools;
    this.intents = intents;
  }

  /** Whether a call from this seat is still being worked on — which is not silence. */
  inFlight(agentId: string): boolean {
    return [...this.running.keys()].some((key) => key.startsWith(`${agentId}\n`));
  }

  /**
   * A harness waits minutes for a call but a gate may run thirty: a call that runs long is answered with what is
   * happening and its result mailed; the same call again while it runs joins it, and one its caller gives up on mails.
   */
  answer(
    request: ToolRequest,
    { within = ANSWER_WITHIN_MS, cancelled }: { within?: number; cancelled?: AbortSignal } = {},
  ): Promise<ToolReply> {
    const key = `${request.agent}\n${request.tool}\n${JSON.stringify(sortKeys(request.args ?? {}))}`;
    const running = this.running.get(key);
    const kept = { intents: this.intents, mail: this.desk.mail };
    if (running)
      return inTime(request, running.reply, { started: running.started, within, again: true, cancelled }, kept);
    const started = Date.now();
    // A throw is answered too: only a resolved reply posts the letter the seat was promised.
    const reply = this.handle(request)
      .catch((error: unknown) => no(`The desk failed: ${errorText(error)}`))
      .finally(() => {
        if (this.running.get(key)?.started === started) this.running.delete(key);
      });
    this.running.set(key, { reply, started });
    return inTime(request, reply, { started, within, again: false, cancelled }, kept);
  }

  /** Once what the record shows at every decision made so far in the project has been read and noticed. */
  settled(project: Project): Promise<unknown> {
    return this.deciding.idle(`${project.slug}\n`);
  }

  /** A reply that went out but never reached its seat, whose call was stopped or whose line dropped: mailed instead. */
  mailLost(request: ToolRequest, reply: ToolReply): Promise<unknown> {
    const call = { agent: request.agent, tool: request.tool, started: request.at };
    return this.desk.mail.post(request.agent, callLetters.later(call, reply, true));
  }

  private async handle(request: ToolRequest): Promise<ToolReply> {
    const caller = await this.caller(request);
    if ("error" in caller) return no(caller.error);
    const { reply, speaks } = await this.run(caller, request);
    const text = clip(reply.text, 300);
    recordEvent(caller.project, {
      kind: "tool",
      agent: caller.id,
      role: caller.role.role,
      tool: request.tool,
      ok: reply.ok,
      reply: text,
    });
    if (reply.ok) {
      this.heardFrom(caller, speaks);
      // A decision made through the desk is judged at the seat's next look, on what the call itself says; what the
      // record shows of it, now.
      this.desk.decisions.took(caller.id, request.tool, request.args ?? {});
      void this.deciding.run(`${caller.project.slug}\n${++this.decided}`, () =>
        decisionFacts(this.desk, caller, request.tool, request.args ?? {}).catch((error) =>
          this.desk.log(
            caller.project,
            `what the record shows at ${request.tool} could not be read: ${errorText(error)}`,
          ),
        ),
      );
    }
    return reply;
  }

  private async run(caller: Caller, request: ToolRequest): Promise<{ reply: ToolReply; speaks?: true }> {
    const shown = schemaOf(this.desk.kit, caller.role, request.tool);
    const tool = shown ? servedBy(this.tools, request.tool, shown) : undefined;
    if (!shown || !tool) return { reply: no(`Unknown tool ${request.tool}.`) };
    const args = typedArgs(shown, request.args ?? {}) as Args;
    const problems = argsProblems(shown, args);
    if (problems.length > 0)
      return { reply: no(`${request.tool} was not carried out: it ${problems.join("; ")}. ${shapeOf(shown)}`) };
    try {
      return { reply: await tool.handle(this.desk, caller, tool.input.parse(withoutNulls(args))), speaks: tool.speaks };
    } catch (error) {
      this.desk.log(caller.project, `${caller.role.role} ${caller.id} ${request.tool} crashed: ${errorText(error)}`);
      return { reply: no(`${request.tool} failed: ${errorText(error)}`) };
    }
  }

  /** Notes that the seat was heard from; noting it must not turn a reply it has earned into a crash. */
  private heardFrom(caller: Caller, speaks: boolean | undefined): void {
    try {
      this.desk.ledgers.transact(caller.project, (ledger) => {
        const ref = ledger.agents[caller.id] ?? { id: caller.id, role: caller.role.role };
        ref.recordedAt = Date.now();
        if (speaks) ref.spokeAt = ref.recordedAt;
        ledger.agents[caller.id] = ref;
      });
    } catch (error) {
      this.desk.log(caller.project, `could not record that ${caller.id} was heard from: ${errorText(error)}`);
    }
  }

  private async caller(request: ToolRequest): Promise<Caller | { error: string }> {
    if (!request.agent) return { error: "This tool works only inside a team agent." };
    const seat = await this.desk.roster.look(request.agent);
    const role = seatOf(this.desk.kit, seat.provider)?.role;
    if (!role?.tools) return { error: "This agent is not part of the team." };
    if (role.role !== request.role)
      return { error: `This agent is a ${role.label}, so ${request.role} tools are not available to it.` };
    const project = projectOf(seat.cwd ?? request.cwd);
    return { id: request.agent, role, title: seat.title ?? request.agent, project };
  }
}

/** A schema as a shape to compare: what each field is and must hold, not how it is described to a seat. */
function structure(schema: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(schema).sort()) {
    const value = schema[key];
    if (key === "description" || key === "$schema" || key === "additionalProperties") continue;
    if (key === "properties")
      kept[key] = Object.fromEntries(
        Object.entries(value as Record<string, Record<string, unknown>>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, field]) => [name, structure(field)]),
      );
    else if (key === "items") kept[key] = structure(value as Record<string, unknown>);
    else if (key === "required") kept[key] = [...(value as string[])].sort();
    else kept[key] = value;
  }
  return kept;
}

const shapes = new WeakMap<object, string>();

function shapeKey(owner: object, schema: () => unknown): string {
  let shape = shapes.get(owner);
  if (shape === undefined) shapes.set(owner, (shape = JSON.stringify(structure(schema() as Record<string, unknown>))));
  return shape;
}

/**
 * The tool that serves `name` as `shown` describes it: tools of one name differ by what they take, and a role's tool
 * set picks which it is shown.
 */
export function servedBy(tools: ToolDef[], name: string, shown: ArgSchema): ToolDef | undefined {
  const wanted = shapeKey(shown, () => shown);
  return tools.find(
    (tool) => tool.name === name && shapeKey(tool, () => z.toJSONSchema(tool.input, { io: "input" })) === wanted,
  );
}
