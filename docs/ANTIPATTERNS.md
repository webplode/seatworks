# Anti-patterns of a coding-agent team

A reference for the Human, not content any seat reads. Nothing here is in a prompt, and adding
something here costs no context and no tokens.

Each entry is a rule, the words that give it away, and where this plugin stands on it today. The
examples are only on the rules that cannot be stated in one sentence.

**Where a thing can be caught** — four answers, used throughout:

| | Meaning |
|---|---|
| **caught** | A code fact or a sensor question fires on it today. |
| **askable** | A question exists with no threshold, so it collects answers and acts on none. |
| **desk** | In the ledger, across tasks, rounds or lanes, and nothing reads it for this yet. |
| **outside** | This plugin cannot see it, and saying why is the useful part. |

Of the thirty-five rules below, **ten are caught**, one more in part and one in half its cases. One
is written as a question that is not yet trusted to act on. Twelve are desk-shaped: in the ledger,
with nothing reading them for this. Ten are outside what this plugin can observe at all, and for
those the entry says why, because that is the part worth knowing.

The thirty-five come from one list. Section 8 holds one that does not, kept here because the watch
now catches it and everything the watch catches belongs in this file.

The watch reads three things. In code, from a seat's timeline: a destructive command, a seat
repeating itself, a weakened test, an unverified success claim. In code, from the lane's own record
— the ledger the patrol already holds — the shapes no window can hold, because a letter restarts the
window: a task sent back again and again, a lane patching several tasks at once, reviews piling up
with nothing accepted, a review told to report only what it is certain of, a brief that writes the
work out instead of setting an outcome, and a task taken in although its Peer never said it was
finished. And, only with a key, by putting the turn to the sensor: a missing mechanism being stood
in for, a wrapper where the thing itself should have changed, production code edited to make a check
pass, a test that only proves the old behaviour is gone, and agreement that arrived with no check
behind it.

All three go through one incident book, so the Supervisor reads, marks and calibrates them the one
way, and none of them ever reaches the seat it is about.

Two things are worth knowing before trusting any of it. A sensor question costs money on every
reading and its threshold is a guess until it has been measured against what the Supervisor marked,
which is what `calibrate` is for. And a condition read from the ledger stands still — a task sent
back three times stays sent back three times — so it is raised once and then only when the record
says something new; the book itself is that memory, so a restart does not raise it again, and a
day's budget or a watch that is off does not lose it.

Three facts explain most of the blindness, and each is a design choice rather than a defect:

- A letter arrives as a `user_message`, which clears what the watch had noted and restarts its
window (`server/runtime/watch/watches.ts`). No pattern survives a rework round — which is why the
fourth group below is read from the ledger instead, in `server/runtime/watch/history.ts`.
- The window is eighty steps from the last instruction. A lane's history is not in it and never will
be.
- Four of the fourteen sensor questions carry no threshold on purpose: they collect answers into
`assessments/` so a question can be measured before it is allowed to open an incident.

---

## 1. Architecture — patching the symptom instead of the foundation

The group signature: the count of "temporary" layers, adapters and exceptions grows faster than what
the system can actually do.

### Architecture Fog
**Rule.** A brief that needs a mechanism nobody has built must say so; a worker that discovers the
hole stops and names it, and does not invent a private stand-in.
**Signs.** "there is no X here", "I'll add a minimal", "for now I'll", "simple version of",
"placeholder until", a new file whose name ends in `-stub`, `-mock`, `-simple`.
**Here.** *caught* — `missing_mechanism` asks whether a step named a prerequisite that is missing
and later steps built a stand-in for it. Only a model can tell a missing mechanism from ordinary new
code, so it is a question rather than a fact. The desk already owns the remedy: a detour lane with
its own Lead.

### Brake Pattern
**Rule.** When several defects share one missing mechanism, build the mechanism. Fixing them one by
one is fitting a parachute, a weight and a reverse thruster to a car that has no brakes.
**Signs.** three or more sendings-back in one lane, each fix in a different file; "also fixes",
"same root cause" appearing after the third round.
**Here.** *caught* — `patched-not-fixed`, when a lane has sendings-back over two or more tasks
adding up to `attention.reworksAt` (3). The quote names each task and its count, so the Supervisor
can see whether they share a cause.

