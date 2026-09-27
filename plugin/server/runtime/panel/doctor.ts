import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check } from "../../../shared/views.ts";
import type { HarnessSpec, Kit } from "../../catalog/kit/kit.ts";
import { paseoToolsPolicy } from "../../catalog/kit/harness-files.ts";
import { type FilledProxy, connectToServer, hookTools, proxyOf } from "../../catalog/seat/servers.ts";
import { type McpState, toolsFor } from "../../catalog/team/mcp-states.ts";
import type { RoleSeat } from "../../catalog/team/role-seats.ts";
import type { Team } from "../../catalog/team/team.ts";
import { errorText } from "../../core/errors.ts";
import { reaches, toolNames } from "../../core/mcp-client.ts";
import { commandIn, executableIn, expandHome, pathDirs } from "../../core/paths.ts";

const onPath = (bin: string): boolean => executableIn(pathDirs(), bin) !== undefined;

type Listed = { names: string[] } | { error: string } | undefined;

/** The env Paseo's own provider of that id gives every seat that extends it. */
export type ProviderEnv = (provider: string) => Promise<Record<string, string>>;

type Found = Omit<Check, "group">;

const inGroup =
  (group: Check["group"]) =>
  (check: Found): Check => ({ ...check, group });

/** What the panel's Health section shows: the settings, git, each agent the seats run on, each MCP server in use, and Paseo's own tools. */
export async function doctor(
  kit: Kit,
  team: Team,
  paseoTools: () => Promise<Listed>,
  providerEnv: ProviderEnv,
): Promise<Check[]> {
  const settings = {
    id: "settings",
    ok: team.errors.length === 0,
    detail: team.errors.length === 0 ? "The settings resolve to a complete team." : team.errors.join("\n"),
  };
  const checks: Check[] = [
    ...[settings, gitCheck()].map(inGroup("machine")),
    ...harnessChecks(kit, team).map(inGroup("agent")),
  ];
  for (const [id, roles] of harnessRoles(team)) {
    const check = await loginCheck(kit.harnesses[id]!, roles, providerEnv);
    if (check) checks.push(inGroup("agent")(check));
  }
  for (const state of Object.values(team.mcp).filter((server) => server.enabled)) {
    const check = await serverCheck(team, state);
    if (check) checks.push(inGroup("server")(check));
  }
  const paseo = await paseoCheck(kit, team, paseoTools);
  if (paseo) checks.push(inGroup("machine")(paseo));
  return checks;
}

/** When a seat has Paseo's own tools on: `allow` leaves on a tool catalog/paseo.json lacks, and a seat is asked before one it does not pre-approve. */
async function paseoCheck(kit: Kit, team: Team, paseoTools: () => Promise<Listed>): Promise<Found | undefined> {
  if (Object.values(team.roles).every((seat) => paseoToolsPolicy(kit, seat.role)?.enabled === false)) return undefined;
  const id = "paseo:tools";
  const listed = await paseoTools();
  if (!listed)
    return {
      id,
      ok: true,
      detail: "Paseo listens on a socket, where the desk cannot ask for its tools; this is not a check.",
    };
  if ("error" in listed) return { id, ok: false, detail: `Paseo's own tools could not be listed: ${listed.error}.` };
  const has = new Set(listed.names);
  const lacked = listed.names.filter((tool) => !kit.paseoTools.includes(tool)).sort();
  const gone = kit.paseoTools.filter((tool) => !has.has(tool)).sort();
  if (lacked.length === 0 && gone.length === 0)
    return { id, ok: true, detail: `catalog/paseo.json lists Paseo's ${listed.names.length} tools.` };
  const said = [
    ...(lacked.length > 0
      ? [
          `Paseo has ${lacked.join(", ")}, which catalog/paseo.json lacks: a role that lists \`allow\` leaves it on, and a seat is asked before using it.`,
        ]
      : []),
    ...(gone.length > 0 ? [`catalog/paseo.json names ${gone.join(", ")}, which Paseo does not have.`] : []),
  ];
  return { id, ok: false, detail: said.join(" ") };
}

