# Seatworks

This is the `webplode/seatworks` fork of `sting9k/seatworks`, the sole product and foundation
baseline for this project. The target is one overall Supervisor coordinating Leads across
independent projects and workspaces. That cross-project capability is not implemented yet.
See the [product baseline](docs/PRODUCT.md) and
[supervision research](docs/research/supervision-and-multiproject.md). The documentation
below describes the upstream implementation.

A [Paseo](https://paseo.sh) plugin that runs a team of coding agents the **SLP** way. A
**Supervisor** works with you, a **Lead** owns each line of work, and **Peers** each do one task. A
**Reviewer** reads the work with clean context, and a **Watcher** reads how it is being done.

> **Pre-release.** Nothing has shipped: no releases, no compatibility promises.

![SLP: who decides what](docs/images/slp-graph.svg)

## What it does, and what it doesn't

The plugin **runs** the team, but never decides whether the work is right. That is always a seat's
call, or yours.

| It does | It enforces | It never does |
|---|---|---|
| Configures and starts one agent per seat | Lanes may not overlap in what they write | Judge the work |
| Keeps a shared desk of lanes, tasks and questions | One writer per working copy | Pass on to a seat what the watch concluded about it |
| Carries messages, and holds them until a seat can take them | A red gate (your test command) stops a lane from landing | Write your project's concept for you |
| Keeps a durable record outside your repo | Each role's permissions, where the agent allows it | |
| Watches Leads and Peers, and tells whoever answers for them | | |

## How a piece of work goes

1. **You talk to the Supervisor.** Before new work starts, it asks you questions in numbered rounds,
   with its recommended answer to each. What you settle about how the project behaves goes into the
   project's `CONTEXT.md`, outside your repo.
2. **The Supervisor opens a lane** with an outcome and acceptance criteria. The desk seats a Lead for
   it.
3. **The Lead splits the lane into tasks.** It starts a Peer on each task, has a Reviewer read each
   big task and then the whole lane, and accepts or sends the work back.
4. **The Lead reports the lane ready.** The desk runs the gate first.
5. **The Supervisor closes the lane.** The desk merges in your base branch if it moved, runs the
   gate on the result, then fast-forwards the base.

The step-by-step picture is in [A lane, end to end](docs/ARCHITECTURE.md#a-lane).

## The team

| Role | Owns | Default agent |
|---|---|---|
| Supervisor | Your intent, across lanes: opens and closes them, answers Leads | Claude Code · `claude-opus-5` · high |
| Lead | One lane: its tasks, their order, and what is accepted | Claude Code · `claude-opus-5` · medium |
| Peer | One task, and the engineering judgement inside it | Codex · `gpt-5.6-luna` |
| Reviewer | A read-only review of one change | Codex · `gpt-5.6-luna` |
| Watcher | Reading Leads and Peers as they work. It cannot touch the work | the Peer's agent |

Roles are data in `plugin/roles.json`, not code. Each role's tools are in
[the reference](docs/REFERENCE.md#desk-verbs).

## Supported agents

Any role can sit on any of these three agents. You pick one per role in the panel, plus its model and
thinking level where the agent offers them.

| Agent | Before its first seat | Sandbox | Mail into a running turn |
|---|---|---|---|
| Claude Code | `claude setup-token` once, then `security add-generic-password -U -s "Seatworks Claude Code token" -a "$USER" -w` with that token: a seat keeps its own config directory, so your own `claude` login does not reach it | yes | yes |
| Codex | `codex login` once. The `codex` CLI must be on the machine that runs the daemon | yes | yes |
| Pi | `pi` signed in, and `pi install npm:pi-mcp-adapter` once. That adapter is how a Pi seat reaches the desk | no | yes |

Every seat reads your project's own instructions: Claude reads `CLAUDE.md`, and the others read
`AGENTS.md`. Claude Code and Codex seats are denied `git push`, `gh`, `paseo` and starting
other agents. A Pi seat is held only by the tools it is given. The shipped Claude settings answer in
Vietnamese: change `language` in `plugin/harness/claude/settings.json` for another language. The details are under
[seat directories](docs/REFERENCE.md#seat-directories) and
[known limits](docs/REFERENCE.md#known-limits).

## Install

You need:

- Paseo `>=0.8.0 <0.9.0`
- Node.js 24 or newer. There is no build step.
- `git` and `jq`
- the CLI of each agent you use, signed in
- optionally `gh`, to open a lane from an issue, and `uv`, for code search

```bash
cd plugin
npm install
paseo plugin install "$PWD"
```

Paseo remembers where the clone is. If you move it, install it again.

**Keeping it current.** The **Plugin** tab shows the version that runs and, once checked, the one
the clone's branch has. **Update** moves forward only, runs `npm install` when the packages changed,
and reloads the plugin. It waits until no seat runs in any project, because every project moves to
the new version at once. Below the version, one row for each thing that needs you:

- A changed **prompt**, **skill** or **team block**: **Use new**, or **Keep mine** to go on with the
  version you had. Yours is copied to `~/.local/share/seatworks-v2/own/` for you to edit by hand, and
  you are still told when the original changes.
- Changed **guides** and **records**: named only, for you to read in git.
- Settings this version cannot read, a stale `AGENTS.md` block, seats still on an older version.

**Clean up** lists seat folders, working copies and copies nobody uses any more, and removes only
what you pick.

## First run

1. In Paseo, open **Seatworks** in the sidebar.
2. Type what the team should work on. Pick the project with the folder chip (type to search this
   machine, arrows and Enter to choose), and the team with the team chip: **Cheap**, **Balanced**
   (your team defaults) or **Max**. Seatworks checks the setup on its own as soon as you pick.
3. Press **Start**. A new folder joins Seatworks, the Overall Supervisor starts if it is not running,
   and your words become its first objective. Its chat is home from then on.

The setup check warns before you start if the Supervisor can't sign in (with a **Reload Supervisor**
button) or if git has no name and email for the project, since Peers commit their own work.

Choosing each model yourself, observe-only access and the other settings sit under **More options**
in **Add project** and in **Team & models**.

The desk seats everyone else as the work needs them. The first lane works in your checkout, and each
later one in a working copy of its own.

**Your project's `AGENTS.md`.** The first time a seat opens, the plugin writes the team's shared
rules into your `AGENTS.md`, in a marked `seatworks` block. It replaces that block whole and never
touches your own text. `CLAUDE.md` gets a pointer to `AGENTS.md`. Commit both once, because a lane in
its own working copy sees only what is committed. The Supervisor chat offers a **Commit** card that
commits just those two files.

**What the Supervisor chat shows.** One live card lists each project's status and what needs you:
questions, permission requests, work that is **ready to land** (branch, files changed, tests passed)
and work whose tests failed. **Land…** asks you to confirm, then lets the Supervisor land that
project's work and tells it to land this one now. Landing stays your call until you press it.

The panel has four tabs: **Team** (agents and the watch), **Flow** (lanes, tasks and questions,
live), **MCP** (optional servers per role) and **Health**. Everything the desk keeps lives under
`~/.local/share/seatworks-v2/`.

## The watch

The desk reads the turns of Leads and Peers in code, catching things like a destructive command, the
same failure again and again, or a weakened test. It also reads each lane's record, for example a
task sent back three times. A second reader looks beside the code:

- **A Watcher seat**, the default. It needs no key.
- **Jev**, a model called through OpenRouter. It needs a key, and each reading costs money.

A finding becomes an **incident**. An ordinary one about a Peer goes to its Lead. One about a Lead,
an urgent one (a *page*), or one whose Lead is gone goes to the Supervisor. Whoever gets it marks it
`useful`, `noise` or `unknown`. The watched seat never hears of it.

Out of the box the watch only records and lists. To mail incidents, turn on **Mail incidents** on the
Watcher's chip in the **Team** tab. How it all works is in
[the architecture](docs/ARCHITECTURE.md#the-watch).

## Known Paseo behaviour

- **Opening an archived seat's history starts its agent again, and leaves it running.** Paseo
  resumes an archived agent to show its history, from the app or `paseo logs`, and never closes it.
  A Pi seat leaves a `pi` process. The plugin never reads an archived seat itself. To be rid of
  them: `pkill -f "pi --mode rpc"`, with no seat of yours running.
- **An agent gets only the provider keys Paseo's daemon has.** A key set in your shell, such as
  `NVIDIA_API_KEY` for Pi, does not reach the daemon, so those models are neither listed nor usable.
  Put the key where the agent keeps its own (`~/.pi/agent/auth.json` for Pi).
- **Paseo keeps a project for a folder you have deleted.** List them with `paseo project ls` and
  remove one with `paseo project delete <id>`.

## Development

```bash
cd plugin
npm run check
```

This type-checks the code and runs the tests. Don't launch seats to test a change: they are real
agents, with real permissions, and they cost money. The evals that call real models are listed in
[the reference](docs/REFERENCE.md#evals).

## Docs

| Read | When you want |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works inside, in one sitting |
| [REFERENCE.md](docs/REFERENCE.md) | To look something up: verbs, letters, facts, settings, files |
| [ANTIPATTERNS.md](docs/ANTIPATTERNS.md) | How a team of agents goes wrong, and which of those the watch can see |
| [FORK.md](docs/FORK.md) | What this fork adds over upstream, and how upstream syncs were merged |
| [AGENTS.md](AGENTS.md) | The rules this code follows |

## License

MIT, see [LICENSE](LICENSE). [NOTICE.md](NOTICE.md) lists where the shipped skills come from.