### Balloon Pattern
**Rule.** Change the thing and the callers it breaks. A wrapper around a weak foundation is a second
foundation.
**Signs.** "compat", "adapter", "shim", "legacy path", "fallback", "for backward compatibility", a
second copy of state, a mutex added to make two copies agree.
**Here.** *caught* — `wrapped_instead_of_changed`. `PEER.md` forbids it in words, and
`outside-scope` cannot check it because that fact fires on where a file is, not on what it is for.

### Architecture lock-in
**Rule.** The first design is a proposal. A worker that cannot say what would make it wrong has not
checked it.
**Signs.** absence — no push-back at all across a long lane; "as designed", "per the plan",
"following the existing pattern" as the whole reason.
**Here.** *desk* — nothing fires on an absence. What bears on it is the ask record (every push-back
a seat made) and the `changed_direction` and `admits_error` answers, which are collected on every
reading and deliberately act on nothing until they are calibrated.

### Priority myopia
**Rule.** Order by what unblocks, not by label. A P2 that is the foundation of a P0 is done first.
**Signs.** a detour lane opened late; a lane whose tasks already have sendings-back when the detour
appears; "we'll come back to", "blocked on, working around it meanwhile".
**Here.** *desk* — `Lane.detourOf` is exactly the record of "this should have come first", and it is
its lateness relative to the waiting lane's reworks that carries the signal. It spans lanes, so no
timeline can hold it.

---

## 2. Delegation — turning a capable agent into a confirmation machine

### Pre-solve delegation
**Rule.** Give the goal, the constraints and the evidence required. Do not give the answer and ask
for a yes.
**Example.** The difference is not length. "Move the session store to Redis; the acceptance is that
a restart keeps sessions alive, and you decide the client and the key shape" is a goal. "Use
ioredis, put it in `src/session/redis.ts`, key `sess:<id>`, TTL 3600 — confirm this is right" is an
answer wearing a goal's clothes, and what comes back is agreement, not engineering.
**Signs.** in a brief: "just", "simply", "confirm", "verify that", "the approach is", a file path
and a function name the worker was not asked to choose.
**Here.** *caught in part* — `brief-prewritten` catches the form that writes the work out, steps and
file names and all. The subtler form, a brief that simply states the chosen answer in prose, is
still only in the ledger with nothing reading it.

### Authority gradient
**Rule.** A worker may refuse the framing. A bounded task is not a gag.
**Signs.** "the task says to, so I will", "not in scope to question", shipping something the worker
said was wrong in the same turn.
**Here.** *askable* — `guessed_ambiguity` is asked on every reading and carries no threshold yet, so
it collects into `assessments/` and opens nothing until it has been measured.

### Sycophancy
**Rule.** Agreement that cost nothing is not a check. An answer must name what was read or run.
**Example.** A Lead asks "are you sure the rounding is right?" and the Peer changes the rounding.
The change is the tell: no new command, no new read, no new file between the question and the edit.
The Peer did not check; it deferred. This is why the Supervisor's prompt forbids a question that
carries its own answer, and why "Are you sure?" is banned outright.
**Signs.** "you're right", "good catch", "I'll change it" with no command or read between the
challenge and the change.
**Here.** *caught* — `agreed_without_checking` asks whether `instruction` doubts or corrects the
work and the first steps after it change course with no read, command, check or reproducing test
between. The doubt is the `instruction` rather than one of the `steps` because a delivered letter
restarts the turn and is what the next instruction is. It is asked only after the Human's own words:
a rework or a message from the seat above is an order, and following one is not deferring.

### Reflexive contrarianism
**Rule.** The opposite failure. A reviewer that never approves is as useless as one that always
does.
**Signs.** every verdict is "changes requested"; findings that are restatements of taste; "I would
have done this differently" as a blocking reason.
**Here.** *desk* — a Reviewer has no `watched` capability, so no reviewer timeline is ever read.
What exists is every verdict, in the handback files and on `Task.handback.outcome`.

