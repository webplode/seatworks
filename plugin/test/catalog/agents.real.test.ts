// First, so this file has a HOME of its own even run alone: what it writes under HOME would otherwise land in the owner's.
import "../setup.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hiddenWordsIn } from "../../server/catalog/kit/hidden-words.ts";
import { can, providerId, seatedAs } from "../../server/catalog/kit/roles.ts";
import { harnessFileSources } from "../../server/catalog/kit/harness-files.ts";
import { loadKit } from "../../server/catalog/kit/kit.ts";
import { seatEnv, stateWrites } from "../../server/catalog/seat/launch.ts";
import { desiredProvider, seatPairs } from "../../server/catalog/paseo/providers.ts";
import { materialize, seatDir } from "../../server/catalog/seat/seats.ts";
import { serversFor } from "../../server/catalog/seat/servers.ts";
import { resolveTeam, withHarness } from "../../server/catalog/team/team.ts";
import { readConfig } from "../../server/core/config-file.ts";
import { executableIn, pathDirs, stateRoot } from "../../server/core/paths.ts";
import { ANSWER_WITHIN_MS } from "../../server/desk/calls/tool-calls.ts";
import { tempDir } from "../tempdir.ts";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DESK_GIT = "push pull checkout switch update-ref stash".split(" ");
/** `git worktree list` is a seat's to read; the git shim refuses every other worktree command, on every agent. */
const WORKTREE = / worktree/;
/** What moves the branch checked out: a writing seat's own task branch, where it always stands; refused outright to the rest. */
const MOVES = "merge reset rebase cherry-pick".split(" ");
const SEARCHES = ["supervisor", "lead", "peer", "reviewer"];
const BUILT_INS: Record<string, string[]> = {
  claude:
    "Bash Edit Write MultiEdit NotebookEdit Read Glob Grep LSP WebFetch WebSearch Skill TodoWrite TaskCreate TaskGet TaskList TaskUpdate AskUserQuestion".split(
      " ",
    ),
  omp: "read grep find glob lsp todo ast_grep ast_edit edit write bash eval debug wait web_search".split(" "),
  opencode: "read edit glob grep list lsp skill todowrite webfetch websearch question task".split(" "),
};

/** The value at a dotted path of a built seat's settings. */
const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
      value,
    );
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
/** Every way a shell starts `agent` that each agent's rules refuse, the catalog's agents all alike. */
const startsOf = (agent: string) => [agent, `${agent} *`, `npx ${agent} *`, `bunx ${agent} *`];
/** What of the state root a seat's file tools keep off, which no sandbox binds: the desk's record, what replaces the kit's files, and the Human's word. */
const KEPT = ["roles.json", "refused.json", "own/**", "projects/*/ledger.json", "projects/*/CONTEXT.md"].map(
  (path) => `${stateRoot("~")}/${path}`,
);

