import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { renderPrompt } from "../../server/catalog/kit/content.ts";
import type { Kit } from "../../server/catalog/kit/kit.ts";
import { materialize, seatDir } from "../../server/catalog/seat/seats.ts";
import { resolveTeam } from "../../server/catalog/team/team.ts";
import type { Layer } from "../../shared/settings.ts";
import { makeKit } from "../kit.ts";
import { tempDir } from "../tempdir.ts";

const project = { root: "/work/shop", slug: "shop-abc123", state: "/state/shop" };

function put(kit: Kit, path: string, text: string): void {
  mkdirSync(dirname(join(kit.dir, path)), { recursive: true });
  writeFileSync(join(kit.dir, path), text);
}

const filesIn = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => !entry.isDirectory())
        .map((entry) => entry.name)
    : [];

const skill = (body: string) => `---\nname: test-first\ndescription: tests\n---\n\n${body}\n`;
const UNBUILDABLE: { role: string; layer?: Layer; file?: string; text?: string; refusal: string }[] = [
  {
    role: "peer",
    file: "content/prompts/PEER.md",
    text: "# Peer\n\nAsk the seat above you.\n",
    refusal: "the peer prompt contains words that role must not see: seat",
  },
  {
    role: "lead",
    layer: { roles: { lead: { harness: "omp" } } },
    file: "harness/omp/delta/lead.md",
    text: "Ask the supervisor.\n",
    refusal: "the lead prompt contains words that role must not see: supervisor",
  },
  {
    role: "peer",
    file: "mcp/tools.json",
    text: JSON.stringify({ peer: [{ name: "done", description: "Hand the task back; your paseo is told." }] }),
    refusal: "the peer tools the peer is given show words it must not see: paseo",
  },
  {
    role: "peer",
    file: "mcp/instructions.json",
    text: JSON.stringify({ peer: "Hand work back to your paseo." }),
    refusal: "the peer tools the peer is given show words it must not see: paseo",
  },
  {
    role: "peer",
    file: "content/skills/peer/test-first/SKILL.md",
    text: skill("Ask the seat above you."),
    refusal: "skill test-first shows the peer words it must not see in SKILL.md: seat",
  },
  {
    role: "peer",
    file: "content/skills/peer/test-first/SKILL.md",
    text: skill("Read {{guides}}/BRIEF.md."),
    refusal: "skill test-first holds {{guides}} in SKILL.md, and a skill is read as written, so nothing fills it in",
  },
  {
    role: "lead",
    file: "content/prompts/LEAD.md",
    text: "Read {{notes}} first.\n",
    refusal: "the lead prompt still holds the placeholder {{notes}}",
  },
  {
    role: "lead",
    file: "content/prompts/LEAD.md",
    text: "Keep a diary in {{state}}/diary.md.\n",
    refusal:
      "the lead prompt names diary.md under the project's state, which the role does not write: add it to the role's writes",
  },
  {
    role: "peer",
    file: "content/skills/peer/test-first/SKILL.md",
    text: skill("Write findings to $SEATWORKS_STATE/findings/."),
    refusal:
      "skill test-first names findings under the project's state in SKILL.md, which the peer does not write: add it to the role's writes",
  },
];

test("a seat whose text shows its role a hidden word, an unfilled placeholder or a state path it does not write is refused before anything is written, and the paths the desk fills in are not held against it", () => {
  for (const { role, layer, file, text, refusal } of UNBUILDABLE) {
    const kit = makeKit();
    if (file) put(kit, file, text!);
    const team = resolveTeam(kit, layer);
    assert.deepEqual(team.errors, [], `${refusal}: nothing the schema or the team resolution objects to`);
    const home = tempDir("sw3-home-");
    assert.throws(() => materialize(kit, team, role, home, project), { message: refusal });
    const dir = seatDir(kit, team.roles[role]!.role, team.roles[role]!.harness, home, project);
    assert.deepEqual(filesIn(dir), [], `${refusal}: nothing at all is written, because half a seat is worse than none`);
  }

  const kit = makeKit();
  const roleOf = (name: string) => kit.roles.find((entry) => entry.role === name)!;
  assert.equal(
    renderPrompt(kit, roleOf("supervisor"), "claude", { guides: "/g", state: "/s" }),
    "# Supervisor\n\nGuides live in /g; state in /s.\n",
  );
  put(
    kit,
    "content/prompts/LEAD.md",
    "Put the plan in {{state}}/plans/cart.md; the history is in $SEATWORKS_STATE/events.log.\n",
  );
  assert.equal(
    renderPrompt(kit, roleOf("lead"), "claude", { guides: "/g", state: "/Users/supervisor/x" }),
    "Put the plan in /Users/supervisor/x/plans/cart.md; the history is in $SEATWORKS_STATE/events.log.\n",
    "a hidden word in a path the desk puts in is not the role's text, and the role names what it writes or the desk's own record",
  );
  const home = tempDir("sw3-home-");
  const human = resolveTeam(kit, {
    rules: "Leave the Paseo config alone.",
    roles: { peer: { rules: "Keep notes in $SEATWORKS_STATE/peer-notes.md." } },
  });
  assert.ok(
    materialize(kit, human, "peer", home, project).length > 0,
    "the Human's rules reach the seat as written: the words its role's own text hides and the state it does not write included",
  );
});
