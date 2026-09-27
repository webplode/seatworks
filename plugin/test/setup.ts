import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { format } from "node:util";
import { tempDir } from "./tempdir.ts";

/** Git's own binary first on PATH, for the tests and all they run: Apple's /usr/bin/git looks it up on every call, a third of the suite's time. */
const gitHome = execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim();
if (existsSync(join(gitHome, "git"))) process.env.PATH = `${gitHome}${delimiter}${process.env.PATH ?? ""}`;
// This follows tests that replace HOME again, without overriding the desk's per-command identity.
const gitConfig = join(tempDir("sw3-git-config-"), "config");
writeFileSync(gitConfig, "[user]\n\tname = Seatworks Test\n\temail = seatworks-test@example.invalid\n");
process.env.GIT_CONFIG_GLOBAL = gitConfig;

/** Compiled code kept between runs, here and in the servers the tests start: loading was a quarter of the suite's time. */
const compiled = enableCompileCache();
if (compiled.directory) process.env.NODE_COMPILE_CACHE = compiled.directory;

/** A HOME of its own for every test, set before any test file loads, so none reads the owner's state or another test's. */
const freshHome = () => {
  process.env.HOME = tempDir("sw3-home-");
};
freshHome();
beforeEach(freshHome);

const said: string[] = [];
const original = console.error.bind(console);
console.error = (...args: unknown[]) => {
  said.push(format(...args));
};

/** A test that expects an error says so by mocking `console.error`; anything else it prints fails it. */
afterEach(() => {
  const found = said.splice(0);
  if (found.length > 0)
    throw new Error(
      `console.error was called and the test did not expect it (one that does reads it with reported(t) from test/console.ts):\n${found.join("\n")}`,
    );
});

process.on("exit", () => {
  if (said.length === 0) return;
  original(`console.error was called after the tests ended:\n${said.join("\n")}`);
  process.exitCode = 1;
});
