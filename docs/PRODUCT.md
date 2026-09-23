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

The fork's 2.1.0 source candidate adds a durable overall Supervisor binding, native project
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

The manifest targets Paseo `>=0.9.0 <0.10.0`. Both TypeScript configurations, 436 offline tests,
and the installed Paseo 0.9 compiler pass. A read-only standalone SDK connection worked without
opening the UI. The panel was inspected with isolated fixture RPCs at desktop and narrow widths.
An independent-process outbox test covers interruption after simulated transport acceptance.
These checks do not prove actual agent creation, plugin loading in the app, or end-to-end live
coordination. Plugins remain disabled on the inspected local daemon; this candidate is not installed.

## Documentation ownership

- This file owns the Human's current direction and product objective.
- [Architecture](ARCHITECTURE.md) and [Reference](REFERENCE.md) describe upstream behavior.
- [Supervision and multi-project research](research/supervision-and-multiproject.md)
  compares source evidence and proposes implementation steps. Recommendations there
  are not implemented behavior or additional Human decisions.
- `plugin/roles.json`, `plugin/content/`, `plugin/harness/` and runtime source own the
  actual role behavior and enforcement. Repository instruction changes do not install
  or activate those runtime bytes.

Keep future current requirements here. Git owns superseded decisions; do not create
a parallel decision ledger or copy the retired Foundation documentation into this fork.
