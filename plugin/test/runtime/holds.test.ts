import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { settle } from "./fake-timeline.ts";
import { harness } from "./harness.ts";
import { tempDir } from "../tempdir.ts";

type Harness = ReturnType<typeof harness>;

const scope = { acceptance: ["a"], outOfScope: ["the rest"] };
const planned = (key: string, title: string, extra: Record<string, unknown>) => ({
  key,
  title,
  goal: "g",
  ...scope,
  ...extra,
});

/** A lane with a write set, its Lead, and nothing started; `settings` are the project's own. */
async function laneWriting(writeSet: string[], settings?: Record<string, unknown>) {
  const h = harness();
  if (settings) {
    mkdirSync(h.project.state, { recursive: true });
    writeFileSync(join(h.project.state, "settings.json"), JSON.stringify(settings));
  }
  const sup = h.add("sw3-supervisor-claude/claude-opus-5", h.root, "sup");
  await h.call(sup, "supervisor", "open_lane", { title: "Cart", outcome: "a cart", ...scope, writeSet });
  return { h, sup, lead: h.ledger().lanes.L1!.lead! };
}

/** The notes in what `seat` was sent, from the last letter that says `from` on. */
function notes(h: Harness, seat: string, from = "") {
  const mail = h.agents.get(seat)!.sent.join("\n");
  return mail
    .slice(from ? mail.lastIndexOf(from) : 0)
    .split("\n")
    .filter((line) => line.startsWith("Note:"));
}

/** Commits `files` in the task's copy and hands it back. */
async function handBack(h: Harness, id: string, files: string[]) {
  const task = h.ledger().tasks[id]!;
  for (const file of files) {
    mkdirSync(dirname(join(task.worktree!, file)), { recursive: true });
    h.commit(task.worktree!, file, `${file}\n`);
  }
  await h.call(task.peer!, "peer", "done", { outcome: "complete", summary: files.join(", ") });
  h.agents.get(task.peer!)!.status = "idle";
}

test("a task beside others holds its paths: refused when it cannot hold them, briefed on what it holds, and its neighbour told when it starts", async () => {
  const { h, lead } = await laneWriting(["src/**", "test/**"]);
  const add = (...tasks: unknown[]) => h.call(lead, "lead", "add_tasks", { tasks });
  const brief = (id: string) => h.agents.get(h.ledger().tasks[id]!.peer!)!.prompt ?? "";
  const beside = add(
    planned("a", "A", { holds: ["src/app.ts"], parallel: true }),
    planned("b", "B", { parallel: true }),
  );
  assert.match(
    (await beside).text,
    /B runs beside others but holds nothing: name the paths it writes meanwhile, as narrow as you know them, or the folder where you do not/,
  );
  assert.deepEqual(h.ledger().tasks, {});

  await add(planned("t", "Totals", { hints: ["src/cart.ts"] }));
  const peer = h.ledger().tasks["L1-T1"]!.peer!;
  assert.match(
    brief("L1-T1"),
    /\n\nWhere to start reading \(a start, not a fence\):\n- src\/cart\.ts\n\nWhere the change goes, callers and tests included, is yours to find; the lane's write set is src\/\*\*, test\/\*\*, and a change outside it is noted for your Lead\.\n\nOut of scope:/,
  );
  await add(planned("r", "Receipt", { holds: ["src/receipt/"], parallel: true }));
  const receipt = h.ledger().tasks["L1-T2"]!;
  assert.match(
    brief("L1-T2"),
    /\n\nYou hold \(others write beside you, so ask before writing outside it\):\n- src\/receipt\/\n\nOut of scope:/,
  );
  assert.doesNotMatch(brief("L1-T2"), /Where to start reading/);
  assert.equal(receipt.slot, "S0");
  assert.equal(h.agents.get(receipt.peer!)!.cwd, h.ledger().slots.S0!.path);
  const told =
    /BESIDE L1-T2 \(Receipt\) now runs beside you in a copy of its own and holds src\/receipt\/\.\n\nNext: Leave that to it, and ask your Lead if your goal needs it\./;
  assert.match(h.heard(peer).join("\n"), told);
  assert.doesNotMatch(h.heard(receipt.peer!).join("\n"), /BESIDE/);
  await h.idle(peer);
  assert.match(h.agents.get(peer)!.sent.join("\n"), /BESIDE L1-T2/);

  await handBack(h, "L1-T2", ["src/receipt/total.ts"]);
  await h.call(lead, "lead", "accept", { task: "L1-T2" });
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks["L1-T2"]!.status, "merged");
  assert.equal(h.git(h.root, "show", `${h.ledger().lanes.L1!.branch}:src/receipt/total.ts`), "src/receipt/total.ts\n");
  assert.deepEqual(Object.keys(h.ledger().slots), ["S0"]);

  await h.call(peer, "peer", "done", { outcome: "complete", summary: "totals" });
  await add(planned("o", "Totals by day", { holds: ["src/totals/"], parallel: true }));
  await h.idle(peer);
  assert.doesNotMatch(h.agents.get(peer)!.sent.join("\n"), /BESIDE L1-T3/);
  assert.match(
    h.heard(peer).join("\n"),
    /BESIDE L1-T3 \(Totals by day\) now runs beside you in a copy of its own and holds src\/totals\/\./,
  );
});