test("every role builds on every agent the kit ships, each in that agent's own terms", (t) => {
  const kit = loadKit(PLUGIN);
  const base = resolveTeam(kit, { mcp: Object.fromEntries(Object.keys(kit.mcp).map((id) => [id, { enabled: true }])) });
  const home = tempDir("sw3-every-home-");
  const project = { root: "/work/demo", slug: "demo-000000", state: "/state/demo" };
  const agents = Object.values(kit.harnesses).flatMap((harness) => harness.provider.env?.SEATWORKS_AGENT_BIN ?? []);
  for (const { role, harness } of seatPairs(kit)) {
    const where = `${role.role} on ${harness.id}`;
    // A role like another is held to that role's terms.
    const as = seatedAs(role);
    const edits = !["reviewer", "lead", "watcher", "supervisor"].includes(as);
    const waits = !["lead", "supervisor"].includes(as);
    const searches = SEARCHES.includes(as);
    const bare = as === "watcher";
    // A seat that writes may move its own task branch, the only one it stands on; one that does not is refused outright,
    // and one with no shell, whose no-shell is checked below, runs no git at all.
    const refusedGit = bare ? [] : can(role, "write") ? DESK_GIT : [...DESK_GIT, ...MOVES];
    const freedGit = can(role, "write") ? MOVES : [];
    const team = withHarness(base, role.role, harness);
    assert.deepEqual(
      desiredProvider(kit, team.roles[role.role]!).paseoTools,
      { enabled: false },
      `${where}: no shipped seat acts on another behind the desk or wakes on a clock through Paseo's own tools`,
    );
    const reasons = Object.values(harnessFileSources(kit, harness, role))
      .flat()
      .flatMap((source) =>
        [...readFileSync(source, "utf-8").matchAll(/justification = "([^"]*)"/g)].map((match) => match[1]!),
      );
    if (harness.files) assert.ok(reasons.length > 0, `${where} is given reasons`);
    assert.deepEqual(
      hiddenWordsIn(reasons.join("\n"), role.hidesWords ?? []),
      [],
      `${where}: the reasons for a refusal`,
    );
    assert.equal(
      stateWrites(role, project.state).includes(join(project.state, "CONTEXT.md")),
      as === "supervisor",
      `${where}: only the Supervisor writes the project's concept; every other role reads it or is told it`,
    );
    if (bare) {
      assert.equal(can(role, "write"), false, `${where}: touches no work`);
      assert.deepEqual(stateWrites(role, project.state), [], `${where}: writes nothing under the project's state`);
    }
    if (harness.modelCatalog && !executableIn(pathDirs(), harness.modelCatalog.command[0]!)) {
      t.diagnostic(`${harness.id} is not installed here, so its ${role.role} seat was not built`);
      continue;
    }
    materialize(
      kit,
      team,
      role.role,
      home,
      project,
      serversFor(kit, team, role.role, { node: "/bin/node", socket: "/desk.sock" }),
    );
    const dir = seatDir(kit, role, harness, home, project);
    const settings = readConfig<unknown>(join(dir, harness.settings.file), {});
    if (harness.id === "claude") {
      assert.equal(
        at(settings, "language"),
        undefined,
        `${where}: the Human's language is their machine's setting, which the desk tells whoever supervises on every agent`,
      );
      assert.equal(
        harness.provider.forceFlags?.["--thinking-display"],
        "summarized",
        `${where}: the watch reads a seat's thinking, which Claude run headless empties unless its launch asks for a summary; its settings' showThinkingSummaries counts only in an interactive session`,
      );
      const deny = list(at(settings, "permissions.deny"));
      for (const command of refusedGit)
        assert.ok(
          [`Bash(git ${command} *)`, `Bash(git -C * ${command} *)`].every((rule) => deny.includes(rule)),
          `${where}: only the desk does git ${command}, with -C or without`,
        );
      for (const command of freedGit)
        assert.ok(
          !deny.includes(`Bash(git ${command} *)`),
          `${where}: git ${command} on its own task branch is its own`,
        );
      assert.ok(!deny.some((rule) => WORKTREE.test(rule)), `${where}: reads its worktrees`);
      assert.ok(
        bare || ["Bash(git branch --force *)", "Bash(git -C * branch --force *)"].every((rule) => deny.includes(rule)),
        `${where}: forcing a branch is the desk's, spelled -f or --force`,
      );
      for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"])
        assert.equal(
          deny.includes(tool),
          !edits,
          `${where}: ${tool} only where the role edits files; the Supervisor and the Lead keep their pages with note`,
        );
      assert.equal(
        deny.includes("AskUserQuestion"),
        as !== "supervisor",
        `${where}: only the Supervisor asks the Human directly; any other seat's question would only be refused after it stopped its turn`,
      );
      assert.equal(
        deny.includes("Edit(./**)"),
        ["supervisor", "lead"].includes(as),
        `${where}: an Edit deny binds the sandbox too, so its shell writes nothing in the working copy, as on Codex; its pages under the state and $TMPDIR lie outside it, and a Reviewer's copy is its own, thrown away with its review`,
      );
      assert.equal(
        deny.includes("Bash(sleep *)"),
        !waits,
        `${where}: mail wakes a coordinating seat, and one asleep in its turn holds it open`,
      );
      for (const agent of agents)
        assert.ok(
          startsOf(agent).every((start) => deny.includes(`Bash(${start})`)),
          `${where}: a seat does not start ${agent} from its shell, past Paseo`,
        );
      assert.equal(
        deny.includes("WebSearch"),
        !searches,
        `${where}: a seat may look up what it judges, such as a CVE, but the Watcher, which touches nothing`,
      );
      if (bare)
        for (const tool of BUILT_INS.claude!)
          assert.ok(deny.includes(tool), `${where}: a seat that touches nothing has no ${tool}`);
      for (const path of KEPT)
        assert.equal(
          deny.includes(`Edit(${path})`),
          as !== "supervisor" || !path.endsWith("CONTEXT.md"),
          `${where}: ${path}, as the desk's own files are kept from every seat, and the Human's word from all but the Supervisor`,
        );
      for (const command of Object.keys(kit.refused))
        assert.ok(
          deny.includes(`Bash(${command} *)`),
          `${where}: its shell starts no ${command}, which the kit refuses`,
        );
    }
    if (harness.id === "codex") {
      const features = (at(settings, "features") ?? {}) as Record<string, unknown>;
      assert.deepEqual(
        [features.multi_agent, features.multi_agent_v2],
        [false, false],
        `${where}: Paseo is the only control plane`,
      );
      assert.deepEqual(
        [features.shell_tool, features.view_image, features.sleep_tool],
        bare ? [false, false, false] : [undefined, undefined, undefined],
        `${where}: a seat that touches nothing has no shell, image viewer or sleep`,
      );
      assert.equal(
        features.default_mode_request_user_input,
        as === "supervisor" ? true : undefined,
        `${where}: only the Supervisor may ask the Human with its agent's own question, in the mode a seat runs in, which the desk lets through with the Human out of the loop`,
      );
      assert.equal(at(settings, "approval_policy"), "never", `${where}: nobody is there to approve`);
      assert.equal(
        at(settings, "skills.bundled.enabled"),
        false,
        `${where}: only the role's skills, as on every other agent`,
      );
      assert.equal(at(settings, "sandbox_mode"), as === "watcher" ? "read-only" : "workspace-write", where);
      assert.equal(
        at(settings, "web_search") === "disabled",
        !searches,
        `${where}: searches the web only where the role may`,
      );
      const profile = at(settings, "default_permissions");
      if (["supervisor", "lead"].includes(as)) {
        const rules = (at(settings, `permissions.${String(profile)}.filesystem`) ?? {}) as Record<string, string>;
        assert.deepEqual(
          [rules[":root"], rules[":cwd"], rules[":workspace_roots"]],
          ["read", undefined, undefined],
          `${where}: reads the project and writes nothing in it, as on Claude`,
        );
        assert.deepEqual(
          stateWrites(role, project.state).filter((path) => rules[path] !== "write"),
          [],
          `${where}: still writes its own pages under the project's state`,
        );
      } else assert.equal(profile, undefined, `${where}: its sandbox is its mode's`);
      const catalog =
        readConfig<{ models?: Record<string, unknown>[] }>(String(at(settings, "model_catalog_json")), {}).models ?? [];
      assert.ok(
        catalog.length > 0 && catalog.every((model) => model.multi_agent_version === null),
        `${where}: no model offers native agents`,
      );
      assert.ok(
        list(at(settings, "sandbox_workspace_write.writable_roots")).every((path) => path.startsWith("/state/demo/")),
        `${where}: writes into the state only where its content says`,
      );
      const rules = readFileSync(join(dir, "rules", "seatworks.rules"), "utf-8");
      for (const command of refusedGit)
        assert.match(
          rules,
          new RegExp(`\\["git", (\\[[^\\]]*)?"${command}"`),
          `${where}: only the desk does git ${command}`,
        );
      for (const command of freedGit)
        assert.doesNotMatch(
          rules,
          new RegExp(`\\["git", (\\[[^\\]]*)?"${command}"`),
          `${where}: git ${command} is its own`,
        );
      assert.doesNotMatch(rules, /"worktree"/, `${where}: reads its worktrees`);
      assert.equal(
        /"git", "commit"/.test(rules),
        ["supervisor", "lead"].includes(as),
        `${where}: commits only where the role commits`,
      );
      assert.equal(/pattern = \["sleep"\]/.test(rules), !waits, `${where}: sleeps only where the role may`);
      const starts = [
        ...rules.matchAll(/prefix_rule\(pattern = (\[[^[\]]*\]), decision = "forbidden", justification = "([^"]*)"\)/g),
      ]
        .filter((match) => !Object.values(kit.refused).includes(match[2]!))
        .map((match) => (JSON.parse(match[1]!) as string[]).join(" "));
      assert.deepEqual(
        starts.filter((start) => !start.startsWith("git") && start !== "sleep").sort(),
        agents.flatMap((agent) => [agent, `npx ${agent}`, `bunx ${agent}`]).sort(),
        `${where}: a seat starts no agent the catalog ships from its shell, past Paseo, and its rules name no other`,
      );
    }
    if (harness.id === "omp") {
      const patterns = (at(settings, "bash.patterns") ?? []) as { approval: string; match: string }[];
      const denied = patterns.filter((rule) => rule.approval === "deny").map((rule) => rule.match);
      const refuses = (command: string) =>
        [`git ${command}`, `git ${command} *`, `git -C * ${command}`, `git -C * ${command} *`].every((rule) =>
          denied.includes(rule),
        );
      const approval = (tool: string) => at(settings, `tools.approval.${tool}`);
      for (const command of refusedGit)
        assert.ok(refuses(command), `${where}: only the desk does git ${command}, with -C or without`);
      for (const command of freedGit) assert.ok(!refuses(command), `${where}: git ${command} is its own`);
      assert.ok(!denied.some((rule) => WORKTREE.test(rule)), `${where}: reads its worktrees`);
      assert.ok(
        !denied.some((rule) => /^git (-C \* )?[a-z-]+\*$/.test(rule)),
        `${where}: no pattern takes in a longer command, as git merge* took git merge-base`,
      );
      assert.equal(
        refuses("commit"),
        ["supervisor", "lead", "reviewer"].includes(as),
        `${where}: commits only where the role may`,
      );
      assert.equal(denied.includes("sleep *"), !waits, `${where}: sleeps only where the role may`);
      for (const agent of agents)
        assert.ok(
          startsOf(agent).every((rule) => denied.includes(rule)),
          `${where}: a seat does not start ${agent} from its shell, past Paseo`,
        );
      assert.equal(
        at(settings, "ask.enabled"),
        as === "supervisor",
        `${where}: only the Supervisor asks the Human directly, which the desk lets through with the Human out of the loop`,
      );
      assert.equal(approval("task"), "deny", `${where}: Paseo is the only control plane`);
      assert.equal(
        approval("eval"),
        "deny",
        `${where}: an eval cell starts agents through agent() and workpool(), past Paseo`,
      );
      assert.deepEqual(
        [at(settings, "eval.py"), at(settings, "eval.js")],
        [false, false],
        `${where}: omp offers no eval tool with both backends off, and PI_PY or PI_JS bringing one back still meets the deny`,
      );
      assert.equal(
        approval("debug") === "deny",
        bare,
        `${where}: debugs only where it has a shell that runs the same programs`,
      );
      assert.notEqual(
        at(settings, "skills.enablePiUser"),
        false,
        `${where}: the skills linked into the seat's own directory load`,
      );
      assert.equal(
        at(settings, "tools.xdev"),
        false,
        `${where}: no tool hides behind write, which the Lead and the Reviewer are denied`,
      );
      assert.equal(
        at(settings, "ttsr.builtinRules"),
        false,
        `${where}: omp's own style rules do not overrule the project's`,
      );
      assert.deepEqual(
        [at(settings, "bash.autoBackground.enabled"), at(settings, "launch.enabled")],
        [false, false],
        `${where}: a command runs within its turn, and no service outlives it`,
      );
      const disabled = list(at(settings, "disabledProviders"));
      assert.ok(
        disabled.includes("omp-plugins"),
        `${where}: plugins installed for the owner's own omp do not load in a seat`,
      );
      const request = {
        agentId: "a",
        reason: "create" as const,
        provider: providerId(kit, role.role, "omp"),
        cwd: "/work/demo",
        env: {},
      };
      const env = seatEnv(kit, request, dir, project).env;
      assert.equal(
        env.PI_CONFIG_FILES,
        join(dir, harness.settings.file),
        `${where}: its settings overlay a repository's own .omp/config.yml, which would outrank them`,
      );
      assert.ok(
        Number(env.OMP_MCP_TIMEOUT_MS) > ANSWER_WITHIN_MS,
        `${where}: waits for a desk call longer than the desk takes to answer it, where omp gives up at 30 s`,
      );
      assert.equal(approval("web_search") === "deny", !searches, `${where}: searches the web only where the role may`);
      if (bare) for (const tool of BUILT_INS.omp!) assert.equal(approval(tool), "deny", `${where}: has no ${tool}`);
      assert.equal(
        ["edit", "write", "ast_edit"].every((tool) => approval(tool) === "deny"),
        !edits,
        `${where}: edits files only where the role may`,
      );
      assert.ok(disabled.includes("claude"), `${where}: the owner's own Claude setup does not load in a seat`);
      const servers = (at(readConfig<unknown>(join(dir, harness.mcp.file), {}), "mcpServers") ?? {}) as Record<
        string,
        unknown
      >;
      assert.equal(
        "team" in servers,
        Boolean(role.tools),
        `${where}: the desk's tools are in the file omp reads them from`,
      );
    }
    if (harness.id === "opencode") {
      const bash = (at(settings, "permission.bash") ?? {}) as Record<string, unknown>;
      const allowed = (tool: string) => at(settings, `permission.${tool}`);
      assert.equal(Object.keys(bash)[0], "*", `${where}: the allow comes first, since the last rule that matches wins`);
      for (const command of refusedGit)
        assert.ok(
          bash[`git ${command} *`] === "deny" && bash[`git -C * ${command} *`] === "deny",
          `${where}: only the desk does git ${command}, with -C or without`,
        );
      for (const command of freedGit)
        assert.notEqual(bash[`git ${command} *`], "deny", `${where}: git ${command} is its own`);
      assert.ok(!Object.keys(bash).some((rule) => WORKTREE.test(rule)), `${where}: reads its worktrees`);
      assert.equal(
        bash["git commit *"] === "deny",
        ["supervisor", "lead", "reviewer"].includes(as),
        `${where}: commits only where the role may`,
      );
      assert.equal(bash["sleep *"] === "deny", !waits, `${where}: sleeps only where the role may`);
      for (const agent of agents)
        assert.ok(
          bash["*"] === "deny" || startsOf(agent).every((start) => bash[start] === "deny"),
          `${where}: a seat does not start ${agent} from its shell, past Paseo`,
        );
      assert.deepEqual(
        [allowed("task"), allowed("question"), allowed("external_directory")],
        ["deny", as === "supervisor" ? "allow" : "deny", "allow"],
        `${where}: no subagents, only the Supervisor asks the Human directly, and nothing waiting on a person`,
      );
      const denies = (tool: string) => {
        const value = allowed(tool);
        return value === "deny" || (value as Record<string, unknown> | undefined)?.["*"] === "deny";
      };
      assert.equal(denies("edit"), !edits, `${where}: edits files only where the role may`);
      const edit = (allowed("edit") ?? {}) as Record<string, unknown>;
      for (const path of KEPT)
        assert.equal(
          edit[path] === "deny",
          as !== "supervisor" || !path.endsWith("CONTEXT.md"),
          `${where}: ${path}, as on Claude, since OpenCode's edit takes paths`,
        );
      assert.equal(allowed("websearch") === "deny", !searches, `${where}: searches the web only where the role may`);
      if (bare)
        for (const tool of [...BUILT_INS.opencode!, "bash"])
          assert.ok(tool === "bash" ? bash["*"] === "deny" : denies(tool), `${where}: has no ${tool}`);
    }
    if (harness.id === "pi") {
      assert.deepEqual(
        at(settings, "packages"),
        ["npm:pi-mcp-adapter"],
        `${where}: the desk's tools reach Pi only through the adapter`,
      );
      assert.equal(
        at(settings, "defaultProjectTrust"),
        "never",
        `${where}: the repository's own .pi does not load in a seat`,
      );
      const tools = {
        reviewer: ["read", "bash", "grep", "find", "ls"],
        lead: ["read", "bash", "grep", "find", "ls"],
        supervisor: ["read", "bash", "grep", "find", "ls"],
        watcher: [],
      }[as as "reviewer"];
      assert.deepEqual(at(settings, "defaultTools"), tools, where);
      const desk = at(readConfig<unknown>(join(dir, harness.mcp.file), {}), "mcpServers.team");
      if (!role.tools)
        assert.equal(desk, undefined, `${where}: a role given no desk tools is not connected to the desk`);
      else {
        assert.equal(
          at(desk, "lifecycle"),
          "keep-alive",
          `${where}: the adapter lists an unconnected server with no tools, so a fresh Peer could not find done`,
        );
        assert.equal(at(desk, "directTools"), true, `${where}: and its verbs are tools of their own`);
        assert.ok(
          Number(at(desk, "requestTimeoutMs")) > ANSWER_WITHIN_MS,
          `${where}: waits for a desk call longer than the desk takes to answer it, where the SDK gives up at 60 s`,
        );
      }
    }
    assert.ok(existsSync(join(dir, harness.skillsDir)), `${where}: skills`);
  }
});