/** Git, which the desk runs itself for every lane and task; what a skill runs, its own compatibility line names. */
function gitCheck(): Found {
  const ok = onPath("git");
  return { id: "bin:git", ok, detail: ok ? "git is on PATH." : "git is not on PATH; the desk and every seat need it." };
}

/** Each agent the team's seats run on: its command on PATH, and the files its harness says it needs. */
function harnessRoles(team: Team): Map<string, string[]> {
  const harnesses = new Map<string, string[]>();
  for (const seat of Object.values(team.roles))
    harnesses.set(seat.harness.id, [...(harnesses.get(seat.harness.id) ?? []), seat.role.label]);
  return harnesses;
}

function harnessChecks(kit: Kit, team: Team): Found[] {
  const checks: Found[] = [];
  for (const [id, roles] of harnessRoles(team)) {
    const harness = kit.harnesses[id]!;
    const bin = harness.provider.env?.SEATWORKS_AGENT_BIN;
    if (bin) {
      const ok = onPath(bin);
      checks.push({
        id: `harness:${id}`,
        ok,
        detail: ok
          ? `${harness.label} (${bin}) is installed for ${roles.join(", ")}.`
          : `${harness.label} needs \`${bin}\` on PATH for ${roles.join(", ")}.`,
      });
    }
    for (const check of harness.checks ?? []) {
      const path = expandHome(check.path);
      const ok = existsSync(path);
      checks.push({
        id: `harness:${id}:${check.path}`,
        ok,
        detail: ok
          ? `${harness.label} has ${path}.`
          : `${harness.label} needs ${path} for ${roles.join(", ")}. ${check.help}`,
      });
    }
    const inherited = harness.settings.inherits;
    if (inherited) {
      const path = expandHome(inherited.from);
      checks.push({
        id: `harness:${id}:inherits`,
        ok: true,
        detail: `${harness.label} seats for ${roles.join(", ")} inherit ${inherited.keys.join(", ")} from ${path}; changes to that Human-owned file change their capabilities.`,
      });
    }
  }
  return checks;
}

/**
 * Whether a new seat starts logged in, for an agent that keeps its login per settings folder (Claude Code on macOS, in
 * the keychain): asked in an empty folder of its own, with the env a seat gets from Paseo's provider and its own.
 */