### Scout-as-Judge
**Rule.** A cheap search finds candidates. It does not decide. Whoever decides must read the
evidence.
**Signs.** "the scan found", "flagged by", a verdict quoting a tool's output and no source.
**Here.** *desk* — a review's verdict followed by the Lead's accept with nothing between is the
record. Note the plugin's own shape is the opposite of the anti-pattern and worth keeping straight:
the regex fact is the scout, the model is the adjudicator, and the Supervisor still decides.

---

## 3. Test and proof — the evidence deforms the product

### Legacy-negation debt
**Rule.** Test the contract that holds now. A test whose purpose is to prove an old behaviour is
gone pins history and outlives its reason.
**Signs.** "should no longer", "must not still", "removed in", a test named after a bug number.
**Here.** *caught* — `proves_the_old_is_gone`, read off the diff of a test file in the window.

### Proof distorts product
**Rule.** A proof observes the system. It does not reshape it. Logging added to make a demo work, an
interface widened so a test can reach it, a check relaxed so a run goes green — all change the
product to serve the evidence.
**Signs.** "so the test can see it", "exporting for testability", "temporarily disable", a non-test
file edited in the same breath as a failing check.
**Here.** *caught* — `proof_changes_product`. `goal_drift` cannot cover it: that one is dropped
unless an `outside-scope` fact agrees, and loosening a check inside the task's own paths raises no
such fact.

### Flaky false-red
**Rule.** A red that two runs disagree about is not a defect in the code. Find the contention before
changing anything.
**Signs.** the same command passing and failing with no edit between; "retry", "flaky", "timing", a
port or a fixture path in the failure.
**Here.** *desk* — one lane-mode task holds the working copy at a time and parallel tasks get their
own, which removes most of the cause; what remains is two gates contending, recorded across the gate
logs and the gate events.

### Test/proof debt
**Rule.** A proof too expensive to run is not a proof. A test that no longer protects the current
contract is a liability that reads as an asset.
**Signs.** gate seconds climbing run over run; "only run this in CI"; a suite nobody ran before
handing back.
**Here.** *desk* — every gate run records its seconds and no code reads them back. The other half
has a skill (`test-proof-debt-audit`) and no detection.

---

## 4. Review — each round makes it worse

This whole group lives on a span the watch cannot see: a rework letter arrives as a message, which
clears what the watch noted and restarts its window.

### Review–fix–review loop
**Rule.** After the second round, stop fixing findings and ask what one mechanism produced them.
**Signs.** round three; each fix local and in a new file; the diff growing every round while the
finding count stays flat.
**Here.** *caught* — `rework-loop`, when one task passes `attention.reworksAt` (3) sendings-back.
Reported once, and again only when the count moves: the condition stands where an episode would end.

### Non-converging findings
**Rule.** Ten reports of ten symptoms are one question: what is the shared cause? Converge before
fixing.
**Signs.** several reviews on one task, each with its own vocabulary; findings fixed in the order
received.
**Here.** *caught* — `reviews-unconverged`, when `attention.reviewsAt` (3) reviews name one target
that is still neither accepted nor cut. Converging is still the Lead's job, and the `council` skill
is where the plugin says how.

### Overengineering edge case
**Rule.** Weigh a finding by impact times probability before building for it. A low-probability P3
does not earn an abstraction.
**Signs.** "to be safe", "in case", "future-proof", a new interface with one implementation, an
option nobody asked for.
**Here.** *desk* — every edit row carries `+N -M` and the goal is in the same state, so proportion
is judgable; but a question for it asks what `goal_drift` already asks, and would open a second
incident for the same edits. `Lane.appetite` — "what the outcome is worth, as a budget" — is
recorded, printed once and read by no code, and that is the number that would make this a judgement
rather than a guess.

### False-positive intolerance
**Rule.** Telling a reviewer to report only what it is certain of buys precision with recall, and
the bugs it drops are real.
**Signs.** in a review's focus line: "only if you are certain", "no speculation", "high confidence
only".
**Here.** *caught* — `certainty-only`, on the review task's own focus line. The plugin's own
`ultra-review` content pushes the other way, so this fires on a Lead overriding it.

---

## 5. Multi-agent — more of them is not more right

### Debate framing capture
**Rule.** The better-argued position is not the better position.
**Here.** *outside*, and prevented by shape: Peers and Reviewers hold only `done` and `ask`, and a
Lead's message reaches only its own lane, so two workers have no channel in which to capture a
framing from each other.

