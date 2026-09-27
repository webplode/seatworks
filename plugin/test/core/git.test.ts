import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileKinds } from "../../server/catalog/kit/ecosystem-patterns.ts";
import { contains, headSha, mergeBranch } from "../../server/core/git.ts";
import { diffCounts, kindOf } from "../../server/core/git-diff.ts";
import { advance, landLane, mergeCommit } from "../../server/core/land.ts";
import { makeKit } from "../kit.ts";
import { tempDir } from "../tempdir.ts";

const kinds = fileKinds(makeKit());
const KEEP = "refs/seatworks/lanes/L1";

/** A repository on main with one commit, a.txt holding "one". */
function repo() {
  const root = tempDir("sw3-git-");
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { encoding: "utf-8" });
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const commit = (file: string, text: string, message: string) => {
    write(file, text);
    run("add", file);
    run("commit", "-qm", message);
  };
  const sha = async (ref = "HEAD") => (await headSha(root, ref))!;
  run("init", "-q", "-b", "main");
  commit("a.txt", "one\n", "seed");
  return { root, run, write, commit, sha };
}

/** main with a lane of two commits on it, checked out on main or not. */
async function laneOfTwo(onMain: boolean) {
  const made = repo();
  made.run("checkout", "-qb", "lane/l1");
  made.commit("b.txt", "two\n", "wip one");
  made.commit("b.txt", "two, done\n", "wip two");
  made.run("checkout", "-q", onMain ? "main" : "lane/l1");
  return { ...made, main: await made.sha("main"), tip: await made.sha("lane/l1") };
}

test("a lane lands on base only as its gate saw it, squashed, merged or fast-forwarded, made as seatworks and unsigned, and base moves only from the commit it was read as", async () => {
  const ff = repo();
  ff.run("checkout", "-qb", "lane/l1");
  ff.run("checkout", "-qb", "task/l1-t1");
  ff.commit("b.txt", "two\n", "task work");
  ff.run("checkout", "-q", "lane/l1");
  assert.equal(
    (await mergeBranch(ff.root, "task/l1-t1", "Merge L1-T1")).ok,
    true,
    "a task branch merges into the lane",
  );
  ff.run("checkout", "-q", "main");
  const forwarded = await landLane(ff.root, "main", "lane/l1", await ff.sha("lane/l1"), {
    as: "ff",
    message: "",
    keep: KEEP,
  });
  assert.equal(forwarded.landed, true, forwarded.how);
  assert.equal(await ff.sha("main"), await ff.sha("lane/l1"), "main fast-forwards to the lane");

  for (const onMain of [true, false]) {
    const squashed = await laneOfTwo(onMain);
    const landed = await landLane(squashed.root, "main", "lane/l1", squashed.tip, {
      as: "squash",
      message: "Cart (L1)\n\nTotals add up",
      keep: KEEP,
    });
    assert.equal(landed.landed, true, landed.how);
    assert.equal(
      squashed.run("rev-parse", "main^").trim(),
      squashed.main,
      "one commit, straight on the main it was gated against",
    );
    assert.equal(squashed.run("rev-parse", "main^{tree}").trim(), squashed.run("rev-parse", "lane/l1^{tree}").trim());
    assert.equal(squashed.run("log", "-1", "--format=%B", "main").trim(), "Cart (L1)\n\nTotals add up");
    assert.equal(squashed.run("rev-parse", KEEP).trim(), squashed.tip, "its steps are kept under a hidden ref");
    assert.equal(await contains(squashed.root, "main", "lane/l1"), false, "main does not carry the lane's own commits");
  }

  const signing = await laneOfTwo(true);
  signing.run("config", "commit.gpgSign", "true");
  signing.run("config", "gpg.program", "false");
  const unsigned = await landLane(signing.root, "main", "lane/l1", signing.tip, {
    as: "squash",
    message: "Cart (L1)",
    keep: KEEP,
  });
  assert.equal(unsigned.landed, true, `a signer that needs the Human cannot stop a landing: ${unsigned.how}`);
  assert.equal(signing.run("log", "-1", "--format=%an <%ae>", "main").trim(), "seatworks <seatworks@localhost>");

  const merge = await laneOfTwo(true);
  const merged = await landLane(merge.root, "main", "lane/l1", merge.tip, {
    as: "merge",
    message: "Cart (L1)",
    keep: KEEP,
  });
  assert.equal(merged.landed, true, merged.how);
  assert.deepEqual(merge.run("log", "-1", "--format=%P", "main").trim().split(" "), [merge.main, merge.tip]);
  assert.equal(merge.run("status", "--porcelain").trim(), "", "the main copy follows its branch");

  const undone = repo();
  undone.run("checkout", "-qb", "lane/l1");
  undone.commit("a.txt", "changed\n", "try");
  undone.commit("a.txt", "one\n", "undo");
  undone.run("checkout", "-q", "main");
  const unchanged = await undone.sha("main");
  const nothing = await landLane(undone.root, "main", "lane/l1", await undone.sha("lane/l1"), {
    as: "squash",
    message: "Nothing (L1)",
    keep: KEEP,
  });
  assert.equal(nothing.landed, true, nothing.how);
  assert.equal(await undone.sha("main"), unchanged, "a lane that changes nothing lands without an empty commit");
  assert.equal(await contains(undone.root, KEEP, "lane/l1"), true, "its commits are kept all the same");

  const behind = repo();
  behind.run("checkout", "-qb", "lane/l2");
  behind.commit("c.txt", "lane\n", "lane work");
  behind.run("checkout", "-q", "main");
  behind.commit("d.txt", "main\n", "main moved");
  const ahead = await behind.sha("main");
  const ungated = await landLane(behind.root, "main", "lane/l2", await behind.sha("lane/l2"), {
    as: "squash",
    message: "x",
    keep: "refs/seatworks/lanes/L2",
  });
  assert.equal(ungated.landed, false);
  assert.match(ungated.how, /does not contain main/, "that merge would be one no gate saw");
  assert.equal(await behind.sha("main"), ahead);

  const moved = repo();
  moved.run("checkout", "-qb", "lane/l1");
  moved.commit("b.txt", "gated\n", "what the gate saw");
  const tested = await moved.sha("lane/l1");
  moved.commit("b.txt", "after\n", "a commit after the gate");
  moved.run("checkout", "-q", "main");
  const kept = await moved.sha("main");
  const stale = await landLane(moved.root, "main", "lane/l1", tested, { as: "squash", message: "x", keep: KEEP });
  assert.equal(stale.landed, false);
  assert.match(stale.how, /moved after its gate ran/, "what would land is not what was tested");
  assert.equal(await moved.sha("main"), kept);

  for (const onMain of [true, false]) {
    const raced = repo();
    const read = await raced.sha("main");
    raced.run("checkout", "-qb", "lane/l1");
    raced.commit("b.txt", "lane\n", "lane work");
    const tip = await raced.sha("lane/l1");
    raced.run("checkout", "-q", "main");
    raced.commit("c.txt", "landed first\n", "another lane landed meanwhile");
    const landedFirst = await raced.sha("main");
    if (!onMain) raced.run("checkout", "-q", "lane/l1");
    assert.deepEqual(await advance(raced.root, "main", read, tip), { why: "moved" }, `on main: ${onMain}`);
    assert.equal(await raced.sha("main"), landedFirst, "a landing in between is never written over");
  }
});