test("a Peer writing past where it was pointed is noted, not stopped: at hand-back, at merge and by the watch", async () => {
  const { h, sup, lead } = await laneWriting(["a.txt", "c.txt", "package-lock.json", "src/**"]);
  await h.call(lead, "lead", "add_tasks", {
    tasks: [
      planned("t", "T", { hints: ["a.txt"] }),
      planned("s", "S", { holds: ["c.txt", "**/*.md"], parallel: true }),
    ],
  });
  await h.tick();
  const [own, side] = ["L1-T1", "L1-T2"].map((id) => h.ledger().tasks[id]!);
  const edit = (task: typeof own, file: string, call: string) => {
    const timeline = h.timelineOf(task!.peer!);
    timeline.beat("turn_started", `${call}-turn`);
    const detail = { type: "edit", filePath: join(task!.worktree!, file), oldString: "", newString: "x\n" };
    timeline.add({ type: "tool_call", callId: call, name: "Edit", status: "completed", detail }, `${call}-turn`);
  };
  edit(own, "src/caller.ts", "w1");
  edit(own, "d.txt", "w2");
  edit(side, "a.txt", "w3");
  await settle();
  const facts = h.events("watch.fact").filter((event) => event.fact === "outside-scope");
  assert.deepEqual(
    facts.map((event) => `${event.agent === own!.peer ? "own" : "side"} ${event.quote.split("/").at(-1)}`).sort(),
    ["own d.txt", "side a.txt"],
  );

  await handBack(h, "L1-T1", ["a.txt", "src/caller.ts"]);
  await h.idle(lead);
  assert.match(h.agents.get(lead)!.sent.join("\n"), /Discovered: nothing\nChanged: a\.txt, src\/caller\.ts\n/);
  assert.deepEqual(notes(h, lead), []);
  await h.call(lead, "lead", "rework", { task: "L1-T1", text: "take in the notes too" });
  await handBack(h, "L1-T1", ["d.txt", "notes.md"]);
  await h.idle(lead);
  assert.deepEqual(notes(h, lead, "d.txt, notes.md"), [
    "Note: in what L1-T2 holds (c.txt, **/*.md): notes.md.",
    "Note: outside the lane's write set (a.txt, c.txt, package-lock.json, src/**): d.txt.",
  ]);
  await h.call(lead, "lead", "accept", { task: "L1-T1" });
  await h.runtime.desk.settled(h.project);
  await h.idle(lead);
  assert.ok(
    notes(h, lead, "MERGED L1-T1").includes(
      "Note: in what L1-T2 holds (c.txt, **/*.md): notes.md; its Peer works from the lane as it was until its hand-back brings this in, so tell it if its work depends on it.",
    ),
  );

  await handBack(h, "L1-T2", ["c.txt", "package-lock.json"]);
  await h.idle(lead);
  const lock = "Note: outside what it holds (c.txt, **/*.md): package-lock.json (one writer at a time).";
  assert.ok(notes(h, lead, "c.txt, package-lock.json").includes(lock));
  await h.call(lead, "lead", "accept", { task: "L1-T2" });
  await h.runtime.desk.settled(h.project);
  await h.idle(lead);
  assert.ok(notes(h, lead, "MERGED L1-T2").includes(lock));

  h.agents.get(lead)!.status = "idle";
  await h.call(sup, "supervisor", "drop_lane", { lane: "L1", reason: "done here" });
  const cart = { title: "Parts", outcome: "parts", ...scope, writeSet: ["src/**"], isolate: true };
  await h.call(sup, "supervisor", "open_lane", cart);
  const other = h.ledger().lanes.L2!.lead!;
  await h.call(other, "lead", "add_tasks", {
    tasks: [
      planned("p", "P", { holds: ["src/p/"], parallel: true }),
      planned("q", "Q", { holds: ["src/q/"], parallel: true }),
    ],
  });
  await handBack(h, "L2-T1", ["src/p/a.ts", "src/q/b.ts", "src/c.ts", "d.md"]);
  await h.idle(other);
  assert.deepEqual(notes(h, other), [
    "Note: in what L2-T2 holds (src/q/): src/q/b.ts.",
    "Note: outside the lane's write set (src/**): d.md.",
    "Note: outside what it holds (src/p/): src/c.ts.",
  ]);
});

