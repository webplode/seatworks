import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { addWorktree, branchExists, cleanState, contains, currentBranch, excludeFromGit, git, landedRef, removeWorktree } from "../core/git.ts";
import { workState } from "../catalog/project-files.ts";
import type { Workspace, Workspaces } from "../core/ports.ts";
import { worktreeRoot } from "../core/paths.ts";
import type { DeskContext } from "./context.ts";
import { type Ledger, type Slot, loadLedger, nextSlotId } from "./ledger.ts";
import { clip } from "./letters.ts";
import type { Project } from "./project.ts";
import { errorText } from "../core/errors.ts";

export type Holder = { lane?: string; task?: string };

/** What putting a lane's copy away means: the copy itself if it had one, the project's branch if not. */
export type Teardown = { project: Project; slot?: string; dropBranch?: string; into?: string; restore?: string; lane?: string; branch?: string };

export class Slots {
  private readonly ctx: DeskContext;
  private readonly workspaces: Workspaces;


  constructor(ctx: DeskContext, workspaces: Workspaces) {
    this.ctx = ctx;
    this.workspaces = workspaces;
  }

  async acquire(project: Project, branch: string, base: string, holder: Holder): Promise<Slot> {
    const picked = await this.reserve(project, holder);
    try {
      const reused = await this.checkOut(project, picked, branch, base);
      const workspaceId = picked.workspaceId ?? (await this.createWorkspace(project, picked));
      this.ctx.event(project, { kind: "slot.taken", slot: picked.id, branch, ...holder });
      this.index(project, picked, reused);
      return { ...picked, workspaceId };
    } catch (error) {
      await this.free(project, picked.id);
      throw error;
    }
  }

  async inPlace(project: Project, branch: string, base: string): Promise<{ path: string; workspaceId: string }> {
    const copy = await workState(project.root);
    if (copy !== "clean") {
      throw new Error(
        copy === "dirty"
          ? "the project's own working copy has uncommitted changes, so a lane cannot take it over; commit or stash them, or open the lane with isolate true"
          : `git could not read the project's own working copy at ${project.root}, so a lane cannot take it over`,
      );
    }
    if (await branchExists(project.root, branch)) throw new Error(`the branch ${branch} already exists`);
    const run = await git(project.root, ["switch", "-c", branch, base]);
    if (run.code !== 0) throw new Error(run.stderr.trim() || "git switch failed");
    try {
      const taken = await this.takeOwnCopy(project);
      this.ctx.event(project, { kind: "lane.inPlace", branch, base });
      return taken;
    } catch (error) {
      await this.giveBack(project, base, branch);
      throw error;
    }
  }

  /** Carries on the branch the project's own copy is on, or first starts `branch` from `from` there with the uncommitted work along. */
  async carryOn(project: Project, branch: string, from?: string): Promise<{ path: string; workspaceId: string }> {
    if (from) {
      const run = await git(project.root, ["switch", "-c", branch]);
      if (run.code !== 0) throw new Error(run.stderr.trim() || "git switch failed");
    }
    try {
      const taken = await this.takeOwnCopy(project);
      this.ctx.event(project, { kind: "lane.onBranch", branch, ...(from ? { from } : {}) });
      return taken;
    } catch (error) {
      if (from) await this.unstart(project, from, branch);
      throw error;
    }
  }

  /** Undoes a branch `carryOn` started: it holds no commit yet, so the copy goes back to `from` with the uncommitted work and the branch is dropped. */
  async unstart(project: Project, from: string, branch: string): Promise<void> {
    if ((await currentBranch(project.root)) !== branch) return;
    const run = await git(project.root, ["switch", from]);
    if (run.code !== 0) {
      this.ctx.log(project, `the project's own copy could not go back from ${branch} to ${from}: ${run.stderr.trim() || `git switch exited ${run.code}`}`);
      return;
    }
    if ((await contains(project.root, from, branch)) === true) await git(project.root, ["branch", "-D", branch]);
    this.ctx.event(project, { kind: "lane.unstarted", branch, from });
  }

  private async takeOwnCopy(project: Project): Promise<{ path: string; workspaceId: string }> {
    const workspaceId = (await this.projectWorkspace(project)).id;
    this.index(project, { id: "main", path: project.root, createdAt: Date.now() }, true);
    return { path: project.root, workspaceId };
  }

