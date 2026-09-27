import { z } from "zod";
import { Json, text, texts } from "./fields.ts";
import { Pattern } from "../../../../shared/settings.ts";
import { McpTransport } from "./mcp.ts";

/** A refusal the desk adds to a seat's settings: `as`, with each `{command}` or `{path}` filled in, laid over what is at `at`. */
const Refusal = z.strictObject({ at: text, as: z.union([z.array(z.unknown()).min(1), Json]) });

/** `harness/<id>/harness.json`: how one agent harness is set up, launched and read. */
export const HarnessFile = z
  .strictObject({
    id: text,
    label: text,
    baseProvider: text,
    configDirEnv: text,
    profileRoot: text,
    contextFile: text.optional(),
    skillsDir: text,
    /** `profile`: where a role's settings name a permission profile (`key`), each path is granted `value` in it (`at`). */
    stateWrites: z
      .strictObject({
        path: text,
        delivery: z.enum(["launch", "file"]),
        profile: z.strictObject({ key: text, at: text.includes("PROFILE"), value: text }).optional(),
      })
      .optional(),
    projectContextOption: text.optional(),
    projectInstructions: z
      .strictObject({
        reads: z.array(text).min(1),
        imports: z.array(text).min(1),
        importAs: z.string().includes("{path}", { error: "does not say where the file's path goes" }),
      })
      .optional(),
    mcpCall: z.string().includes("{server}", { error: "does not say where the server's name goes" }).optional(),
    mcpServerField: text.optional(),
    timeline: z
      .strictObject({
        exitField: text.optional(),
        pseudoCalls: z.array(z.strictObject({ name: text, detail: text })).optional(),
        unparsed: z.strictObject({ input: text, error: Pattern }).optional(),
      })
      .optional(),
    settings: z.strictObject({
      file: text,
      source: text,
      roleSource: text,
      inherits: z.strictObject({ from: text, keys: texts }).optional(),
      overlayEnv: text.optional(),
    }),
    links: z.array(z.strictObject({ link: text, target: text, optional: z.boolean().optional() })).optional(),
    files: z.record(z.string(), z.array(z.string()).min(1)).optional(),
    /**
     * How the agent's own rules take what the desk refuses every seat: commands its shell may not start, in its settings or
     * as a `line` of one of its `files`, and paths its file tools may not change or read.
     */
    refuses: z
      .strictObject({
        commands: z
          .union([
            Refusal,
            z.strictObject({
              file: text,
              line: z.string().includes("{words}", { error: "does not say where the command's words go" }),
            }),
          ])
          .optional(),
        edits: Refusal.optional(),
        reads: Refusal.optional(),
      })
      .optional(),
    modelCatalog: z
      .strictObject({
        command: z.array(z.string()).min(1),
        list: z.string(),
        clear: texts,
        file: z.string(),
        setting: z.string(),
      })
      .optional(),
    checks: z.array(z.strictObject({ path: z.string(), help: z.string() })).optional(),
    /** An agent that keeps its login per settings folder: how a new seat's folder answers whether it is logged in. */
    login: z.strictObject({ run: z.array(z.string()).min(1), field: text, help: text }).optional(),
    mcp: z.strictObject({
      file: text,
      delivery: z.enum(["launch", "file"]),
      preapprove: z.boolean().optional(),
      transports: z.array(McpTransport).min(1),
      seed: Json.optional(),
      key: text.optional(),
      clear: z
        .strictObject({
          set: Json.optional(),
          remove: texts.optional(),
          setInEach: z.record(z.string(), Json).optional(),
        })
        .optional(),
      desk: Json.optional(),
    }),
    provider: z.strictObject({
      env: z.record(z.string(), z.string()).optional(),
      profileModeId: text.optional(),
      command: texts.optional(),
      forceFlags: z.record(z.string(), z.string()).optional(),
      keychainEnv: z.record(z.string(), z.string()).optional(),
    }),
  })
  .refine((harness) => harness.mcp.delivery !== "file" || harness.mcp.key, {
    error: "delivers MCP servers in a file but names no key",
    path: ["mcp", "key"],
  })
  .refine(
    (harness) => {
      const commands = harness.refuses?.commands;
      return !commands || !("file" in commands) || commands.file in (harness.files ?? {});
    },
    { error: "writes its refused commands into a file it does not lay down", path: ["refuses", "commands", "file"] },
  );
