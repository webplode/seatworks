import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tempDir } from "../tempdir.ts";
import type { harness } from "./harness.ts";

type Handle = { refresh: () => Promise<unknown>; archive: () => Promise<unknown> };

/** The desk's next `call` on `seat` in Paseo, a look or an archive, is held until `release`. */
export function heldCall(h: ReturnType<typeof harness>, seat: string, call: keyof Handle) {
  const agents = (h.paseo as { agents: { ref: (id: string) => Handle } }).agents;
  const ref = agents.ref;
  let armed = true;
  let reach = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  agents.ref = (id) => {
    const handle = ref(id);
    if (id !== seat) return handle;
    return Object.assign(Object.create(handle) as Handle, {
      [call]: async () => {
        if (armed) {
          armed = false;
          reach();
          await held;
        }
        return handle[call]();
      },
    });
  };
  return { reached, release };
}

/** The desk's next look at `seat` in Paseo is held until `release`. */
export const heldLook = (h: ReturnType<typeof harness>, seat: string) => heldCall(h, seat, "refresh");

/**
 * The next git `subcommand` the plugin runs is held until `release`, through a git first on PATH that holds that one
 * call; git's other calls, and later ones, go straight through. `release` also takes that git off PATH.
 */
export function heldGit(subcommand: string) {
  const dir = tempDir("sw3-git-");
  const real = execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim();
  const hold = `if mkdir "${dir}/taken" 2>/dev/null; then touch "${dir}/reached"; while [ ! -f "${dir}/go" ]; do sleep 0.02; done; fi`;
  writeFileSync(
    join(dir, "git"),
    `#!/bin/sh\ncase " $* " in *" ${subcommand} "*) ${hold};; esac\nexec "${real}/git" "$@"\n`,
  );
  chmodSync(join(dir, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  const reached = (async () => {
    while (!existsSync(join(dir, "reached"))) await new Promise((resolve) => setTimeout(resolve, 20));
  })();
  const release = () => {
    writeFileSync(join(dir, "go"), "");
    process.env.PATH = path;
  };
  return { reached, release };
}