  /** Undoes what `inPlace` did to the owner's repository: a lane failing mid-open has no slot id for `openLane` to clean up through. */
  async giveBack(project: Project, base: string, branch: string): Promise<void> {
    if (!(await this.restore(project, base, branch))) return;
    // Nothing committed on it: the branch is the desk's litter, and `release` keeps the other case for the Human.
    if ((await contains(project.root, base, branch)) === true) await git(project.root, ["branch", "-D", branch]);
    this.ctx.event(project, { kind: "lane.gaveBack", branch, base });
  }

  /** A landed lane's branch is all under its landed ref by now: the desk's to clear, not the Human's to keep. */
  private async dropLanded(project: Project, branch: string, into: string): Promise<void> {
    if ((await contains(project.root, into, branch)) === true) await git(project.root, ["branch", "-D", branch]);
  }

  async projectWorkspace(project: Project): Promise<Workspace> {
    const kept = await this.workspaces.named(project.slug).catch(() => undefined);
    return kept ?? (await this.workspaces.make(project.slug, project.root));
  }

  /**
   * Puts the project's own copy back on base and says whether it is there. A copy a later lane now owns counts
   * as done; every other failure is logged, since the caller has already dropped the parked record.
   */
  async restore(project: Project, base: string, left?: string): Promise<boolean> {
    if (left && (await currentBranch(project.root)) !== left) return true;
    const copy = await cleanState(project.root);
    if (copy !== "clean") {
      const why = copy === "dirty" ? "it has uncommitted changes" : "git could not read it";
      this.ctx.log(project, `the project's own working copy is still on ${left ?? "a lane branch"} and not back on ${base}: ${why}`);
      this.ctx.event(project, { kind: "restore.held", base, branch: left ?? null, why: copy });
      return false;
    }
    const run = await git(project.root, ["switch", base]);
    if (run.code !== 0) {
      this.ctx.log(project, `the project's own working copy could not go back to ${base}: ${run.stderr.trim() || `git switch exited ${run.code}`}`);
      this.ctx.event(project, { kind: "restore.held", base, branch: left ?? null, why: "switch-failed" });
      return false;
    }
    return true;
  }

  /** Puts a lane's copy away, or waits for the seats still writing in it: removing or switching it under them loses their work. */
  async putAway(teardown: Teardown, writers: string[] = []): Promise<string | undefined> {
    const waiting = [...new Set(writers)];
    if (waiting.length === 0 || (!teardown.slot && !teardown.restore)) return this.run(teardown);
    if (teardown.slot) {
      await this.ctx.ledger(teardown.project, (ledger) => {
        const slot = ledger.slots[teardown.slot!];
        if (slot) slot.releasing = { writers: waiting, dropBranch: teardown.dropBranch, into: teardown.into };
      });
    } else if (teardown.lane) {
      await this.ctx.ledger(teardown.project, (ledger) => {
        const lane = ledger.lanes[teardown.lane!];
        if (lane) lane.restoring = { writers: waiting, base: teardown.restore!, branch: teardown.branch ?? lane.branch, ...(teardown.dropBranch ? { landed: true } : {}) };
      });
    }
    this.ctx.event(teardown.project, { kind: "slot.heldOpen", slot: teardown.slot ?? "in place", writers: waiting });
    return undefined;
  }

  /** Finishes what a seat's own turn was holding up, once nothing else is writing in that copy. */
  async stopped(agentId: string): Promise<void> {
    for (const project of this.ctx.projects.values()) {
      await this.finish(project, (id) => id === agentId);
    }
  }

  /** A writer that is no longer a seat has stopped for good: after an archive, crash or restart its turn-end never comes. */
  reap(project: Project, live: Set<string>): Promise<void> {
    return this.finish(project, (id) => !live.has(id));
  }

  private async finish(project: Project, stopped: (agentId: string) => boolean): Promise<void> {
    for (const lane of Object.values(loadLedger(project.state).lanes)) {
      if (!lane.restoring) continue;
      const waiting = lane.restoring.writers;
      const left = waiting.filter((id) => !stopped(id));
      // A record with nobody left to wait for is a restore that did not happen, retried each time.
      if (waiting.length > 0 && left.length === waiting.length) continue;
      if (left.length > 0) {
        await this.ctx.ledger(project, (ledger) => {
          const entry = ledger.lanes[lane.id];
          if (entry?.restoring) entry.restoring.writers = left;
        });
        continue;
      }
      // The record goes only once the copy is really back: it is the only token a later round can retry from.
      if (!(await this.restore(project, lane.restoring!.base, lane.restoring!.branch))) continue;
      if (lane.restoring!.landed) await this.dropLanded(project, lane.restoring!.branch, landedRef(lane.id));
      await this.ctx.ledger(project, (ledger) => {
        const entry = ledger.lanes[lane.id];
        if (entry) delete entry.restoring;
      });
    }
    for (const slot of Object.values(loadLedger(project.state).slots)) {
      const waiting = slot.releasing?.writers ?? [];
      const left = waiting.filter((id) => !stopped(id));
      if (waiting.length === 0 || left.length === waiting.length) continue;
      if (left.length > 0) {
        await this.ctx.ledger(project, (ledger) => {
          const entry = ledger.slots[slot.id];
          if (entry?.releasing) entry.releasing.writers = left;
        });
        continue;
      }
      await this.release(project, slot.id, slot.releasing?.dropBranch, slot.releasing?.into);
    }
  }