test("a one-writer path a lane changed is noted where an open lane beside it may write it too: at hand-back, merge and landing", async () => {
  const { h, sup, lead } = await laneWriting(["src/**", "package-lock.json"]);
  await h.call(sup, "supervisor", "open_lane", { title: "Lock", outcome: "lock", ...scope, isolate: true });
  await h.call(lead, "lead", "add_tasks", { tasks: [planned("t", "T", { hints: ["package-lock.json"] })] });
  await handBack(h, "L1-T1", ["package-lock.json", "src/a.ts"]);
  await h.idle(lead);
  const lock = "Note: one writer at a time, and open lanes beside yours may write it too: L2 (package-lock.json).";
  assert.deepEqual(notes(h, lead), [lock]);
  await h.call(lead, "lead", "accept", { task: "L1-T1" });
  await h.runtime.desk.settled(h.project);
  await h.idle(lead);
  assert.ok(notes(h, lead, "MERGED L1-T1").includes(lock));
  h.agents.get(lead)!.status = "idle";
  const landed = await h.call(sup, "supervisor", "land_lane", { lane: "L1" });
  assert.match(
    landed.text,
    /It changed what one writer at a time may write, which open lanes may write too: L2 \(package-lock\.json\)\.(?! Whichever)/,
  );
});

test("git the desk runs never runs a hook or a command a seat could plant in the repository it shares", async () => {
  const { h, lead } = await laneWriting(["src/**"]);
  const marks = tempDir("sw3-planted-");
  const plant = (name: string) => `sh -c 'touch "${join(marks, name)}"; cat'`;
  const hook = join(h.root, ".git", "hooks", "post-checkout");
  writeFileSync(hook, `#!/bin/sh\ntouch "${join(marks, "hook")}"\n`);
  chmodSync(hook, 0o755);
  h.git(h.root, "config", "filter.planted.smudge", plant("smudge"));
  h.git(h.root, "config", "filter.planted.clean", plant("clean"));
  writeFileSync(join(h.root, ".git", "info", "attributes"), "* filter=planted\n");
  await h.call(lead, "lead", "add_tasks", { tasks: [planned("a", "A", { holds: ["src/**"], parallel: true })] });
  assert.deepEqual(readdirSync(marks), [], "making the task's copy");
  h.commit(h.ledger().lanes.L1!.worktree!, "b.txt", "the lane moved on\n");
  // The seat's own commit runs what its repository says: that is the seat's, not the desk's.
  await handBack(h, "L1-T1", ["src/a.ts"]);
  rmSync(marks, { recursive: true });
  mkdirSync(marks);
  await h.call(lead, "lead", "accept", { task: "L1-T1" });
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "merged");
  assert.deepEqual(readdirSync(marks), []);
});

test("git the desk runs never runs a command planted in a copy's own worktree config either", async () => {
  const { h, lead } = await laneWriting(["src/**"]);
  const marks = tempDir("sw3-planted-");
  const copy = h.ledger().lanes.L1!.worktree!;
  h.git(h.root, "config", "core.repositoryFormatVersion", "1");
  h.git(h.root, "config", "extensions.worktreeConfig", "true");
  h.git(copy, "config", "--worktree", "filter.mine.smudge", `sh -c 'touch "${join(marks, "smudge")}"; cat'`);
  writeFileSync(join(h.root, ".git", "info", "attributes"), "src/** filter=mine\n");
  await h.call(lead, "lead", "add_tasks", { tasks: [planned("a", "A", { holds: ["src/**"], parallel: true })] });
  await handBack(h, "L1-T1", ["src/a.ts"]);
  await h.call(lead, "lead", "accept", { task: "L1-T1" });
  await h.runtime.desk.settled(h.project);
  assert.equal(h.ledger().tasks["L1-T1"]!.status, "merged");
  assert.equal(readFileSync(join(copy, "src", "a.ts"), "utf-8"), "src/a.ts\n", "the merge wrote the file");
  assert.deepEqual(readdirSync(marks), []);
});

