# Webplode harness deltas

This file records the behaviour that `v3-webplode` carries in addition to `upstream/v3`. It is a rebase ledger, not a
second product specification: `AGENTS.md`, the code and the regression tests remain authoritative. Do not resolve a
harness or transport conflict by taking upstream wholesale until every invariant below still passes its named test.

Last reconciled on 2026-09-28 with `upstream/v3` at `6d316b06`. The local series was:

1. `f6b6f3f1` — carry the earlier local seat fixes onto current upstream.
2. `63ff713f` — keep orchestration intake bounded, durable and explicit.

Commit IDs may change after a rebase. Preserve the behaviours and their tests, not the hashes.

## Intake contract

Normal Peer → Lead and Lead → Supervisor communication is durable mail at the shared Seatworks transport boundary,
before `seats.send` can put it into a recipient's context. It is deliberately not implemented separately inside each
agent harness.

- Never send ordinary mail into a running turn. Hold it until the recipient's turn ends, or attach it to the result of a
  desk call the recipient is already waiting for.
- Several letters are one indexed message, not several steering messages.
- One intake contains at most 8 letters and 12,000 letter-text characters. The oldest oversized letter may pass alone
  so it cannot block the queue. Overflow stays in `outbox.json`, and the delivered batch says how many remain.
- A first letter may wake an idle recipient. Letters arriving after that turn starts wait for the next intake boundary;
  there is no debounce window before the first wake.
- `hold_lane` is the intentional exception: it uses an interrupt to stop unsafe work immediately. Do not route normal
  reports, hand-backs or messages through that path.

Protected by `test/runtime/mail.test.ts`, `test/runtime/outbox.test.ts`, `test/runtime/human-wrote.test.ts` and
`test/catalog/keep.test.ts`.

## Harness and transport deltas

| Invariant | Primary implementation | Regression proof |
| --- | --- | --- |
| Seatworks v3 uses its own `seatworks-v3` / `sw3` identities, state and provider names. | package, plugin, role and path manifests | release, catalog, provider and runtime suites |
| Claude seats may obtain the Human's OAuth token through the configured macOS Keychain entry without copying other owner settings. | `bin/seat-room.mjs`, `harness/claude/harness.json` | `test/catalog/seat-room.test.ts`, `test/catalog/kit.real.test.ts` |
| Claude seats do not inherit the owner's global `language`; the team setting is the only language owner. | `harness/claude/harness.json` | `test/catalog/kit.real.test.ts` |
| Pi seats inherit only `packages`, beside the required MCP adapter. Health names the Human-owned source because changing it changes seat capabilities. | `harness/pi/harness.json`, seat files, doctor | `test/catalog/kit.real.test.ts`, `test/runtime/doctor.test.ts` |
| A writing seat can write the repository's Git common directory; a non-writing seat cannot. | seat-file construction | `test/catalog/kit.real.test.ts`, `test/catalog/seats.test.ts` |
| Harness string coercion is narrow: booleans and JSON numbers only. JSON strings that contain arrays or objects remain strings and fail the tool schema. | `server/desk/calls/args.ts` | `test/runtime/record.test.ts` |
| Merge work is serialized per lane, not globally across unrelated lanes. | keyed queue and merge queue | `test/runtime/merge.test.ts`, `test/runtime/races.test.ts` |
| Team-socket messages are newline framed; a desk call has a bounded answer wait. | `mcp/team.mjs`, team socket | `test/mcp/team.test.ts`, `test/runtime/team-socket.test.ts` |
| A socket frame is capped at 1 MiB and malformed input is logged by byte count only, never by payload. | `mcp/team.mjs`, team socket | `test/mcp/team.test.ts`, `test/runtime/team-socket.test.ts` |
| Pending Watch decisions and their bounded context survive a plugin restart, fail closed if their kept file is invalid, and are forgotten when the seat is archived. | `server/desk/watch/decisions.ts` | `test/runtime/looks.test.ts` |
| Tests create commits with an isolated identity and do not depend on or change the Human's Git identity. | runtime harness and Git helpers | full test suite |

## Rebase checklist

Before moving to a newer `upstream/v3`:

1. Fetch upstream and record `git rev-list --left-right --count upstream/v3...v3-webplode` plus
   `git log --reverse --oneline upstream/v3..v3-webplode`.
2. Save the old upstream and fork heads. Rebase the local series onto the fetched `upstream/v3`; do not merge upstream
   into this branch.
3. Resolve conflicts by the invariants above. Pay special attention to `package.json`, every `harness.json`,
   `seat-room.mjs`, `mcp/team.mjs`, `calls/args.ts`, `merge-queue.ts`, `outbox.ts`, `team-socket.ts` and Watch decision
   storage.
4. Inspect upstream changes to mail, turn status, tool replies and interrupts together. A change in any one can silently
   restore mid-turn steering even when `outbox.ts` still looks correct.
5. Run `cd plugin && npm run check`. The rebase is not complete if a listed regression was deleted, weakened or changed
   merely to accept lost behaviour.
6. Compare the old and new local series with `git range-diff`, update the reconciliation line and local-series list in
   this file, then push with `--force-with-lease`.

When upstream implements one of these invariants equivalently, remove the duplicate local code but keep or relocate the
regression proof. Delete its row only when the invariant itself is intentionally retired, and explain why in that
commit's message.
