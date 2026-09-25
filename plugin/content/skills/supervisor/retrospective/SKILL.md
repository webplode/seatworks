---
name: retrospective
description: "Turns a period of recorded events, attention lines, handbacks and git history into notebook rows and at most one proposed change, by classifying each costly episode as a specification, coordination, or verification failure and counting which pattern has been seen twice. Use when the Human asks how a run went, or after an episode that cost a rework round; not after a single surprise."
---

# Retrospective

The rule that matters most: one change per retrospective, with two dated episodes behind it.

You turn what the projects' state already recorded into updated notebook rows and at most one change worth making. Multi-agent work mostly fails by its organization rather than by model capability, so the class of each failure says where its fix belongs, and "use a stronger model" is proposed only once you can name the instruction the weaker one dropped.

| Class | It looks like | The fix lives in |
|---|---|---|
| Specification | work nobody asked for, an invented contract, a different problem solved | the directive's fields, the brief's fields, the prompt that let work start without them |
| Coordination | two writers on one path, a question that died, a result at the wrong agent, mail ignored | the tool fields (`start_task`, `done`, `ask`), what mail each role gets, what each layer sees |
| Verification | a proof that passed without the behavior, a summary taken as evidence, a finding after a merge | acceptance wording, when a Lead starts a review, the project gate |

## Procedure

1. **Collect evidence, not memory.** Each project keeps its record in its own folder under `projects/` in the Seatworks state root, the folder that holds your home; the folder is the repository's folder name and six hex characters. Read the period's lines in its `events.log`, `attention.log` and `checkpoints.log` (what each check held and how it was decided), the handback files under its `handbacks/`, and `git log` on the lane branches, and quote each line you use with its time. A period older than the live file sits in the rolled copies beside it (`events.00000001.log`, older ones gzipped: `zcat`), and a lane that has left the ledger is one gzipped JSON file holding its entries, hand-backs and last gate runs (`archive/L12.json.gz`): list its `records` keys first and read only the one you need, since a gate log in it runs to a megabyte; a retrospective from memory reproduces what you already believed.
2. **Write one episode per costly event:** what happened, its cost in something countable (a rework round, a cut task, a finding after a merge, a question the Human answered twice), and its class. An event with no cost stays in the log.
3. **Count.** Group episodes by class and mechanism, with a count and the dates behind it. "Seen twice" is a count, not an impression.
4. **Match the notebook.** A group matching a row raises its Seen and Last; a recurrence under an `applied` row means the fix was too weak, a stronger finding than a new row. An unmatched group becomes a row at `seen` when its mechanism is new, or when it shows an existing row more sharply than that row does; the same thing in different words adds nothing. Seen again on a different day, the row moves to `adopted`.
5. **Propose at most one change:** the group with the highest count and clearest class, as the smallest diff to one file (a prompt line, a skill step, an acceptance habit, a role setting), with its two dated episodes, its class, and what would show it made things worse. One change per retrospective keeps its effect attributable. Removing a rule whose episodes stopped counts as a change.

Judge the system, not the agent: "the brief's owned paths were one directory and the work needed two" is a finding, "the Peer was careless" is not. Keep what a log says apart from what you infer from it.

## Ends in

Updated notebook rows, and the proposal as a diff for the Human in your reply, with its row naming the file under Fix lives in and what would show it worked under Check.
