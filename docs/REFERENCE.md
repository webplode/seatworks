# Reference

Lookups, not reading. For how the parts fit together, see [ARCHITECTURE.md](ARCHITECTURE.md). Paths
are under `plugin/` unless they start with `~`.

- **Desk:** [verbs](#desk-verbs) · [records](#records) · [gate detection](#gate-detection) · [letters](#letters) · [mail](#mail) · [permission requests](#permission-requests)
- **Seats:** [hooks](#hooks-and-events) · [harness fields](#harness-fields) · [seat directories](#seat-directories) · [MCP servers](#mcp-servers)
- **Watch:** [facts](#facts) · [holds](#holds) · [Jev](#jev) · [calibrate](#calibrate)
- **Setup and files:** [settings](#settings) · [panel](#panel) · [state on disk](#state-on-disk) · [evals](#evals) · [known limits](#known-limits)

## Desk verbs

A call runs only when three things hold: the seat's provider maps to a role whose tool set (in
`mcp/tools.json`) holds the verb, the seat's bridge names that same role, and the arguments fit the
schema. A call that doesn't fit is refused, with what is wrong.

| Role | Tools |
|---|---|
| Supervisor | `open_lane` `close_lane` `set_project` `message` `answer` `status` `incidents` `ack` |
| Lead | `start_task` `start_review` `accept` `rework` `cut` `report` `message` `answer` `ask` `status` `incidents` `ack` |
| Peer, Reviewer | `done` `ask` |
| Watcher | `raise` `judge` |

| Verb | Effect |
|---|---|
| `open_lane` | Records the lane, takes a working copy and seats a Lead, with a directive that names `CONTEXT.md` once it exists. It can read a GitHub issue. It refuses a lane whose declared write set or `contracts` overlap an open lane's write set, or that reaches a path the project keeps to one writer. The project's own checkout must be clean |
| `close_lane` | Waits for queued merges. With `land`, it [lands the lane](ARCHITECTURE.md#a-lane). Then it cuts leftover tasks, archives their seats and the Lead, and puts the copy away |
| `set_project` | Sets the base branch, the gate command and its timeout (30 min by default), whether the gate runs per lane or per task, and the serial-only paths. An empty gate is an answer, and the desk never detects one over it |
| `start_task` | Seats a writing role on a task. In lane mode it shares the lane's copy. In parallel mode it gets its own slot and `task/…` branch. `skills` must be ones the role has |
| `start_review` | Seats a read-only reviewing role. It runs where the change is now: the task's copy, the lane's copy, or the task branch |
| `accept` | Lane mode: marks the task merged in place and retires the Peer. It is refused if the lane copy is off its branch or dirty. Parallel mode: queues the task for merging |
| `rework` | Sends the task back with a letter. It is refused while another task holds the lane copy |
| `cut` | Stops the task and archives its Peer. It resets the lane copy to where the task started, when nothing merged there since |
| `report` | Reports to the Supervisor. With `ready`, it runs the lane gate first |
| `ask` | A Lead asks the Supervisor. A Peer or Reviewer asks its Lead, or the Supervisor when the Lead is gone |
| `done` | Hands the task back to the Lead, with a file. On a per-task-gate project, it runs the gate first. It is refused once the task is accepted, queued or cut |
| `message` | The Supervisor messages a lane or a task, and a Lead messages a task in its own lane. A seat stopped on a question takes it as the answer |
| `answer` | Closes an open ask. The Supervisor may answer any ask, others only their own |
| `raise` | Opens an incident of a kind in `catalog/watcher/watcher.json`, on a step ref from a reading |
| `judge` | Confirms or vetoes an open code fact the Watcher judges |
| `incidents` | Lists the 50 most recent open or unmarked incidents, with each one's brief. With `closed`, it adds the 20 most recently marked. A Lead sees only its own lane's |
| `ack` | Marks an incident `useful`, `noise` or `unknown`, with an optional note, and closes it |
| `status` | Lanes, tasks, working copies and open asks. A Lead sees its own lane |

Behaviour depends on a role's capabilities (`supervise`, `lead`, `work`, `write`, `review`,
`watched`, `watch`), never its name. `raise` and `judge` are refused while the watch is by Jev.

## Records

| Record | States | Ids |
|---|---|---|
| Lane | `open`, `closed` | `L<n>` |
| Task | `running`, `done`, `rework`, `queued`, `merging`, `merged`, `failed`, `cut`, `stalled` | `<lane>-T<n>` for code, `<lane>-R<n>` for review, from one counter per lane |
| Ask | `open`, `answered` | `A<n>` |
| Incident | open until marked | `I<n>` |
| Slot | a git worktree held by a lane or task | `S<n>`, never reused once released |

A lane opened with `detourOf` serves another open lane. When it closes, that lane's Lead gets a
CLEARED letter.

## Gate detection

The first `open_lane` of a project with no gate on record looks in the project root:

| Found | Gate |
|---|---|
| `package.json` with a real `test` script | `pnpm test`, `yarn test`, `bun run test` or `npm test`, by lockfile |
| `mvnw` or `pom.xml` | `./mvnw -q test` or `mvn -q test` |
| `gradlew` | `./gradlew test` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `pyproject.toml` or `pytest.ini` | `pytest -q` |

## Letters

All of them are written in `desk/letters.ts`.

| Kind | Letters |
|---|---|
| Opening a seat | OWNER DIRECTIVE, TASK, REVIEW |
| Between seats | MESSAGE, RECONCILE, ASK, ANSWER to your ask, ANSWERED FOR YOU, STILL OPEN, UNANSWERED |
| Work moving | HANDBACK, REWORK, STOP, MERGED, MERGE FAILED, MERGE CONFLICT, REPORT, CAN LAND, CLEARED |
| The desk noticing | SILENT, FAILED, WAITING FOR PERMISSION, LANE IDLE, INCIDENT, the bare nudge |
| Answering late | ANSWER to your `<tool>` call |

CAN LAND tells whoever tried to land a lane under a seat mid-turn that the turn has ended.
RECONCILE tells a Lead what the Supervisor sent its Peer. ANSWERED FOR YOU tells a seat that someone
else answered an ask addressed to it.

## Mail

| Situation | What happens |
|---|---|
| Paseo can't look the seat up | held |
| The seat is archived | never sent. The letters age out |
| The seat has a pending permission | held |
| Running, its agent `steers`, and the turn started at least 60 s ago | **steered** into the turn |
| Running or starting | held |
| Mailed less than 10 minutes ago, with no turn end since | held |
| Otherwise | sent |

| Timing | Value |
|---|---|
| Spool drained | every 500 ms |
| `team.mjs` polls for a reply | every 250 ms, for up to 300 s |
| A call answered "arrives as mail" | after 240 s |
| Spool requests dropped | after 10 minutes |
| A duplicate letter, same key and reader | dropped while waiting, and for 30 minutes after sending |
| A letter nobody took | dropped after 7 days |

## Permission requests

| Seat | Where the request goes |
|---|---|
| Lead | A letter to the Supervisor |
| Peer or Reviewer on a task | A letter to its Lead |
| Supervisor | `attention.log` and `status.md`. You answer it in Paseo |
| Peer or Reviewer with no task | Only Paseo |

The owner answers a question by `message`, and the desk answers it in Paseo. Any other permission
only you can answer.

## Hooks and events

| Hook or event | What the plugin does |
|---|---|
| before `agent.create` | For a `sw2-` provider, builds the seat directory and shapes the launch. A seat that can't be built refuses the launch, with the reason |
| before `agent.session_open` | Seeds the project's records, writes the team block, rebuilds the seat directory if needed, and points the agent's config directory at it |
| `agent.created` | Follows the seat's timeline, if its role can be `watched` |
| `agent.turn_started` | Records the turn's start, for turn reading and steering |
| `agent.turn_ended` | Finishes deferred teardowns, reads the turn, and pumps the seat's mail |
| `agent.permission_requested` | Mails the request to the seat's owner, or logs it |
| `agent.archived` | Forgets the seat's timing, stops its watch, and closes its open incidents |

## Harness fields

`harness/<agent>/harness.json`. An unknown field fails the load.

| Field | Drives |
|---|---|
| `id`, `label` | The harness's name, and the agent half of a provider's label |
| `baseProvider` | The Paseo provider it extends: `claude`, `codex`, `pi` or `acp` |
| `configDirEnv`, `profileRoot` | The variable that points the agent at its seat directory, and where those live |
| `systemPrompt`, `promptFile` | Whether the prompt goes in the launch config or into a file |
| `contextFile` | The file in the seat directory that gets the working rules |
| `skillsDir` | Where skills are linked, each to its copy under `content/` |
| `settings` | Base settings, the per-role overlay, the paths the plugin owns in an existing file, and `inherits`: keys taken from your own config for that agent |
| `mcp` | The MCP file, how servers are delivered, transports, seed and clear rules, and `desk` fields |
| `links`, `files` | Files linked from your own setup (logins, history), and files composed per role |
| `modelCatalog` | A command whose model list is written as the agent's catalog |
| `stateWrites` | Where the seat's writable state paths go |
| `projectContextOption` | The provider option that receives the working directory |
| `steers` | Whether mail may be steered into a running turn |
| `exitPattern` | How the agent writes a failed exit, so the watch can tell failure from output |
| `checks` | Files the Health tab looks for |
| `hasThinking` | Whether the agent takes a thinking level |
| `provider` | Env, launch command, `forceFlags`, `keychainEnv` (an env var filled at launch from a macOS keychain entry the seat has no login for), and the starting mode |

Required: `id`, `label`, `baseProvider`, `configDirEnv`, `profileRoot`, `skillsDir`, `settings`,
`mcp` and `provider`.

## Seat directories

One per role, agent and project: `<profileRoot>/sw2-<role>-<agent>-<slug>`. It is rebuilt when the
settings revision changes, its settings file is gone, or a login appeared since.

| Agent | Directory | Written there | Launch |
|---|---|---|---|
| Claude Code | `~/.claude/profiles/…` | `settings.json` (deny rules, sandbox), `.claude.json` (its own MCP servers cleared), `skills/`, a `projects` link, `CLAUDE.md` for working rules | `bin/seat-room` with `--setting-sources user`, so the project's settings, hooks and skills stay out |
| Codex | `~/.codex/seats/…` | `config.toml` (`model_provider` and `model_providers` from your own `~/.codex/config.toml`; `workspace-write`, or `read-only` for Reviewer and Watcher; `approval_policy = "never"`; subagents off), `model-catalog.json`, `rules/seatworks.rules`, `skills/`, an `auth.json` link, `AGENTS.md` | Paseo's Codex provider |
| Pi | `~/.pi/seats/…` | `settings.json` (`pi-mcp-adapter`, project trust off, tool lists for Reviewer and Watcher), `mcp.json`, `skills/`, links to login, models and npm | Paseo's Pi provider |

- **Claude Code** still reads the project's `CLAUDE.md`: the working directory is passed as an
  additional directory.
- **Codex** needs the `codex` CLI to build a seat, because the build asks it for its models.

## MCP servers

| Server | Kind | What it gives |
|---|---|---|
| `team` | Always there, for a seat with a tool set | The role's desk verbs |
| `intellij-index` | Proxy over HTTP to a JetBrains IDE. Needs `.idea` | Code-index tools |
| `code-search` | Proxy over stdio (`uvx … semble`) | One `search` tool |
| `context7` | Plain HTTP, no key | Library docs. Queries leave the machine |

Catalog servers are off until a settings layer turns them on. One that names no roles goes to every
role with desk tools except the Watcher. `mcp/code.mjs` can pin calls to the seat's git root, sync
changed files, open and close the working copy in the backend, wait out indexing, rewrite errors and
replace tool descriptions.

## Facts

**From a seat's turn**, in code:

| Fact | Level | Fires when |
|---|---|---|
| `destructive` | page | A shell command matches the destructive pattern, checked per segment. Removing scratch files under the temp directory doesn't count |
| `stuck` | attend | In the last 20 steps: the same action and result 4 times, the same action failing 3 times, the same words 3 times, or two actions alternating 3 times |
| `no-recovery` | attend | Ten steps after a failed command, neither that program nor the gate has passed |
| `test-weakened` / `suppressed` | attend | An edit removes assertions from a test or adds a skip, or adds a suppression like `@ts-ignore` |
| `unverified` | attend | A Peer hands back with no gate result after writing files it never ran the gate on. Needs a gate |
| `long-turn` | attend | A turn runs past `longTurnMinutes`, or past three times this seat's median turn, whichever is longer |
| `call-failed` / `gate-failed` / `outside-scope` | note | Evidence only, never an incident alone |

**From a lane's record**, read by the patrol. Each names the lane's Lead:

| Fact | Fires when |
|---|---|
| `rework-loop` | One task was sent back `reworksAt` times |
| `patched-not-fixed` | That many sendings-back are spread over two or more tasks |
| `reviews-unconverged` | `reviewsAt` reviews of one target, none accepted or cut |
| `certainty-only` | A review's focus asks only for what the Reviewer is sure of |
| `brief-prewritten` | A code task's brief has a code fence, or steps naming a file and a member |
| `accepted-unfinished` | A task merged whose Peer handed it back `partial` or `blocked`, or never at all |

The Watcher's own kinds, each with a level, meaning and example, are in
`catalog/watcher/watcher.json`. [ANTIPATTERNS.md](ANTIPATTERNS.md) says which pattern each answers.

## Holds

An incident is sent once. Until then it may be held:

| Held | Meaning |
|---|---|
| shadow | `attention.watch` is off, the default. Nothing is sent |
| awaiting | The reader can judge this fact and hasn't yet. It waits 2 min for Jev, or `watcherJudgeMinutes` for a Watcher, then goes anyway |
| vetoed | The reader disagreed. It is kept, and sent if a later sighting goes unjudged or is confirmed |
| budget | `incidentsPerDay` attend-level incidents went out in the last 24 h |
| nobody | Nobody to tell, or the only candidate is the watched seat. The patrol retries |

A page never waits. A sighting whose exact words were already marked `noise` for that seat and kind
opens nothing. Archiving a seat closes its incidents, and they still wait to be marked.

## Jev

The sensor is `catalog/sensor/jev/`, asked through OpenRouter. It reads a watched seat 5 s after it
goes quiet, at least every 30 s while it works, and at once when a turn ends, something fails,
something irreversible is seen or a permission is asked.

| View | Fields | Read by |
|---|---|---|
| `actions` | `goal`, `context`, `instruction`, `working_copy`, `steps` (acts only) | `unsafe_action` |
| `work` | `role`, `goal`, `context`, `beside`, `instruction`, `steps` (all) | questions about the work |
| `claim` | `goal`, `claim`, `last_check`, `changed_after_check` | `unverified_success`, `claim_contradicted` |
| `instruction` | `instruction`, `steps` (the first ones) | `agreed_without_checking` |

| Tie | Questions | Effect |
|---|---|---|
| `alone` | `unsafe_action` (page), `missing_mechanism`, `proves_the_old_is_gone`, `agreed_without_checking` | Opens its own incident. At attend, it needs two readings in a row over threshold |
| `agrees` | `goal_drift`, with `outside-scope` | Opens one when that fact was noted in the same reading |
| `confirms` | `worker_stuck` (for `stuck`, `no-recovery`), `unverified_success` (for `unverified`) | Judges the open fact |
| recorded only | `injected_intent`, `guessed_ambiguity`, `admits_error`, `changed_direction`, `wrapped_instead_of_changed`, `proof_changes_product`, `claim_contradicted` | Nothing, until `calibrate` earns it a threshold |

Each view is one request, so a reading costs up to four, plus one per finding it pinpoints. 429 and
5xx responses are retried. A failure is logged as `sensor.degraded` at most once a minute.

## Calibrate

`node bin/calibrate.ts <project or its state directory>` reads `assessments/` against the marks.
For each question it reports its AUROC, peak rate, a threshold within the day's budget, and a
verdict. It calls Jev only with `--ask`.

| Flag | Effect |
|---|---|
| `--ask` | Asks the current questions again against the kept views, one call each |
| `--limit N` | Keeps the newest N assessments |
| `--per-day N` | Replaces the day's budget |
| `--model ID` | Keeps only one model version's answers |
| `--sample N` | Offers turns nothing was raised on |
| `--missed ID` / `--fine ID` | Marks a sampled turn |

## Settings

There are two layers: `~/.local/share/seatworks-v2/settings.json` for the machine, and
`projects/<slug>/settings.json` for a project. The project layer wins per value.

| Setting | Where |
|---|---|
| Each role's agent, model and thinking | panel |
| MCP servers: on or off, roles, options, pasted snippets | panel |
| `attention.watch`, the mail switch | panel (*Mail incidents*) |
| The sensor key, machine layer only | panel. Never read back |
| The Flow switch | panel |
| `attention.by`: `seat` or `jev` | panel (*Watch by*) or by hand |
| Rules per role, or for every seat | by hand |
| The Flow interval, and the other attention values | by hand |

| Attention value | Default |
|---|---|
| `tickSeconds` (machine layer only) | 30 |
| `leadIdleMinutes` | 12 |
| `askRemindMinutes` / `maxReminders` | 15 / 2 |
| `watch` / `by` | false / `seat` |
| `watcherQuietSeconds` / `watcherEveryMinutes` | 60 / 5 |
| `watcherChars` / `watcherRotateAfter` | 12000 / 40 |
| `watcherJudgeMinutes` | 10 |
| `incidentsPerDay` | 5 |
| `longTurnMinutes` | 30 |
| `reworksAt` / `reviewsAt` | 3 / 3 |
| `destructive` / `testPath` / `suppressed` / `repeatsAt` | patterns, and 3 |

A `roles.json` in `~/.local/share/seatworks-v2/` replaces the preset whole. A role names `defaults`
or `follows`, never both. A follower takes the agent, model and thinking of the role it follows until
it is given its own. Each role still needs its settings files under `harness/<agent>/settings/`.

## Panel

| Tab | What it holds |
|---|---|
| **Team** | The agent per role, its model and thinking. The Watcher's chip holds the watch: *Watch by*, the reader's agent or Jev's key, and *Mail incidents* |
| **Flow** | Supervisors, lanes, tasks and open asks, live. Then the watch: the Watcher and its open incidents, or the Jev card |
| **MCP** | Servers on or off, their roles and options, and adding one from a snippet |
| **Health** | The machine's checks and, on a project, its lanes' status |
| **Plugin** | Updates, Migrate and Clean up, for the whole machine |

Models and modes come from Paseo, which asks each agent. An ACP seat started without the plugin's
hooks answers only that listing, from the agent itself, and refuses a prompt. The plugin lists them once a load, and **Refresh**
under the Team tab asks again. A role's chosen model is written as that provider's default in
Paseo (`additionalModels`), so Paseo's own picker offers every model and starts on the role's.


The panel talks to the server only through the `seatworks.*` RPCs in `shared/rpc.ts`. Detaching a
project keeps its ledger and logs, and is refused while a lane is open or a working copy is out.

## State on disk

```
~/.paseo/config.json                      providers sw2-<role>-<agent>, agent profiles
~/.local/share/seatworks-v2/
  roles.json                              optional; replaces the shipped preset
  settings.json                           machine settings, including the sensor key
  settings.json.bak-<time>                what Migrate repaired, as it was; can hold the key
  kit.json                                which kit runs, and since when
  state.json                              the format of the files kept here
  content.json                            the shipped prompts, skills and guides you have taken in
  own/                                    your own copies, kept over the shipped ones
  models.json                             each agent's models as Paseo lists them
  outbox.json                             waiting letters, all projects
  spool/requests/  spool/replies/         seat tool calls
  content/<name>-<hash>/                  copies of the guides and skills seats read; safe to delete
  guides -> content/guides-<hash>
  worktrees/<slug>/S<n>/                  isolated working copies
  projects/<slug>/                        slug = repo folder name + 6 hex chars of sha1(root)
    meta.json  settings.json  project.json
    ledger.json  incidents.json
    assessments/                          what Jev was shown and said
    events.log  attention.log  status.md
    handbacks/  gates/  notebook.md  CONTEXT.md
    backup-state-<from>-<time>/           the files as they were before their format was upgraded
<profileRoot>/sw2-<role>-<agent>-<slug>/  one seat directory per role, agent and project
```

`events.log` is the provenance record: one JSON line per tool call and per lane, task, merge, gate
and slot event. The watch writes these kinds there:

| Group | Kinds |
|---|---|
| Watch | `watch.fact`, `watch.finding`, `watch.raised`, `watch.sensor`, `watch.unbriefed`, `watch.offline` |
| Watcher | `watcher.seated`, `watcher.rotated` |
| Sensor | `sensor.degraded`, `sensor.unkept` |
| Incidents | `incident.open`, `incident.judged`, `incident.held`, `incident.told`, `incident.read`, `incident.ack`, `incident.lookup-failed`, `incident.post-failed` |

`call.malformed` is logged when a seat's own harness rejected a tool call before it reached the desk.

## Evals

`npm run check` needs no key and launches no seat. These three call real models, so they sit outside
it:

| Command | What it measures |
|---|---|
| `npm run eval:triggers -- --agent "claude -p"` | Whether a real agent opens each skill on the briefs it should |
| `npm run eval:sensor` | Whether each question in `test/sensor/cases.json` reads its turns the right way |
| `node bin/calibrate.ts <project>` | A question's threshold against a real project's marks. It calls Jev only with `--ask` |

## Known limits

- **Pi has no sandbox** and no command rules either, so a Pi seat is held only by its tools.
- **Reading an archived Pi seat's history leaves a `pi` running.** Paseo resumes the
  agent to serve it and never closes it; `paseo logs` or the app's history view does this. The watch
  stops rather than read a seat once it is archived.
- **A Codex seat can call only the tools the kit can name.** Codex refuses any MCP call not
  approved ahead, so the desk's tools and proxied servers are approved at launch; a server you add
  whose tools the kit doesn't know stays out of reach on Codex.
- **Codex command rules match argument prefixes**, so `git -C <path> push` is not caught.
- **A steer Paseo can't hand over replaces the turn.** A Claude seat that is compacting refuses a
  steer the same way.
- **A turn running before a daemon restart** is never steered, and is read as having started
  30 minutes ago.
- **A project-layer save** doesn't rewrite the Paseo providers.
- **The watch can't see a sub-agent's work.** It isn't on the seat's timeline.
- **Nothing checks the sensor.** Health doesn't look at the key or the endpoint. `events.log` is
  where a failing sensor shows up.
