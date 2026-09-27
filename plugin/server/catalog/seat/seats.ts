import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../../core/errors.ts";
import { expandHome, guidesDir, home } from "../../core/paths.ts";
import {
  type PromptPaths,
  renderPrompt,
  renderText,
  skillProblems,
  skillSources,
  toolProblems,
} from "../kit/content.ts";
import type { HarnessSpec, Kit, McpServers, RoleSpec } from "../kit/kit.ts";
import { harnessFileSources } from "../kit/harness-files.ts";
import {
  linkShared,
  linkSkills,
  recorder,
  writeFiles,
  writeInstructions,
  writeMcpFile,
  writeModelCatalog,
  writeRoleSettings,
} from "./seat-files.ts";
import { type Team, rulesFor, skillDirsFor } from "../team/team.ts";

type SeatProject = { root: string; slug: string; state: string };

/** The directory a seat's agent runs from: one per role, agent and project. */
export function seatDir(
  kit: Kit,
  role: RoleSpec,
  harness: HarnessSpec,
  homeDir = home(),
  project?: SeatProject,
): string {
  const name = `${kit.prefix}${role.role}-${harness.id}${project ? `-${project.slug}` : ""}`;
  return join(expandHome(harness.profileRoot, homeDir), name);
}

/** Checked before anything is written: refusing mid-build left a seat booting with config and MCP but no instructions. */
export function seatProblems(kit: Kit, team: Team, roleName: string, paths: PromptPaths): string[] {
  const seat = team.roles[roleName];
  if (!seat) return [`the team has no ${roleName} seat`];
  const problems: string[] = [];
  try {
    renderText(seat.role, rulesFor(team, roleName), paths);
    renderPrompt(kit, seat.role, seat.harness.id, paths);
  } catch (error) {
    problems.push(errorText(error));
  }
  for (const [name, source] of skillSources(kit, seat.role, skillDirsFor(team, roleName)))
    problems.push(...skillProblems(seat.role, name, source));
  problems.push(...toolProblems(kit, seat.role));
  for (const [path, sources] of Object.entries(harnessFileSources(kit, seat.harness, seat.role))) {
    for (const source of sources)
      if (!existsSync(source))
        problems.push(`${seat.harness.label} lays down ${path} from ${source}, which is missing`);
  }
  return problems;
}

/** Builds a seat's directory for its role, agent and project; what changed, empty when it was built already. */
export function materialize(
  kit: Kit,
  team: Team,
  roleName: string,
  homeDir = home(),
  project?: SeatProject,
  servers: McpServers = {},
): string[] {
  const seat = team.roles[roleName];
  if (!seat) throw new Error(`the team has no ${roleName} seat`);
  const dir = seatDir(kit, seat.role, seat.harness, homeDir, project);
  const paths = { guides: guidesDir(homeDir), state: project?.state ?? "$SEATWORKS_STATE" };
  const problems = seatProblems(kit, team, roleName, paths);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const record = recorder();
  mkdirSync(dir, { recursive: true });
  const built = { dir, homeDir, state: project?.state, root: project?.root };
  writeRoleSettings(kit, seat.harness, seat.role, built, record, writeModelCatalog(seat.harness, dir, record));
  writeFiles(kit, seat.harness, seat.role, dir, record);
  linkShared(seat.harness, dir, homeDir, record);
  writeMcpFile(seat.harness, dir, servers, record);
  writeInstructions(kit, team, roleName, dir, record, project?.root);
  linkSkills(kit, team, roleName, built, record);
  return record.changes;
}