  private run(teardown: Teardown): Promise<string | undefined> {
    if (teardown.slot) return this.release(teardown.project, teardown.slot, teardown.dropBranch, teardown.into);
    if (teardown.restore) {
      // Recorded as a wait for nobody when it fails, so the round retries it and Detach sees it.
      return this.restore(teardown.project, teardown.restore, teardown.branch).then(async (back) => {
        if (back && teardown.dropBranch && teardown.into) await this.dropLanded(teardown.project, teardown.dropBranch, teardown.into);
        if (back || !teardown.lane) return undefined;
        await this.ctx.ledger(teardown.project, (ledger) => {
          const lane = ledger.lanes[teardown.lane!];
          if (lane) lane.restoring = { writers: [], base: teardown.restore!, branch: teardown.branch ?? lane.branch, ...(teardown.dropBranch ? { landed: true } : {}) };
        });
        return undefined;
      });
    }
    return Promise.resolve(undefined);
  }

  /** Returns the branch it kept because its work is not in `into` yet. `into` must be named: `branch -d` checks against whatever is checked out. */
  async release(project: Project, slotId: string | undefined, dropBranch?: string, into?: string): Promise<string | undefined> {
    if (!slotId) return undefined;
    const slot = loadLedger(project.state).slots[slotId];
    let kept: string | undefined;
    if (slot) {
      this.unindex(project, slot);
      if (existsSync(slot.path)) {
        await git(slot.path, ["switch", "--detach"]);
        await removeWorktree(project.root, slot.path);
        // And the directory the desk made: git leaves one often enough, and nothing else reliably sweeps it.
        this.discard(project, slot.path);
      }
      // A branch whose commits are not in `into` holds the only copy of that work: clutter is cheaper.
      if (dropBranch) {
        const landed = into ? (await contains(project.root, into, dropBranch)) === true : false;
        if (landed) await git(project.root, ["branch", "-D", dropBranch]);
        else kept = dropBranch;
      }
      if (slot.workspaceId) {
        try {
          await this.workspaces.archive(slot.workspaceId);
        } catch (error) {
          this.ctx.log(project, `workspace ${slot.workspaceId} could not be put away: ${errorText(error)}`);
        }
      }
    }
    await this.drop(project, slotId);
    this.ctx.event(project, { kind: "slot.released", slot: slotId, removed: Boolean(slot), kept });
    return kept;
  }

  private reserve(project: Project, holder: Holder): Promise<Slot> {
    return this.ctx.ledger(project, (ledger) => {
      const free = Object.values(ledger.slots)
        .filter((slot) => !slot.lane && !slot.task)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (free) {
        Object.assign(free, holder);
        return { ...free };
      }
      const id = nextSlotId(ledger);
      const slot: Slot = { id, path: join(worktreeRoot(), project.slug, id), createdAt: Date.now(), ...holder };
      ledger.slots[id] = slot;
      return { ...slot };
    });
  }

  private async checkOut(project: Project, slot: Slot, branch: string, base: string): Promise<boolean> {
    if (!(await branchExists(project.root, base))) throw new Error(`the base branch ${base} does not exist`);
    if (await branchExists(project.root, branch)) throw new Error(`the branch ${branch} already exists`);
    if (existsSync(join(slot.path, ".git"))) {
      const held = await workState(slot.path);
      if (held !== "clean") throw new Error(held === "dirty" ? `working copy ${slot.id} has uncommitted changes` : `git could not read working copy ${slot.id} at ${slot.path}`);
      const run = await git(slot.path, ["switch", "-c", branch, base]);
      if (run.code !== 0) throw new Error(run.stderr.trim() || "git switch failed");
      return true;
    }
    mkdirSync(dirname(slot.path), { recursive: true });
    const added = await addWorktree(project.root, slot.path, branch, base);
    if (!added.ok) throw new Error(added.message);
    return false;
  }

