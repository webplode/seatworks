import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { detectGate, gateCommands, projectOf } from "../../server/desk/project/project.ts";
import { makeKit } from "../kit.ts";
import { tempDir } from "../tempdir.ts";

const { ecosystem } = makeKit();

test("a directory outside git is its own project, under a slug that reads as its name, stays the same and differs by path", () => {
  const oms = join(tempDir("sw3-plain-"), "OMS");
  const other = join(tempDir("sw3-plain-"), "OMS");
  mkdirSync(oms);
  mkdirSync(other);
  const project = projectOf(oms, "/state");
  assert.equal(project.root, oms);
  assert.match(project.slug, /^oms-[0-9a-f]{6}$/);
  assert.equal(project.state, join("/state", "projects", project.slug));
  assert.deepEqual(
    projectOf(oms, "/elsewhere"),
    { root: oms, slug: project.slug, state: join("/elsewhere", "projects", project.slug) },
    "read again under another state root, where nothing remembered answers",
  );
  assert.notEqual(projectOf(other, "/state").slug, project.slug);
});

test("a project's gate is found from its files, and so is the runner that gate starts", () => {
  const root = tempDir("sw3-detect-");
  assert.equal(detectGate(root, ecosystem), undefined);
  assert.deepEqual(gateCommands(root, undefined, ecosystem), []);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
  );
  writeFileSync(join(root, "Cargo.toml"), "");
  assert.equal(
    detectGate(root, ecosystem),
    "cargo test",
    "the placeholder npm writes is no test script, so the next rule answers",
  );
  assert.deepEqual(gateCommands(root, "cargo test", ecosystem), ["cargo test"]);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { test: 'node --test "test/**/*.test.js"', check: "tsc --noEmit && vitest run --reporter dot" },
    }),
  );
  assert.equal(detectGate(root, ecosystem), "npm test");
  assert.deepEqual(gateCommands(root, "npm test", ecosystem), ["npm test", "node --test"]);
  assert.deepEqual(gateCommands(root, "npm run check", ecosystem), ["npm run check", "vitest run"]);
  assert.deepEqual(gateCommands(root, "npm run missing", ecosystem), ["npm run missing"]);
  writeFileSync(join(root, "pnpm-lock.yaml"), "");
  assert.equal(detectGate(root, ecosystem), "pnpm test");
});