test("the desk's merges leave the lane as it was on a conflict, ignore the Human's rerere and signer, can be made without a checkout, and a branch counts as merged only on the branches' word", async () => {
  const conflict = repo();
  conflict.run("checkout", "-qb", "lane/l1");
  conflict.run("checkout", "-qb", "task/l1-t2");
  conflict.commit("a.txt", "task side\n", "task edit");
  conflict.run("checkout", "-q", "lane/l1");
  conflict.commit("a.txt", "lane side\n", "lane edit");
  const before = await conflict.sha();
  const stopped = await mergeBranch(conflict.root, "task/l1-t2", "Merge L1-T2");
  assert.deepEqual(stopped.ok ? [] : stopped.conflicts, ["a.txt"], "the files in conflict are named");
  assert.equal(await conflict.sha(), before, "and the lane is left as it was");
  assert.equal(conflict.run("status", "--porcelain").trim(), "");

  const human = repo();
  human.run("config", "rerere.enabled", "true");
  human.run("config", "rerere.autoUpdate", "true");
  human.run("checkout", "-qb", "task/l1-t2");
  human.commit("a.txt", "task side\n", "task edit");
  human.run("checkout", "-q", "main");
  human.commit("a.txt", "lane side\n", "lane edit");
  // Settled once by hand: rerere records it and would settle it again by itself, leaving nothing unmerged to name.
  assert.throws(
    () => human.run("merge", "-q", "task/l1-t2"),
    (error: { stdout?: string }) => /CONFLICT/.test(error.stdout ?? ""),
  );
  human.write("a.txt", "both\n");
  human.run("commit", "-qam", "settled");
  human.run("reset", "-q", "--hard", "HEAD~1");
  const again = await mergeBranch(human.root, "task/l1-t2", "Merge L1-T2");
  assert.deepEqual(again.ok ? [] : again.conflicts, ["a.txt"], "a desk merge reads conflicts as git leaves them");
  human.run("checkout", "-qb", "task/l1-t3");
  human.commit("c.txt", "c\n", "task three");
  human.run("checkout", "-q", "main");
  human.run("config", "commit.gpgSign", "true");
  human.run("config", "gpg.program", "false");
  assert.equal(
    (await mergeBranch(human.root, "task/l1-t3", "Merge L1-T3")).ok,
    true,
    "a signer that needs the Human cannot stop a merge only the desk makes",
  );

  const bare = repo();
  const onto = await bare.sha("main");
  bare.run("checkout", "-qb", "task/l1-t1");
  bare.commit("b.txt", "two\n", "task work");
  bare.run("checkout", "-q", "main");
  const made = (await mergeCommit(bare.root, onto, "task/l1-t1", "Merge L1-T1: Two"))!;
  assert.equal(bare.run("rev-parse", `${made}^{tree}`).trim(), bare.run("rev-parse", "task/l1-t1^{tree}").trim());
  assert.equal(
    bare.run("log", "-1", "--format=%P %an %s", made).trim(),
    `${onto} ${bare.run("rev-parse", "task/l1-t1").trim()} seatworks Merge L1-T1: Two`,
  );
  assert.equal(await bare.sha("main"), onto, "main is where it was until something advances it");

  const branches = repo();
  branches.run("checkout", "-qb", "lane/l1");
  branches.commit("b.txt", "lane\n", "lane work");
  branches.run("checkout", "-qb", "task/l1-t1");
  branches.commit("c.txt", "task\n", "task work");
  branches.run("checkout", "-q", "lane/l1");
  branches.run("merge", "-q", "--no-ff", "-m", "Merge L1-T1", "task/l1-t1");
  // main is what a plain `branch -d` would read here, and the task's work is not in main at all.
  branches.run("checkout", "-q", "main");
  assert.equal(await contains(branches.root, "lane/l1", "task/l1-t1"), true, "the task branch is all in the lane");
  assert.equal(await contains(branches.root, "main", "task/l1-t1"), false);
  assert.equal(
    await contains(branches.root, "lane/l1", "task/gone"),
    undefined,
    "a branch that is not there is not an answer to delete on",
  );
});