### Reviewer bias
**Rule.** Judge a verdict by the checks behind it, not by how sharply it is written.
**Signs.** a handback whose checks line says "not given", followed by a sending-back.
**Here.** *desk* — the handback records `Checks:` on every review, and the Lead's response is
counted as a rework. No reviewer timeline is ever read.

### Naive chat-room debate
**Rule.** Two models arguing freely is not a council. A council needs sealed positions, a rubric and
someone who reconciles.
**Here.** *outside*, and prevented: every message is a typed letter to one seat, routed by
capability. There is no room and no thread to be naive in.

### Context fan-out
**Rule.** Do not hand every worker the whole history. Give each one the field-shaped brief it needs.
**Signs.** a brief that pastes a transcript; a context field longer than the goal it serves.
**Here.** *desk* — no transcript is ever forked; each seat is a fresh session with a shaped brief.
The surface that remains is the brief itself: a task's `context` and a lane's outcome are printed
unclipped while other outside text is clipped.

### Sub-agent explosion
**Rule.** Every fan-out needs a reconciler named before it starts.
**Signs.** several reviews open on one task with no convergence step; a lane whose running count
climbs while nothing is accepted.
**Here.** *desk* — only `lead` and `supervise` can seat anyone, which bounds the shape; within a
lane nothing caps the count. The desk knows what is running; the reconciler is a person.

### Polling waste / lifecycle mismatch
**Rule.** Ask to be woken; do not spin. A worker that says it is done and a supervisor that waits
for idle will wait forever.
**Signs.** repeated status reads with nothing between them; a turn that ends without speaking.
**Here.** *caught, in half its cases* — a status read is deliberately not counted as speaking, so a
seat that only polls is counted silent and after two such turns is reported. But that machinery runs
only for seats that work tasks: a Lead or a Supervisor that polls is not counted at all. This is the
one rule in this document the watch acts on today, and it acts on half of it.

### Nested protocol confusion
**Rule.** One orchestrator owns lifecycle and authority. Two is neither.
**Here.** *outside* for the nested case — a second framework inside a seat's own harness has its own
lifecycle, for which this plugin has no event. The in-plugin case is prevented instead: a Supervisor
reaching past a Lead must emit the letter that tells that Lead.

---

## 6. Harness and planning — the process outweighs the problem

### Planning implement-on-paper
**Rule.** A plan states the outcome, the constraints, the risks and the checkpoints. A plan that
writes the code in Markdown has removed the worker's judgement and still not tested the design.
**Signs.** a brief with numbered implementation steps, function signatures, or file trees; "then
create", "then add a method".
**Here.** *caught* — `brief-prewritten`, on a code task whose goal and context carry a code fence,
or numbered steps together with a file and a member name. The tool description states the intent;
this is what notices when a brief ignored it.

### Vague long goal
**Rule.** A goal names something observable. If nobody can say what would show it was met, no agent
can either, and it will burn a budget producing plausible work.
**Signs.** "improve", "clean up", "make it better", "handle edge cases", a goal with no noun a test
could name.
**Here.** *desk* — a goal is fixed for the task's whole life, so a sensor question about it is a
standing condition on a path that has no way to say a standing thing once: marked, the next reading
would open it again. It belongs where the other standing conditions are read, in the ledger, and
judging "observable" is not something a regular expression can do — so it waits.

### Ceremony attention dilution
**Rule.** Every step in a checklist spends attention that the problem needed. Count what the process
asks before adding to it.
**Here.** *outside* — nothing at runtime reads how many steps a seat was told to follow. The only
automated checks over shipped content are the forbidden-word lint and the skill-trigger evaluation.

### Conflicting instruction debt
**Rule.** One rule, one home. A rule in a prompt and again in a tool description will drift, and the
agent will follow whichever it read last.
**Signs.** the same rule in two files; a skill that repeats its prompt; a doc that contradicts a
refusal message.
**Here.** *outside* at runtime, but two build-time checks exist: the forbidden-word lint on role
prompts, and the trigger evaluation that asks a real agent whether each skill opens on the briefs it
should.

