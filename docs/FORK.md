# What this fork adds to upstream Seatworks

This fork is `webplode/seatworks`. Upstream is `sting9k/seatworks`. This file records what the fork
adds on top of upstream `v2`, how each upstream sync was folded in, and what is still open. The
[product baseline](PRODUCT.md) owns direction. Git history owns the detail; commit IDs below point
into it.

- Working branch: `codex/multi-project-supervision`, mirrored to `origin/v2`.
- Fork point: upstream `2e11099f`.
- Last upstream sync: upstream `v2` at `50c3a2f` (2026-09-23), merged in `4cb5d1f`.
- Plugin version: 2.5.4, state format 4, 518 tests.

## Areas the fork adds

### One overall Supervisor across projects

Commits `d5381b0`, `d733a6b`, `377d21c` and `0888a43`.

- **A durable binding.** One Supervisor agent is bound in `supervision.json` to a list of
  projects. Each project has its own operation grants: `observe`, `message`, `answer`,
  `open_lane`, `set_project`, `close_lane`, `land`, `ack` and `coordinate`. Upstream binds a
  Supervisor to the one project its working directory is in.
- **Project-qualified desk calls.** Every Supervisor tool takes the exact Paseo `project` ID.
  - `desk.ts` checks the ID against the binding and the native inventory, then sets
    `caller.revalidate`.
  - Every write re-checks that the scope revision has not moved.
  - Tools without a grant of their own map to one: `status` and `incidents` to `observe`,
    `amend_lane` and `replace_lead` to `open_lane`.
- **Existing Leads.** A Lead Seatworks did not start can be associated with explicit ownership and
  supervised by message. Creation-only desk tools are not retrofitted onto it.
- **Delivery receipts.** Messages carry an intervention ID and a state: `queued`, `delivered`,
  `unknown` or `acknowledged`. State format 2 added `state` to the outbox.
- **Cross-project dependencies.** `coordinate` records producer and consumer. Only the consumer
  confirms that it can proceed.
- **Scoped transcripts.** `activity(project, agent, limit)` reads Paseo's native timeline inside
  the observe grant, with a limit of 50 and explicit truncation.
- **Supervisor home.** The Supervisor runs in `~/.local/share/seatworks-v2/supervisor-home`, keeps
  one notebook across its projects (`2d69d89`), and reads each project's records under `projects/`.
- **Detach removes the grants.** Detaching a project also takes it out of `supervision.json`, so
  the Supervisor loses its grants there (`0888a43`).

### Workspace UI on Paseo 0.9.1 (WebUI only)

Commits `75fb7cd`, `5da8e43`, `b3fab38` and `26f0a3c`.

- **Workspace menu.** Holds **New work**, **Team & models** and the overall Supervisor. State
  format 3 added launch-profile visibility (`settings.profiles.disabled`).
- **Composer home: "What should the team work on?"**
  - A project picker that remembers the last project.
  - Team presets: Cheap, Balanced and Max.
  - Start is blocked while the Supervisor cannot sign in.
- **Adding a project.** A folder palette like Paseo's own Add project: fuzzy search as you type,
  arrow keys and Enter (`seatworks.paths.find`).
- **Team status card (the brief) in the Supervisor chat.** One card per thing the Human decides:
  - `permission`, `question`, `review` and `error`;
  - `land`, from a Lead's ready report, with the diff stat;
  - `tests`, when the gate is red;
  - `commit`, for uncommitted `AGENTS.md` and `CLAUDE.md` team blocks;
  - a sign-in `reload`, ranked first.
- **Per-project work streams.** Each project shows one line per lane with how far it got. A lane
  that waits shows what it starts after.
- **Plain words on every card.** Each card leads with one sentence that says what the Human
  approves and what happens next. The agent's own report sits behind **Details**.
- **Approve all.** One button for every card that a plain yes settles: ready work whose tests did not
  fail, and team files to commit. It lists each approval before it runs, commits first, then sends
  the Supervisor one message to land the lanes one at a time. Questions, permissions and red tests
  still need the Human's own answer.
- **The Land click is the approval.** It grants `land` and `close_lane` for that project, then asks
  the Supervisor to run `close_lane` with `land: true`.
  - A lane that carried on the Human's own branch (`onBranch`) is offered as **Finish** instead:
    it runs the gate and merges nothing.
- **Commit team files.** Commits only the team files. It checks the git identity first and puts the
  index back if git refuses.
- **Plain wording.**
  - Correct plurals.
  - RPC errors without the `requestType=… code=…` tail.
  - An update refusal that names the running agents.

### Harnesses and sign-in

Commits `aaaf452`, `2191953` and `26f0a3c`.