test("what a change touched is read as real paths and counted by kind", async () => {
  const named = [
    ["src/pricing.js", "src"],
    ["test/pricing.test.js", "test"],
    ["src/main/java/OrderServiceTest.java", "test"],
    ["docs/design.md", "docs"],
    ["pkg/cart_test.go", "test"],
    ["pkg/cart_TEST.go", "src"],
    ["src/main/java/OrderServicetest.java", "src"],
  ];
  assert.deepEqual(
    named.map(([path]) => [path, kindOf(path!, kinds)]),
    named,
    "a test file's name is matched as its tools match it, case and all",
  );

  const changed = repo();
  changed.commit("src/a.js", "old one\nold two\n", "source");
  changed.commit("README.md", "a\nb\nc\n", "docs");
  const from = await changed.sha();
  changed.write("src/a.js", Array.from({ length: 10 }, (_, line) => `new ${line}\n`).join(""));
  changed.write("test/a.test.js", "1\n2\n3\n4\n5\n");
  changed.write("README.md", "x\ny\nz\n");
  changed.run("add", "-A");
  changed.run("commit", "-qm", "change");
  const counts = (await diffCounts(changed.root, from, "HEAD", kinds))!;
  assert.deepEqual({ src: counts.src, test: counts.test, docs: counts.docs }, { src: 12, test: 5, docs: 6 });

  changed.commit("src/pricing.ts", "export const rate = 1;\n".repeat(40), "pricing");
  const unrenamed = await changed.sha();
  changed.run("mv", "src/pricing.ts", "src/price.ts");
  changed.run("commit", "-qm", "rename it");
  assert.deepEqual(
    (await diffCounts(changed.root, unrenamed, "HEAD", kinds))!.files.sort(),
    ["src/price.ts", "src/pricing.ts"],
    "a rename is both real paths a seat can open, not git's display form",
  );

  const plain = await changed.sha();
  changed.commit("src/giá-trị.ts", "x\n", "add");
  const accented = (await diffCounts(changed.root, plain, "HEAD", kinds))!;
  assert.deepEqual(accented.files, ["src/giá-trị.ts"], "the Lead is shown the file that changed, not an octal escape");
  assert.equal(accented.src, 1);
});
