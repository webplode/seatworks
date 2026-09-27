// A seat's agent, started only on the seat's own settings and with the flags its harness forces on it; Paseo's version
// probe, which starts no session, passes unconfigured.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

function fail(message) {
  process.stderr.write(`Seat room: ${message}\n`);
  process.exit(2);
}

const bin = process.env.SEATWORKS_AGENT_BIN;
if (!bin) fail("env.SEATWORKS_AGENT_BIN is unset on this seat's provider; reload the seatworks-v3 plugin.");
const manifest = join(process.env.SEATWORKS_KIT ?? "", "harness", process.env.SEATWORKS_HARNESS ?? "", "harness.json");
let harness;
try {
  harness = JSON.parse(readFileSync(manifest, "utf-8"));
} catch {
  fail(`${manifest} can't be read; set env.SEATWORKS_KIT and env.SEATWORKS_HARNESS on this seat's provider and reload the seatworks-v3 plugin.`);
}

let args = process.argv.slice(2);
const configDir = harness.configDirEnv;
if (configDir && !process.env[configDir] && !(args.length === 1 && args[0] === "--version"))
  fail(`${configDir} is unset, so this seat would run on your own settings instead of its role's. The seatworks-v3 plugin did not configure this launch: reload it, or start this agent from a provider it does not own.`);
// A seat's own config directory has no login of its own: a token kept in the owner's keychain signs it in.
for (const [name, service] of Object.entries(harness.provider?.keychainEnv ?? {})) {
  if (process.env[name]) continue;
  try {
    const secret = execFileSync("security", ["find-generic-password", "-s", String(service), "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (secret) process.env[name] = secret;
  } catch {
    // No matching keychain entry, or no macOS `security` command: the agent starts signed out.
  }
}
if (!configDir || process.env[configDir])
  for (const [flag, value] of Object.entries(harness.provider?.forceFlags ?? {})) {
    const forced = [];
    let seen = false;
    for (let at = 0; at < args.length; at++) {
      if (args[at] === flag) {
        forced.push(flag, String(value));
        seen = true;
        at++;
      } else if (args[at].startsWith(`${flag}=`)) {
        forced.push(`${flag}=${value}`);
        seen = true;
      } else forced.push(args[at]);
    }
    args = seen ? forced : [...forced, flag, String(value)];
  }

// cmd's own characters escaped, and quoted where it would split: how Windows runs a command through its shell.
const forCmd = (value) => {
  const escaped = value.replace(/([&|^<>()!])/g, "^$1");
  return /[\s"]/u.test(value) ? `"${escaped.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/u, "$&$&")}"` : escaped;
};
// A bare name or a batch file runs through cmd on Windows, which finds it on PATH as it would; anything else runs as is.
const shell = process.platform === "win32" && (/^\.(cmd|bat)$/i.test(extname(bin)) || !/[\\/]/.test(bin) && !extname(bin));
const child = spawn(shell ? forCmd(bin) : bin, shell ? args.map(forCmd) : args, { stdio: "inherit", shell, windowsHide: true });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => fail(`${bin} could not start: ${error.message}`));
child.on("exit", (code, signal) => {
  // Ended by a signal, the room ends by it too: its own forwarding handler would otherwise swallow it.
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
