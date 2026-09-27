import assert from "node:assert/strict";
import type { z } from "zod";
import { PaseoHost } from "../../server/adapters/paseo/host.ts";
import { registerRpc } from "../../server/runtime/panel/rpc.ts";
import { Runtime } from "../../server/runtime/runtime.ts";
import { makeKit } from "../kit.ts";
import { fakeConfig } from "./fake-paseo.ts";

type Contract = { name: string; input: z.ZodType; output: z.ZodType };
type Handler = (input: unknown, context: { paseo: unknown }) => unknown;
type Provider = { additionalModels?: { id: string }[] };

type Listed = { models?: { id: string; label: string }[]; error?: string };

/** A daemon with nobody seated, `live` aside, its config as `config` holds it, and each agent's models as `models` lists them. */
export function daemon(
  config = fakeConfig(),
  live: { provider: string }[] = [],
  models: (provider: string) => Listed = () => ({ error: "not listed" }),
) {
  const asked: { kind: "refresh" | "list"; provider: string; cwd?: string }[] = [];
  const opened = new Map<string, string>();
  const archived: string[] = [];
  return {
    asked,
    opened,
    archived,
    workspaces: {
      // The daemon finds the folder's workspace, or makes one (open_project_request).
      async open(cwd: string) {
        if (!opened.has(cwd)) opened.set(cwd, `ws-${opened.size + 1}`);
        return { id: opened.get(cwd)!, projectId: `prj:${cwd}` };
      },
      async archive(id: string) {
        archived.push(id);
        return { archivedAt: new Date().toISOString() };
      },
    },
    providers: {
      async refresh(options: { cwd?: string; providers?: string[] }) {
        for (const provider of options.providers ?? []) asked.push({ kind: "refresh", provider, cwd: options.cwd });
        return { acknowledged: true };
      },
      async listModels(provider: string, options?: { cwd?: string }) {
        asked.push({ kind: "list", provider, cwd: options?.cwd });
        return models(provider);
      },
    },
    agents: {
      list: async () => ({
        entries: live.map((agent, index) => ({ agent: { id: `live-${index}`, archivedAt: null, ...agent } })),
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      }),
    },
    config: config.api,
  };
}

/**
 * The plugin's panel side as Paseo serves it, on the test kit: each contract's handler called with the daemon handle,
 * the input read by its schema, and the answer as sent read back by the schema the panel checks it with.
 */
export function served(paseo: unknown = daemon()) {
  // A socket nobody is at, unless a test names a Paseo of its own: the doctor never asks the owner's daemon for its tools.
  process.env.PASEO_LISTEN ??= "unix:///nowhere/paseo.sock";
  const host = new PaseoHost();
  const runtime = new Runtime(makeKit(), host);
  const handlers = new Map<string, Handler>();
  const server = { handle: (contract: Contract, handler: Handler) => void handlers.set(contract.name, handler) };
  registerRpc(host.answering(server as never), runtime.panel);
  /** The providers of the kit's that Paseo's config holds, by id. */
  const providers = async () => {
    const { config } = await (paseo as ReturnType<typeof daemon>).config.get();
    return Object.fromEntries(
      Object.entries(config.providers as Record<string, Provider>).filter(([id]) => id.startsWith("sw3-")),
    );
  };
  const call = async <C extends Contract>(contract: C, input: z.input<C["input"]>): Promise<z.output<C["output"]>> => {
    const handler = handlers.get(contract.name);
    assert.ok(handler, `nothing serves ${contract.name}`);
    const answer: unknown = await handler(contract.input.parse(input), { paseo });
    return contract.output.parse(JSON.parse(JSON.stringify(answer))) as z.output<C["output"]>;
  };
  return { call, host, handlers, runtime, providers };
}

/** The case of a union answer that holds `key`, or the test fails with the answer that came instead. */
export function which<T, K extends string>(answer: T, key: K): Extract<T, Record<K, unknown>> {
  assert.ok(typeof answer === "object" && answer !== null && key in answer, `no ${key} in ${JSON.stringify(answer)}`);
  return answer as Extract<T, Record<K, unknown>>;
}
