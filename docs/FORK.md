# What this fork adds to upstream Seatworks

This fork is `webplode/seatworks`. Upstream is `sting9k/seatworks`. This file records what the fork
adds on top of upstream `v2`, how each upstream sync was folded in, and what is still open. The
[product baseline](PRODUCT.md) owns direction. Git history owns the detail; commit IDs below point
into it.

- Working branch: `codex/multi-project-supervision`, mirrored to `origin/v2`.
- Fork point: upstream `2e11099f`.
- Last upstream sync: upstream `v2` at `1975453` (2026-09-25).
- Plugin version: 2.6.0, state format 10, 602 tests.

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
  - `plan`, and a held `land`, when the project's plan or land check waits for the Human. Their
    Approve and Send back buttons go straight to `seatworks.plan.decide` and `seatworks.land.decide`;
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
- **The chat in plain words** (`shared/chat-words.ts`, `client/chat-words.tsx`). Paseo's
  timeline transformers replace, for display only, what the desk and the UI write for agents:
  - a letter (`[Delivery …]`, `ASK A1 …`, `REPORT L1 …`, `INCIDENT …` and the rest, batched or
    not) shows as a "Team update · <project>" card with one plain line each;
  - "Human objective for project prj_…" shows as "You asked the team", with only the objective;
  - a call to a team tool (`mcp__team__status`, `team.open_lane`, …) shows as one quiet line such
    as "✓ Checked on the team";
  - the original text stays one click away, and what agents receive is unchanged.
  `SUPERVISOR.md` also asks the Supervisor to write to the Human without IDs, branches, paths and
  tool names.
- **A failing model is one card.** When agents' turns fail, the brief groups them by model into
  one "An AI model isn't working" card with **Change models**, and folds the Leads' questions
  about the same error into it. A turn that ends well clears it.
- **Team & models in the Supervisor workspace** shows the models for every project ("Your team"),
  not the Supervisor home's own project settings. Team activity has a **Team & models** button, and
  a project's Team & models links to the models for all projects.
- **Detach asks first**, and says what stays. Its refusal names unfinished work in plain words.
- **Folder search** reads `a/b` from the home folder and completes a last part still being typed.
- **Plain wording.**
  - "Merge" for landing, "Save" for committing team files, and no project name repeated in its
    own work titles.
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
- **Tool values sent as text.** Claude Code sometimes sends a boolean, number or list as text
  (`onBranch: "true"`). The desk reads such text as the type the tool asks for before it checks
  the call (`server/desk/args.ts`); text that is not that type is still refused.
- **New tools reach running seats.** A seat's `team` MCP server read `tools.json` once, so a
  Supervisor started before an update never saw `amend_lane`, `replace_lead` or `onBranch`, and a
  plugin reload does not restart it. The server now watches `tools.json` and sends
  `notifications/tools/list_changed` when its tools change. Seats started before this still need
  one reload.

## Upstream syncs

### 2026-09-25: upstream `v2` at `1975453`

**What upstream brought (31 commits):**
- a plan checkpoint: a Lead sends its tasks with `plan_tasks`, and a plan can wait for approval
  (`approve_plan`, or the Human by default);
- a land check that can hold a landing for the Human, with `landAs` (squash by default, merge or ff);
- a Critic that reads a new lane against the Human's own words and hands in `findings`;
- `checkpoints.log` and the CHECK DIGEST letter;
- desk message ids, the Human's typed words (`Seats.typed()`), and mail held while a seat calls the desk;
- state formats 5 to 10. Step 10 makes lanes from before report ready again before they land.

**How the conflicts were folded in:**
- **State formats.** Upstream's 5 to 10 follow the fork's 4 unchanged. Their fixtures gained the
  fork's outbox and binding fields.
- **Letter keys.** The fork prefixes keys with the project slug, so `kindOf()` in `outbox.ts`
  strips it before a letter's kind is read.