### Domain overfitting
**Rule.** A harness built for one domain is a set of assumptions about that domain. Say which,
before using it on another.
**Signs.** a web-shaped gate on an embedded project; a test command that cannot run here; roles
named for a pipeline this project does not have.
**Here.** *outside* — the two places domain enters are data (the detected gate command, the paths a
project keeps to one writer) and nothing compares either to the project it is used on.

### Black-box workflow
**Rule.** If a bundle changes what an agent does, the person running it must be able to read what it
changed.
**Here.** *outside*, answered by transparency rather than detection: the status page, the event log,
every sensor reading with its state and answers, the handbacks and the gate logs are all files on
disk. The gap worth naming: the prompt a seat was created with is not among them.

### Teaching discovery
**Rule.** Do not spend a prompt teaching a model to grep. Spend it on what to decide.
**Here.** *outside* and clean — a grep across all four role prompts for search instructions returns
nothing.

### Harness-amplified overengineering
**Rule.** A model already tends to overbuild. A checklist that rewards thoroughness makes it worse.
**Signs.** test lines far above source lines; no source lines changed at all; a diff much larger
than the appetite.
**Here.** *desk* — source, test and doc line counts are measured for every accepted task and two of
them already become notes to the Lead. The number that would make it a judgement, the lane's
appetite, is printed once and read by nothing.

---

## 7. Two technical ones

### Tailwind arbitrary-class explosion
**Rule.** Arbitrary values are a missing design system. Count them; when they grow, name the tokens.
**Signs.** `w-[327px]`, `text-[13.5px]`, the same magic value in three files.
**Here.** *outside* — a whole-repository ratio, and the plugin sees one diff at a time.

### ORM N+1
**Rule.** A relation loaded in a loop is one query per row. Load it once.
**Signs.** a query inside a `for`; "it's fine for now, the list is small"; latency proportional to
row count.
**Here.** *outside* — the plugin never runs or profiles the product; its whole view of execution is
a call's exit code and the tail of a gate.

---

## 8. One the list does not have

This one is not from the thirty-five. It is what `paseo-supervision` — a separate Paseo plugin that
watches Lead–Peer communication and nothing else — is built entirely to detect, and reading it made
plain that this plugin had the same hole, and better evidence for it: a named field, not prose.

### Unfinished work accepted, then unwritten
**Rule.** When a worker says it did not finish, taking the work in is a decision, and a decision
needs to be written where the next person will look. Accepting can be the right call — the rest may
be someone else's, or not worth it. What is not right is that the acceptance and what it cost are
recorded in two different places, only one of which anyone reads again.
**Signs.** a hand-back whose first line is `Outcome: partial` or `Outcome: blocked` followed by an
`accept` with no task opened and no note; "we'll come back to it"; "good enough for now"; a lane
reported ready whose tasks each left something; an acceptance of a task that never handed back.
**Example.** A Peer ends with `Outcome: partial`, and in `leftUndone`: "the retry path has no test —
the only seam that reaches it is private". The Lead accepts, the task merges, the MERGED letter says
the line counts and the gate. The untested retry path now exists only in
`handbacks/L1-T3-1758·.md`, which nothing reads until someone runs the `retrospective` skill — if
anyone ever does.
**Here.** *caught* — `accepted-unfinished`, when a merged task's hand-back says `partial` or
`blocked`, or when it was merged having never handed back at all (`accept` refuses only a task
already merged, queued, merging or cut). An outcome word the schema does not offer reads as
finished, so a stray one is silence, not noise. `leftUndone` and `discovered` are deliberately
**not** read: what a follow-up would have to establish — that nothing afterwards carried the raised
thing forward — cannot be told from the ledger without a model reading prose, and `Task.of` is the
only record-about-record handle the ledger has. The outcome word is the part that is structured, so
the outcome word is the part that is read.

---

## What this list is for

The chain these thirty-five share: the framing is wrong or the foundation is missing → the agent is
not allowed to challenge it → it optimises for closing the task → patches, wrappers, tests and
proofs pile up locally → review patches further → the debt grows while the dashboard says done.

So the question to ask before letting an agent fix a list of findings is the one this list was
compiled around: **do these findings share one missing mechanism?**

For what the watch does detect today, and how to tune it, see [Watching Leads and
Peers](ARCHITECTURE.md#the-watch).
