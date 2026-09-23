# AGENTS.md

A Paseo plugin that serves the **SLP** working concept (Supervisor / Lead / Peer, plus a Reviewer
and a Watcher). This file holds only what the code does not tell you.

- **Nothing here has shipped.** No consumers, no versions, nothing to stay compatible with.
- **Product baseline:** [docs/PRODUCT.md](docs/PRODUCT.md) owns the Human's current direction:
  Seatworks is the sole product and foundation baseline, with one overall Supervisor across
  multiple projects. Old adjacent Foundation/SLP decisions and the upstream author's external
  rebuild tracker are not dependencies or authority for this fork.

## The governing rule

> The plugin **serves** SLP so it works better with Paseo. It must **never constrain** how SLP works.

- Test every change: does it remove a constraint on SLP, or add one? Adding one needs a recorded
  reason. When a constraint goes, remove it; don't add a switch to turn it off.
- SLP is a federated governance graph, not a tree: `Supervisor > Lead > Peer` is not a chain of
  command. Authority runs on different axes.

## What the plugin may decide

Only **session lifecycle, transport, routing, notification, durable state and provenance**.

| Authority | Owner |
|---|---|
| Intent, priorities, external commitments | the Human |
| Intent interpretation, cross-boundary observation and intervention | a Supervisor |
| Topology, sequencing, ownership, integration and **acceptance** | the Lead |
| Engineering judgment within scope | the Peer |

- The plugin never decides acceptance. A gate or test result is evidence the Lead weighs, never a
  veto. Writing a refusal? Check it against this table first.
- The one constraint the concept asks for: a Supervisor may reach a Peer directly, but the desk
  always tells the Lead. No hidden command chains.

## Commands

```bash
cd plugin && npm run check    # typecheck (both tsconfigs) + tests; before every commit
paseo plugin reload seatworks-v2   # after a client change, to see it in the panel
```

No build step; tests are `node --test` over `test/**/*.test.ts`.

## Conventions that differ from the defaults

- **One live contract, hard cut.** No dual path, version branch, shim, facade, old-shape adapter,
  legacy parser, read-time upgrade or fallback. Fail closed. Change every producer and consumer
  together, and audit tests rather than syncing them.
- **Kept files change only by a step.** A change to the format of a file the plugin keeps and cannot
  rebuild (ledger, incidents, project, meta, settings, outbox, content.json) raises `STATE_VERSION` in
  `server/core/state.ts`, adds a step in `server/upkeep/state.ts` that carries the files from the
  format before, and adds `test/fixtures/state/v<N>`. Old fixtures are never edited. Logs are only
  appended to and never migrated. A change to `content/` raises the version in `package.json`.
- **Tests protect a settled contract.** Unit tests only for money, state changes, permissions,
  migrations or concurrency; everything else gets one focused check at the level a user sees it.
- **A test that invents an API before its contract exists is a defect:** the next agent will bend
  the code to it. See `plugin/content/skills/peer/test-first/references/test-antipatterns.md`.
- **Fail first.** For every fix, put the old behaviour back and watch the new test fail. Green suites
  here have agreed with bugs before.
- **No dormant machinery:** no framework, abstraction or setting without a real consumer today.
- **No docs or decision records unless asked.** Git history is the record.
- **Comments are few and short.** At most one docstring per function, method, class or type, one or
  two lines, saying what the name and code don't: why, a hidden constraint, a platform quirk. None on
  a field, member, constant or single line, and none that restates the code. Inside a body, a `//`
  only where the reason is invisible in the code, one line.
- **Commit subjects:** one imperative sentence on what changed in behaviour, sentence case, no
  prefix, often two clauses. E.g. "Let the work decide how many agents run, not a quota". Never
  `fix:`/`feat:` or a file name.

## Paseo 0.8 facts that are easy to get wrong

- A plugin gives an agent tools via `mcpServers` in `before('agent.create')`, and cannot change them
  later. Afterwards only `modelId`, `modeId`, `thinkingOptionId`, `featureValues` are mutable.
- `toolPolicy` is `{preapproved}` only (suppresses prompts). `mcpServers` adds tools;
  `providers.<id>.paseoTools.disabledTools` removes built-ins.
- `before('agent.create')` can't see `labels` (payload is `.pick({config, env}).strict()`): a seat's
  role lives in its provider string. Pass `labels` to `paseo.agents.create()` instead. Labels are an
  open, server-side queryable `Record<string,string>`.
- `systemPrompt` is creation-only: a prompt change reaches a seat on its next creation.
- The timeline can be read live mid-turn (`agents.ref(id).timeline.subscribe()`), prose and
  reasoning included. `timeline.append` writes a durable item into an agent's own timeline.
- SDK settings are host-scoped only (runtime throw), hence the plugin's own revision-checked store.
- Only `before` hooks (`agent.create`, `agent.session_open`, `workspace.create`) can refuse, by
  throwing. All hooks time out at 30 s, and on those three a timeout cancels the user's action: no
  unbounded I/O there.
- Paseo already ships `worktree.setup`/`teardown`, `create_heartbeat`, a PTY API and a
  `paseo.parent-agent-id` label. Look for a native facility before building one.

## SLP is the preset, not the plugin

- **Roles are data** in `roles.json`: `can` (capabilities: supervise, lead, work, write, review,
  watched, watch), `tools` (a set in `mcp/tools.json`), prompt, skills, defaults, `follows`. Nothing
  in `server/` compares a role to a name; capabilities decide routing, acceptance and watching.
- **A roles file in the state root replaces the shipped one**, and may point at its own prompts and
  skills, so another arrangement needs no fork. Going your own way inherits the machinery, not the
  wording.
- **The test that keeps this true:** if SLP were dropped tomorrow, would the plugin survive? If a
  change makes the answer no, it is the wrong change.

## Where things live that you would not guess

- `plugin/content/**` is runtime content, not docs: prompts, skills, guides, and
  `content/project/AGENTS.md`, the team block written into every served project's `AGENTS.md`. An
  edit there changes agent behaviour. Keep prompts short and complete: one line per rule, an example
  only where a rule is subtle.
- `roles.json` `hidesWords` is a lint that throws: a Peer's prompt may not say "seat", and the team
  block may not say any role's hidden word.
- `plugin/harness/<agent>/settings/<role>.*` holds each role's sandbox and approval policy.
- `plugin/mcp/code.mjs` is the shape to copy: no role names or workflow words, configured by data.
- `~/.paseo/daemon.log` is the live daemon log; the dated files beside it are dead.
- `NOTICE.md` is a license obligation. Never delete it.
