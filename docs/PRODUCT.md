# Seatworks product baseline

The Human selected `webplode/seatworks` as the sole product and foundation baseline on
2026-09-22. Upstream is `sting9k/seatworks`. Paseo remains the host runtime.
The adjacent Foundation, SLP fork and supervision repositories are not alternative
product baselines. Their old decisions, roadmaps and role contracts do not govern this fork.
Do not import their policy packages or revive their requirements by implication.

## Product objective

One Human works with one overall Supervisor across many independent projects under
`~/Projects` and across those projects' workspaces. That Supervisor must be able to:

- discover and inspect the Leads already working in the selected projects;
- supervise their work, give corrections and redirect them within the Human's mandate;
- coordinate priorities, blockers and dependencies between projects;
- start new lines of work when requested and keep responsibility with the appropriate Lead;
- preserve project-specific context and report actionable decisions to the Human without
  requiring the Human to visit every Lead's conversation.

Supervision must also work for existing Leads; parentage under the overall Supervisor
must not be a prerequisite. A folder's location alone does not establish an agent's identity,
project membership or authority. The product must distinguish viewing, correcting,
delegating and replacing an agent.

## Source candidate and runtime status

At upstream commit `2e11099f49eb788b8eb707c14a6f26ecd5987318`, Seatworks supplies
project-scoped lanes, Lead/Peer lifecycle, worktrees, durable records and mail, plus
Watcher/Jev observation. A desk caller's project comes from its session working directory;
the upstream Supervisor tools do not select another project.

The fork's 2.1.1 installation adds a durable overall Supervisor binding, native project
and workspace verification, per-project operation grants, existing Lead association,
project-qualified commands and reports, recoverable delivery receipts, and cross-project
dependencies that require the consumer's confirmation. The panel supports scope management,
explicit local folder discovery and an overview of Leads, ownership, dependencies and coverage.
External Leads retain their existing sessions and configuration; native observation and messages
work through the adapter, but creation-only desk tools are not retrofitted.

Communication assessment is optional, off by default, and shadow-only. It validates Jev Choice
answers, preserves uncertainty about chronology, recognizes repair by another Peer, and persists
a machine-wide budget of 100 communication assessments per UTC day. This budget is separate
from the existing general Watcher/Jev sensor. Semantic accuracy and live service behavior are
not qualified by offline examples; notification promotion requires a labeled evaluation.

The manifest targets Paseo `>=0.9.0 <0.10.0`. On 2026-09-23 the Human authorized
installation and live qualification. The plugin is installed from this checkout and running on
the standalone Paseo **0.9.1** daemon at `127.0.0.1:6767`, using the existing Paseo home and
WebUI. Both TypeScript configurations and 441 tests pass. The desktop client is not used. Supervisor and Lead machine defaults use the host's
available Codex GPT-6-Astra model.

The live pilot created two disposable Git repositories and two Lead sessions before creating
the overall Supervisor. Through the real WebUI, both existing Leads were associated with
explicit ownership. The Supervisor sent project-qualified corrections to both, then requested
one API-to-mobile dependency. The producer accepted and delivered its contract artifact; the
consumer read it and confirmed revision 3. Plugin reload preserved the binding, session IDs,
dependency and receipt IDs. The out-of-scope project probe returned an observe denial without data. Jev remained off.
The two pilot projects are paused after qualification, with sessions retained for inspection. This exposed and fixed first-run model registration,
Paseo request preapproval validation, integer revision validation and a non-JSON receipt field
that broke the live panel.

The missing transcript capability is resolved in 2.1.1 with `activity(project, agent, limit)`.
It reads Paseo's native timeline through the public SDK, checks the selected observe grant and
native placement before and after reading, and returns bounded entries with sequence provenance
and explicit truncation. Global native MCP injection remains off. The unrestricted native
`get_agent_activity` tool is excluded from the Supervisor preset in favor of this scoped path.
A fresh Supervisor read an undisclosed random marker from an existing Lead's actual transcript;
wrong-project, out-of-scope and excessive-limit probes were denied. The read also passed after
plugin reload. Evidence is under `~/.local/share/seatworks-e2e/20260923-transcripts/`.

This is bounded live qualification. Existing Leads without Seatworks tools, multiple worktrees per project, managed
lane creation/landing, crash recovery during an actual provider send, and Jev service quality
still need separate live coverage. The earlier fixture UI checks and simulated outbox crash test
are offline evidence only. Live evidence is retained outside the repository under
`~/.local/share/seatworks-e2e/20260923-live/`.

Since then the fork has moved to 2.5.3 on state format 4. It adds a workspace composer home with team
presets, Land/Finish, Commit and sign-in cards, keychain sign-in for Claude seats, Codex Peers that can
commit in lane copies, and no Devin CLI. It has also merged upstream `v2` up to `50c3a2f`. The
[fork record](FORK.md) lists every addition, how each upstream sync was folded in, and what is
still open.

## Documentation ownership

- This file owns the Human's current direction and product objective.
- [Architecture](ARCHITECTURE.md) and [Reference](REFERENCE.md) describe upstream behavior.
- [Fork record](FORK.md) owns what this fork adds over upstream and how upstream syncs were merged.
- [Supervision and multi-project research](research/supervision-and-multiproject.md)
  compares source evidence and proposes implementation steps. Recommendations there
  are not implemented behavior or additional Human decisions.
- `plugin/roles.json`, `plugin/content/`, `plugin/harness/` and runtime source own the
  actual role behavior and enforcement. Repository instruction changes do not install
  or activate those runtime bytes.

Keep future current requirements here. Git owns superseded decisions; do not create
a parallel decision ledger or copy the retired Foundation documentation into this fork.