  /** Files the copy under its project: given a bare directory Paseo makes a new project, and the plugin API cannot remove one. */
  private async createWorkspace(project: Project, slot: Slot): Promise<string> {
    const home = await this.projectWorkspace(project);
    if (!home.project) throw new Error(`the project's workspace in Paseo names no Paseo project, so its working copy was not made: Paseo would have made it a project of its own`);
    const { id: workspaceId } = await this.workspaces.make(`${project.slug} ${slot.id}`, slot.path, home.project);
    await this.ctx.ledger(project, (ledger) => {
      const entry = ledger.slots[slot.id];
      if (entry) entry.workspaceId = workspaceId;
    });
    return workspaceId;
  }

  /** What the desk opened and nothing holds any more. Liveness is read under the ledger lock when used: `reserve` writes its row before `git worktree add`. */
  async sweep(project: Project, busy = false): Promise<void> {
    const heldIds = (ledger: Ledger): Set<string> => {
      const held = new Set<string>();
      for (const slot of Object.values(ledger.slots)) if (slot.workspaceId) held.add(slot.workspaceId);
      for (const lane of Object.values(ledger.lanes)) if (lane.status === "open" && lane.workspaceId) held.add(lane.workspaceId);
      return held;
    };
    for (const workspace of await this.workspaces.owned(project.slug)) {
      if (busy && workspace.name === project.slug) continue;
      if (await this.ctx.read(project, (current) => heldIds(current).has(workspace.id))) continue;
      try {
        await this.workspaces.archive(workspace.id);
        this.ctx.event(project, { kind: "workspace.swept", workspace: workspace.id, name: workspace.name });
      } catch (error) {
        this.ctx.log(project, `workspace ${workspace.name} could not be swept: ${errorText(error)}`);
      }
    }
    const root = join(worktreeRoot(), project.slug);
    if (!root.startsWith(worktreeRoot()) || !existsSync(root)) return;
    // Read and listed inside the lock; removal outside it is safe because a slot id is never handed out twice.
    const live = (current: Ledger) => new Set(Object.values(current.slots).map((slot) => slot.path));
    const strays = await this.ctx.read(project, (current) => {
      const held = live(current);
      return readdirSync(root)
        .map((name) => join(root, name))
        .filter((path) => !held.has(path));
    });
    for (const path of strays) {
      // Asked again just before, for a row reserved for a path from before ids stopped being reused.
      if (await this.ctx.read(project, (current) => live(current).has(path))) continue;
      await removeWorktree(project.root, path);
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {}
      this.ctx.event(project, { kind: "worktree.swept", path });
    }
    try {
      if (readdirSync(root).length === 0) rmdirSync(root);
    } catch {}
  }

  /** Removes a path the desk made under its own worktree root, and the project's folder once empty. */
  private discard(project: Project, path: string): void {
    const root = join(worktreeRoot(), project.slug);
    if (!path.startsWith(`${root}/`)) return;
    try {
      rmSync(path, { recursive: true, force: true });
      if (readdirSync(root).length === 0) rmdirSync(root);
    } catch {}
  }

  private free(project: Project, slotId: string): Promise<void> {
    return this.ctx.ledger(project, (ledger) => {
      const entry = ledger.slots[slotId];
      if (entry) {
        delete entry.lane;
        delete entry.task;
      }
    });
  }

  private drop(project: Project, slotId: string): Promise<void> {
    return this.ctx.ledger(project, (ledger) => {
      delete ledger.slots[slotId];
    });
  }

  /** Each copy `index` opened got a window of its own in the IDE, and nothing closed one. */
  private unindex(project: Project, slot: Slot): void {
    for (const index of this.ctx.indexes(project)) {
      void index.close(slot.path).then(
        (result) => this.ctx.event(project, { kind: "index.closed", server: index.id, slot: slot.id, ok: result.ok, detail: clip(result.text, 200) }),
        (error) => this.ctx.event(project, { kind: "index.closed", server: index.id, slot: slot.id, ok: false, detail: clip(errorText(error), 200) }),
      );
    }
  }

  private index(project: Project, slot: Slot, reused: boolean): void {
    for (const index of this.ctx.indexes(project)) {
      for (const pattern of index.gitExclude) excludeFromGit(project.root, pattern);
      const work = index.open(slot.path).then((opened) => (opened.ok && reused ? index.sync(slot.path) : opened));
      void work.then((result) => this.ctx.event(project, { kind: "index.opened", server: index.id, slot: slot.id, reused, ok: result.ok, detail: clip(result.text, 200) }));
    }
  }
}