test("a copy the desk made is locked in git, marked as the desk's, while its work goes on, and let go with it", async () => {
  const { h, lead } = await laneWriting(["src/**"]);
  await h.call(lead, "lead", "add_tasks", { tasks: [planned("a", "A", { holds: ["src/**"], parallel: true })] });
  const copy = h.ledger().tasks["L1-T1"]!.worktree!;
  const listed = () =>
    h
      .git(h.root, "worktree", "list", "--porcelain")
      .split("\n\n")
      .find((entry) => entry.includes(`/${copy.split("/").slice(-2).join("/")}\n`));
  assert.match(listed() ?? "", /\nlocked seatworks: the working copy of L1-T1 A, which the desk removes itself$/);
  assert.throws(
    () => h.git(h.root, "worktree", "remove", copy),
    /locked/,
    "no git command takes it from under its seat",
  );
  await h.call(lead, "lead", "cut", { task: "L1-T1", reason: "not now" });
  await h.tick();
  assert.equal(listed(), undefined, "and it goes with its work");
});

test("a copy the desk makes brings along the ignored files the project's .worktreeinclude names, and no others", async () => {
  const { h, lead } = await laneWriting(["src/**"]);
  writeFileSync(join(h.root, ".gitignore"), ".env\nconfig/local.json\nbuild/\n");
  writeFileSync(join(h.root, ".worktreeinclude"), ".env\nconfig/local.json\ndrafts/\n");
  h.git(h.root, "add", ".gitignore", ".worktreeinclude");
  h.git(h.root, "commit", "-qm", "what copies take along");
  writeFileSync(join(h.root, ".env"), "KEY=local\n");
  mkdirSync(join(h.root, "config"));
  writeFileSync(join(h.root, "config", "local.json"), "{}\n");
  mkdirSync(join(h.root, "build"));
  writeFileSync(join(h.root, "build", "out.js"), "built\n");
  mkdirSync(join(h.root, "drafts"));
  writeFileSync(join(h.root, "drafts", "idea.md"), "the Human's own draft\n");
  await h.call(lead, "lead", "add_tasks", { tasks: [planned("a", "A", { holds: ["src/**"], parallel: true })] });
  const copy = h.ledger().tasks["L1-T1"]!.worktree!;
  assert.equal(readFileSync(join(copy, ".env"), "utf-8"), "KEY=local\n");
  assert.equal(readFileSync(join(copy, "config", "local.json"), "utf-8"), "{}\n");
  assert.equal(existsSync(join(copy, "build")), false, "an ignored file it does not name stays behind");
  assert.equal(existsSync(join(copy, "drafts")), false, "and a file it names that git does not ignore is no copy's");
  assert.equal(h.git(copy, "status", "--porcelain"), "", "and what it brings is ignored there too");
});

test("the project's setup runs in each copy the desk makes before its seat starts, told its copy's number, and its seat reads how it went", async () => {
  const { h, sup, lead } = await laneWriting(["src/**"]);
  const setup = `node -e "require('fs').writeFileSync('copy.txt', process.env.SEATWORKS_COPY)"`;
  assert.match((await h.call(sup, "supervisor", "set_project", { setup })).text, /setup node -e/);
  h.git(h.root, "commit", "-qm", "copies ignore it", "--allow-empty");
  writeFileSync(join(h.root, ".git", "info", "exclude"), "copy.txt\n");
  await h.call(lead, "lead", "add_tasks", { tasks: [planned("a", "A", { holds: ["src/**"], parallel: true })] });
  const first = h.ledger().tasks["L1-T1"]!;
  assert.equal(readFileSync(join(first.worktree!, "copy.txt"), "utf-8"), first.slot!.slice(1));
  const brief = (id: string) => h.agents.get(h.ledger().tasks[id]!.peer!)!.prompt ?? "";
  assert.match(brief("L1-T1"), /^Setup: node -e [^\n]* ran in this copy before you started, and passed in \d+s\.$/m);

  await h.call(sup, "supervisor", "set_project", { setup: "echo no network >&2; exit 3" });
  await h.call(lead, "lead", "add_tasks", { tasks: [planned("b", "B", { holds: ["test/**"], parallel: true })] });
  assert.match(
    brief("L1-T2"),
    /^Setup: echo no network >&2; exit 3 ran in this copy before you started and failed with exit 3; its log is [^\n]*setup-S\d+-\d+\.log, which ends:\n\$ echo no network >&2; exit 3\nno network$/m,
  );
});