async function loginCheck(harness: HarnessSpec, roles: string[], providerEnv: ProviderEnv): Promise<Found | undefined> {
  const bin = harness.provider.env?.SEATWORKS_AGENT_BIN;
  const { login, configDirEnv } = harness;
  if (!login || !configDirEnv || !bin || !onPath(bin)) return undefined;
  const id = `harness:${harness.id}:login`;
  const dir = mkdtempSync(join(tmpdir(), "sw3-login-"));
  try {
    const seat = { ...(await providerEnv(harness.baseProvider)), ...harness.provider.env, [configDirEnv]: dir };
    const env = { ...process.env, ...seat };
    const answer = JSON.parse(await printed(bin, login.run, env)) as Record<string, unknown>;
    return answer[login.field] === true
      ? { id, ok: true, detail: `A new ${harness.label} seat is logged in, for ${roles.join(", ")}.` }
      : {
          id,
          ok: false,
          detail: `A new ${harness.label} seat is not logged in: ${roles.join(", ")} would stop at "Not logged in". ${login.help}`,
        };
  } catch (error) {
    return {
      id,
      ok: false,
      detail: `Whether a new ${harness.label} seat is logged in could not be checked: ${errorText(error)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What `bin` prints, whatever it exits with: an agent logged out may still answer, and say so with its exit code. */
function printed(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { file, shell } = commandIn(pathDirs(), bin);
  return new Promise((resolve, reject) =>
    execFile(file, args, { env, shell, timeout: 15_000, windowsHide: true }, (error, stdout, stderr) =>
      String(stdout).trim() || !error
        ? resolve(String(stdout))
        : reject(new Error((String(stderr) || error.message).trim().slice(0, 300))),
    ),
  );
}

/** An enabled server some seat uses; one that throws is that server's failed check, not the loss of the checks before it. */
async function serverCheck(team: Team, state: McpState): Promise<Found | undefined> {
  try {
    const users = Object.values(team.roles).filter((seat) => seat.mcp.includes(state.id));
    if (users.length === 0) return undefined;
    const help = state.entry?.help ? ` ${state.entry.help}` : "";
    const proxy = proxyOf(state);
    // Proxy entries never use `connect`: `serversFor` builds a proxy from its own backend.
    return proxy ? await proxyCheck(state, proxy, users, help) : await directCheck(state, help);
  } catch (error) {
    return { id: `mcp:${state.id}`, ok: false, detail: `${state.label} could not be checked: ${errorText(error)}` };
  }
}

/** A proxy's backend: its command on PATH, or a server at its address exposing every tool the team uses of it. */
async function proxyCheck(state: McpState, proxy: FilledProxy, users: RoleSeat[], help: string): Promise<Found> {
  const id = `mcp:${state.id}`;
  if (proxy.backend.type === "stdio") {
    const bin = proxy.backend.command[0] ?? "";
    const ok = Boolean(bin) && onPath(bin);
    return {
      id,
      ok,
      detail: ok ? `${state.label} starts through ${bin}.` : `${state.label} needs \`${bin}\` on PATH.${help}`,
    };
  }
  const { urls } = proxy.backend;
  const needed = new Set<string>([...hookTools(proxy), ...users.flatMap((seat) => toolsFor(state, seat.role))]);
  // Every address at once: the seats take the first that answers, so the check passes when one serves all they use.
  const read = await Promise.all(
    urls.map(async (url) => {
      const listed = await toolNames(url, 3000);
      const exposed = new Set(listed.names ?? []);
      return { url, answered: Boolean(listed.names), missing: [...needed].filter((tool) => !exposed.has(tool)).sort() };
    }),
  );
  const answered = read.filter((entry) => entry.answered);
  if (answered.length === 0)
    return { id, ok: false, detail: `No ${state.label} server answered at ${urls.join(", ")}.${help}` };
  const serving = answered.find((entry) => entry.missing.length === 0);
  const silent = read.filter((entry) => !entry.answered).map((entry) => entry.url);
  const also = silent.length > 0 ? ` Nothing answered at ${silent.join(", ")}.` : "";
  return serving
    ? { id, ok: true, detail: `${state.label} at ${serving.url} exposes every tool the team uses.${also}` }
    : {
        id,
        ok: false,
        detail: `${state.label} at ${answered[0]!.url} doesn't expose ${answered[0]!.missing.join(", ")}.${also}${help}`,
      };
}

/** A server the seats reach themselves: its command on PATH, or an address that answers; an SSE server is not probed. */
async function directCheck(state: McpState, help: string): Promise<Found | undefined> {
  const id = `mcp:${state.id}`;
  const shaped = state.connect ? connectToServer(state.connect) : undefined;
  const direct = (shaped ?? (state.entry?.server ? { ...state.entry.server } : undefined)) as
    { type?: string; command?: string; url?: string } | undefined;
  if (direct?.type === "stdio" && direct.command) {
    const ok = onPath(direct.command);
    return {
      id,
      ok,
      detail: ok
        ? `${state.label} starts through ${direct.command}.`
        : `${state.label} needs \`${direct.command}\` on PATH.${help}`,
    };
  }
  // This probe does not speak SSE; run against it, a working server read as never answering.
  if (direct?.type === "sse" && direct.url)
    return {
      id,
      ok: true,
      detail: `${state.label} is an SSE server at ${direct.url}; the desk does not probe that transport, so this is not a check.${help}`,
    };
  if (!direct?.url) return undefined;
  const answered = await reaches(direct.url, 8000);
  return {
    id,
    ok: answered.ok,
    detail: answered.ok
      ? `${state.label} answered.`
      : `${state.label} did not answer: ${answered.error ?? "no MCP result"}.`,
  };
}