- **New Supervisor tools.** `approve_plan` takes `project` and maps to the `open_lane` grant.
  `close()` takes the scope revalidation as an argument.
- **Project names on letters.** The plan-held, critique, land-decided and check-digest letters to
  the Supervisor now carry `[Project …]`.
- **Where the Human decides.** Upstream's letters sent the Human to the panel's Flow tab. Here they
  say "on its card in Seatworks", and the brief shows the card.
- **`SUPERVISOR.md`.** Gains a "Plans, landings and critiques" section.
- **Chat.** Every new letter and the three new tools have a plain line.
- **Tests.** Detach tests run without seats (`noSeats`). Devin-only tests were dropped.

The checks stay in shadow by default (`plan` and `land` are recorded, not held), and the Critic is
on. With the land check on, Merge on a ready card first records the Human's approval
(`seatworks.land.approve`), so the check does not hold the lane for them again. Only something new,
such as a commit after the click, holds it on its own card.

**Driven in the WebUI (2026-09-25).** A new project, tally, was added from the composer and given two
pieces of work:
- the first landed as one squashed commit on `main`, after a Reviewer asked for a fix and the Lead
  settled it;
- the second, with the plan and land checks on for tally only, seated a Critic that raised one point,
  held the plan until the Human approved it on its card, and held the landing on its card.

The run showed three gaps, now fixed:
- the fork had stopped writing role providers when the plugin starts, so the Critic's provider was
  missing;
- Merge on a ready card did not count as the approval, so the Human had to approve twice;
- the held card reused the ready card's id, so it kept the ready card's "merging" line and hid its
  buttons.

**Rollback points:**
- branch `backup/pre-upstream-merge-20260925`;
- `~/.local/share/seatworks-v2.bak-20260925`.

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

**Driven in the WebUI (2026-09-25).** On a new project, greet, whose copy sat on
`feature/greeting` with an untracked file, the Supervisor opened a lane on a new branch that took
the file along (`onBranch` with `newBranch`), planned a second lane to wait for it (`after`),
changed that waiting lane (`amend_lane`), and put a new Lead on the first after its Lead was
archived (`replace_lead`). It showed three gaps, now fixed:
- the Supervisor seat still had the tool list from before the merge (the `tools/list_changed`
  fix above);
- Claude Code sent `onBranch` as text (the typed-values fix above);
- the "Lead gone", "opened" and "half-open" letters did not name their project, so their chat
  card could not either.

**Onboarding walk (2.5.7).** Adding a project and starting its first work was walked in the WebUI
against Mobbin's import, setup-checklist and agent-step patterns (Vercel, Cursor, Intercom, Lindy,
Manus). Changes:
- a bare folder name Paseo has not seen is looked for in the home folder and the folders in it,
  and the palette says "Searching…" until the answer arrives;
- team presets say what each choice is for, recommend Balanced and keep model names behind a toggle;
- after adding, a banner says what to do next and selects the new project;
- project cards show a short path, each piece of work with its plain state, and a
  "Review & approve" button that opens the Supervisor chat and the Team activity panel;
- labels drop Lead, lane, coordination and thinking levels ("Open work chat", "Let the Supervisor
  work here", "Models for all projects", "✓ Ready to start");
- the Supervisor prompt maps its words to the screen's and forbids revision numbers, paths, hashes
  and IDs.
- a card's approval count and its rows agree: saving the team's instructions has its own row;
- a Lead that reported its work ready no longer reads as "Work has stalled" while it waits for the
  Human.
- a project whose Git has no name and email asks for them in a small form beside Start and saves
  them in that project only, instead of telling the Human to run git config.

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

- The brief reads lane reports from the tail of the live `events.log`. A report rolled into
  `events.0000000N.log` before the Human looks no longer yields a Land card.
- The card list reflows as items resolve.
- The plain chat lines are matched on the letters' current head lines. A new letter kind shows
  verbatim until `shared/chat-words.ts` learns it; `test/client/chat-words.test.ts` covers the
  kinds the desk writes today.