- **Keychain sign-in.** A Claude seat's own config directory has no login. `seat-room` exports
  `CLAUDE_CODE_OAUTH_TOKEN` from the macOS keychain item "Seatworks Claude Code token"
  (`harness.json` `provider.keychainEnv`). The token never goes into settings or chat.
- **Sign-in failures.** When the Supervisor answers "Not logged in", the brief shows a Reload card
  (`seatworks.supervision.reload`, which is Paseo's `refreshAgent`).
- **Devin CLI removed.** The kit ships Claude Code, Codex and Pi. Peer, Reviewer and the Peer's
  Watcher default to Codex `gpt-5.6-luna`.
- **Codex Peers can commit in lane copies.** Seats that `work` or `write` get the repository's git
  common directory in `sandbox_workspace_write.writable_roots`, because `.git/worktrees/<slot>/`
  lives there.
- **Pi seats load the owner's Pi packages.** Providers such as `antigravity` and `cursor` come from
  Pi packages. A seat's `settings.json` now takes `packages` from `~/.pi/agent/settings.json` beside
  `pi-mcp-adapter`; without them a Peer on `antigravity/gemini-3.8-flash` failed with "Model not
  found".
- **Git identity check.** The doctor reports a missing git identity. Commits made by agents need
  `user.name` and `user.email` even when SSH and `gh` are set up.

## Upstream syncs

### 2026-09-24: upstream `v2` at `50c3a2f`, merged in `4cb5d1f`

**What upstream brought:**
- plugin relink when the daemon drops the link;
- rolled and packed logs, and a per-lane archive;
- lanes that carry on the Human's branch (`onBranch`, `newBranch`);
- lanes and tasks that wait (`after`);
- `amend_lane` and `amend_task`;
- `replace_lead`;
- the flow view kept to plain JSON.

**How the conflicts were folded in:**

- **State formats.** Both sides had used formats 2 and 3 for different changes.
  - The fork keeps its own 2 (outbox `state`) and 3 (profile visibility), because live machines
    were already at 3.
  - Upstream's 2 to 4 only add optional ledger fields, so they became one step, 4, that carries
    nothing.
  - `test/fixtures/state/v4` holds both sides' fields.
  - The upstream fixtures `v2` and `v3` were dropped, and their assertions moved to `v4`.
- **Opening a lane.** Upstream moved it into `desk/opening.ts` (`startLead`), which already gave
  the copy back on failure. `Seating.revalidate` carries the scope check to before the copy is
  taken and before the Lead is seated.
- **New Supervisor tools.** `amend_lane` and `replace_lead` gained the `project` argument and the
  `open_lane` grant mapping.
- **`SUPERVISOR.md`.** Keeps the fork's multi-project prompt and gains a "Where a lane works"
  section with upstream's rules for isolate/after, onBranch, amendments and replacing a Lead.
- **Tests.**
  - The fake Paseo moved to `test/runtime/harness.ts` upstream. The fork's workspace, inventory
    and binding fakes went with it.
  - One upstream test expects a lane to be recorded before Paseo fails. Here the scope check reads
    Paseo's workspaces first, so nothing is recorded.
- **After the merge.** The brief learned `onBranch` lanes (Finish, no diff against itself) and
  waiting lanes in the work streams.

**Live check.** A plugin reload carried the live state from 3 to 4, with the backup
`backup-state-3-…`, and kept the bound Supervisor.

**Rollback points:**
- branch `backup/pre-upstream-merge-20260924`;
- `~/.local/share/seatworks-v2.bak-20260924`.

## Syncing upstream next time

1. Fetch. Compare with `git rev-list --count HEAD..upstream/v2`, and trial the merge with
   `git merge-tree --write-tree HEAD upstream/v2`.
2. Merge, don't rebase: the fork carries a wide multi-project layer.
3. Watch these places:
   - `STATE_VERSION` and `STEPS`: never reuse a number live machines already passed.
   - `shapes.json`: record the new format's hash; never change an old one.
   - Supervisor tool schemas in `mcp/tools.json`: every Supervisor tool needs `project`.
   - The operation map in `desk.ts`: any new Supervisor tool needs a grant.
   - `SUPERVISOR.md`.
   - Test fakes.
4. Check what the brief (`server/runtime/brief.ts`) and cards (`client/brief.tsx`) assume about
   lane and task states.
5. Run `npm run check`, then `paseo plugin reload seatworks-v2`, then check the state version and
   the WebUI.

## Open items

- Upstream's newer flows are covered by tests but have not been driven end to end in the WebUI:
  onBranch and newBranch lanes, waiting lanes, amendments and Lead replacement.
- The brief reads lane reports from the tail of the live `events.log`. A report rolled into
  `events.0000000N.log` before the Human looks no longer yields a Land card.
- Paseo core shows raw `mcp__team__*` tool names. Incident letters appear verbatim in the
  Supervisor chat. The card list reflows as items resolve.
