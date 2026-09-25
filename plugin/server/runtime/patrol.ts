import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Kit, can, roleNamed, seatOf } from "../catalog/kit.ts";
import { watchOn } from "../catalog/team.ts";
import type { SeatView, Seats } from "../core/ports.ts";
import { digestOf } from "../desk/checkpoints.ts";
import type { Desk } from "../desk/desk.ts";
import { loadIncidents, openFor, saidBefore } from "../desk/incidents.ts";
import { type Ask, type Ledger, activeTasks, loadLedger, openAsksFrom } from "../desk/ledger.ts";
import { letters } from "../desk/letters.ts";
import { type Project, loadConfig, projectOf } from "../desk/project.ts";
import { statusText } from "../desk/status.ts";
import { laneReports } from "./landing.ts";
import { type Outbox, busy } from "./outbox.ts";
import type { TeamSource } from "./team-source.ts";
import type { TurnRules } from "./turns.ts";
import { deskFacts } from "./watch/history.ts";
import { decide } from "./watch/findings.ts";
import type { Reader } from "./watch/seat/reader.ts";
import type { Watches } from "./watch/watches.ts";

type SeatMap = Map<string, SeatView>;

export type PatrolDeps = {
  kit: Kit;
  source: TeamSource;
  desk: Desk;
  seats: Seats;
  outbox: Outbox;
  turns: TurnRules;
  watches: Watches;
  reader: Reader;
  remember: (project: Project) => void;
};

export class Patrol {
  private readonly deps: PatrolDeps;
  private readonly idleFlag = new Map<string, string>();
  private readonly goneFlag = new Set<string>();
  private readonly digested = new Set<string>();
  private reaped = false;
  private round: Promise<void> | undefined;

  constructor(deps: PatrolDeps) {
    this.deps = deps;
  }

  /** One round at a time: the runtime arms the next timer without awaiting this one, and overlapping rounds double-wrote the ledger. */
  tick(now = Date.now()): Promise<void> {
    const running = this.round;
    if (running) return running;
    const run = this.runRound(now).finally(() => {
      if (this.round === run) this.round = undefined;
    });
    this.round = run;
    return run;
  }

  private async runRound(now: number): Promise<void> {
    const { kit, desk, outbox } = this.deps;
    const seats: SeatMap = new Map((await this.deps.seats.open()).map((seat) => [seat.id, seat]));
    this.deps.watches.sync(seats.values());
    this.deps.watches.round(now, (watch) => this.deps.source.teamFor(projectOf(watch.seat.cwd)).attention.longTurnMinutes);
    this.deps.reader.keep(new Set([...seats.values()].filter((seat) => !seat.archivedAt).map((seat) => seat.id)));
    for (const seat of seats.values()) if (seatOf(kit, seat.provider)?.role.tools && !can(seatOf(kit, seat.provider)?.role, "supervise")) this.deps.remember(projectOf(seat.cwd));
    for (const project of desk.projects.values()) {
      // Written to, a project removed while the plugin runs would come back as a state directory of its own.
      if (!this.deps.source.onRecord(project)) {
        desk.projects.delete(project.slug);
        continue;
      }
      await this.step(project, "idle lanes could not be read", () => this.idleLanes(project, loadLedger(project.state), seats, now));
      await this.step(project, "incidents held for nobody or for the sensor could not be told", async () => void (await desk.retell(project)));
      await this.step(project, "a task whose Peer is gone could not be recorded", () => this.goneTasks(project, loadLedger(project.state), seats));
      await this.step(project, "a lane whose Lead is gone could not be told", () => this.goneLeads(project, loadLedger(project.state), seats));
      await this.step(project, "what the checkpoints' logs show could not be told", () => this.digest(project, now));
      await this.step(project, "asks due a reminder could not be sent", () => this.dueAsks(project, loadLedger(project.state), seats, now));
      await this.step(project, "what a lane's history shows could not be read", () => this.history(project, loadLedger(project.state), seats));
      await this.step(project, "the Watcher could not be settled", () => this.settleWatcher(project, loadLedger(project.state), seats));
      await this.step(project, "sweeping failed", () => this.sweep(project, loadLedger(project.state), seats));
      await this.step(project, "waiting lanes could not be opened", () => desk.openWaiting(project));
      // An empty listing is a daemon that answered nothing, not a project whose every seat is gone.
      if (seats.size > 0) await this.step(project, "finished lanes could not be archived", () => desk.archiveFinished(project, (id) => !seats.has(id) && outbox.pending(id).length === 0));
      await this.step(project, "a copy waiting on a seat could not be put away", () => desk.reapSlots(project, new Set(seats.keys())));
      await this.step(project, "the status page could not be written", async () => this.writeStatus(project, seats, now));
    }
    // A restart loses teardowns waiting on a turn, so the first round looks once at every project on record.
    if (!this.reaped) {
      this.reaped = true;
      const live = new Set(seats.keys());
      for (const project of this.deps.source.known()) {
        if (desk.projects.has(project.slug)) continue;
        await this.step(project, "a copy left behind by a restart could not be put away", () => desk.reapSlots(project, live));
      }
    }
    const targets = new Set(outbox.letters().map((letter) => letter.to));
    for (const to of targets) {
      try {
        await outbox.pump(to);
      } catch (error) {
        console.error(`seatworks-v2: mail for ${to} could not be delivered:`, error);
      }
    }
  }

  /** One project's round is made of steps, and a step that fails is the only thing that fails. */
  private async step(project: Project, what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      console.error(`seatworks-v2: ${project.slug}: ${what}:`, error);
    }
  }

  /** One Watcher while watched by seat with a lane open; a spent one is replaced once idle, before compaction erodes it. */
  private async settleWatcher(project: Project, ledger: Ledger, seats: SeatMap): Promise<void> {
    const { desk, outbox, reader } = this.deps;
    const attention = this.deps.source.teamFor(project).attention;
    const wanted = attention.by === "seat" && Object.values(ledger.lanes).some((lane) => lane.status === "open");
    const watchers = desk.watchers(project, seats.values());
    const kept = wanted ? watchers[0] : undefined;
    for (const seat of watchers) if (seat !== kept) await desk.archive(seat.id);
    if (!wanted) return;
    if (!kept) {
      await desk.seatWatcher(project);
      return;
    }
    if (reader.readings(kept.id) >= attention.watcherRotateAfter && !busy(kept.status) && outbox.pending(kept.id).length === 0) {
      await desk.archive(kept.id);
      desk.event(project, { kind: "watcher.rotated", agent: kept.id, readings: reader.readings(kept.id) });
    }
  }

  private async sweep(project: Project, ledger: Ledger, seats: SeatMap): Promise<void> {
    const busy =
      Object.values(ledger.lanes).some((lane) => lane.status === "open") ||
      [...seats.values()].some((seat) => seatOf(this.deps.kit, seat.provider)?.role.tools && projectOf(seat.cwd).slug === project.slug);
    await this.deps.desk.sweep(project, busy);
  }

  /** Desk-record facts about a lane, filed against its Lead in the same incident book the watch uses. */
  private async history(project: Project, ledger: Ledger, seats: SeatMap): Promise<void> {
    const team = this.deps.source.teamFor(project);
    // Same switch as the followed seats: with the watch off the lane history is not read either.
    if (!watchOn(team)) return;
    const attention = team.attention;
    const found = deskFacts(ledger, { reworksAt: attention.reworksAt, reviewsAt: attention.reviewsAt });
    if (found.length === 0) return;
    const book = loadIncidents(project.state);
    for (const seen of found) {
      // A gone seat's incidents closed when it went; raising one leaves a sighting nothing closes.
      const seat = seats.get(seen.seat);
      if (!seat || seat.archivedAt) continue;
      // Still open: sight it again so today's settings reweigh it. Settled: nothing new until the record changes.
      const open = openFor(book, seen.seat, seen.fact.kind);
      if (!open && saidBefore(book, seen.seat, seen.fact.kind, seen.fact.quote)) continue;
      if (open && open.quote === seen.fact.quote && open.told !== undefined) continue;
      await this.deps.desk.notice(project, { id: seen.seat, provider: seat.provider, title: seat.title }, decide([seen.fact]));
    }
  }

  private async idleLanes(project: Project, ledger: Ledger, seats: SeatMap, now: number): Promise<void> {
    const { desk, turns } = this.deps;
    const { leadIdleMinutes } = this.deps.source.teamFor(project).attention;
    let reports: Map<string, { ready: boolean }> | undefined;
    for (const lane of Object.values(ledger.lanes).filter((entry) => entry.status === "open" && entry.lead)) {
      const lead = seats.get(lane.lead!);
      if (!lead || lead.status !== "idle") continue;
      const idle = now - Date.parse(lead.updatedAt);
      if (idle < leadIdleMinutes * 60_000 || this.idleFlag.get(lead.id) === lead.updatedAt) continue;
      if (activeTasks(ledger, lane.id).length > 0 || openAsksFrom(ledger, lead.id).length > 0) continue;
      // A Lead that reported its lane ready is waiting for the Human's approval, not stalled.
      if ((reports ??= laneReports(project.state)).get(lane.id)?.ready) continue;
      const to = await desk.supervisorFor(project, lane.opener);
      const posted = await desk.post(to, `idle:${project.slug}:${lane.id}:${lead.updatedAt}`, letters.laneIdle(lane, Math.round(idle / 60_000), turns.lastEnding.get(lead.id) ?? ""), project);
      // Noted as told only when somebody was: set first, a notice to nobody was never tried again.
      if (posted !== "nobody") this.idleFlag.set(lead.id, lead.updatedAt);
    }
  }

  private async goneTasks(project: Project, ledger: Ledger, seats: SeatMap): Promise<void> {
    const { desk } = this.deps;
    for (const task of Object.values(ledger.tasks).filter((entry) => ["running", "rework"].includes(entry.status) && entry.peer)) {
      const gone = `${project.slug}:${task.id}`;
      if (seats.has(task.peer!) || this.goneFlag.has(gone)) continue;
      this.goneFlag.add(gone);
      await desk.setTask(project, task.id, (entry) => {
        entry.status = "stalled";
        entry.peerGone = true;
      });
      await desk.post(ledger.lanes[task.lane]?.lead, `gone:${project.slug}:${task.id}`, letters.failed(`the Peer on ${task.id} (${task.title})`, "its agent was closed or archived"), project);
    }
  }

  /** Nothing restarts a lane whose Lead went, so whoever supervises is told once per Lead; an empty listing tells nothing. */
  /** Told once a round sees a check turn ready or look rubber-stamped: a digest on a state change, not a page per run. */
  private async digest(project: Project, now: number): Promise<void> {
    const checks = this.deps.source.teamFor(project).checkpoints;
    for (const checkpoint of ["plan", "land"] as const) {
      const { lines, state } = digestOf(project, checkpoint, checks.forced ? "on" : checks[checkpoint], now);
      const key = `${project.slug}:${checkpoint}:${state}`;
      if (!state || this.digested.has(key)) continue;
      const posted = await this.deps.desk.post(await this.deps.desk.supervisorFor(project), `digest:${key}`, letters.checkDigest(checkpoint, state, lines), project);
      if (posted !== "nobody") this.digested.add(key);
    }
  }

  private async goneLeads(project: Project, ledger: Ledger, seats: SeatMap): Promise<void> {
    const { desk } = this.deps;
    if (seats.size === 0) return;
    for (const lane of Object.values(ledger.lanes).filter((entry) => entry.status === "open" && entry.lead && !seats.has(entry.lead))) {
      const gone = `${project.slug}:${lane.id}:${lane.lead}`;
      if (this.goneFlag.has(gone)) continue;
      const posted = await desk.post(await desk.supervisorFor(project, lane.opener), `leadgone:${gone}`, letters.leadGone(lane), project);
      if (posted !== "nobody") this.goneFlag.add(gone);
    }
  }

  private async dueAsks(project: Project, ledger: Ledger, seats: SeatMap, now: number): Promise<void> {
    const { desk } = this.deps;
    const { askRemindMinutes, maxReminders } = this.deps.source.teamFor(project).attention;
    const waited = (ask: Ask) => now - (ask.remindedAt ?? ask.openedAt) >= askRemindMinutes * 60_000;
    for (const ask of Object.values(ledger.asks).filter((entry) => entry.status === "open")) {
      const lane = ask.lane ? ledger.lanes[ask.lane] : undefined;
      // An ask whose reader has gone goes to whoever supervises now, a Lead's own ask included.
      if (!seats.has(ask.to)) {
        const to = await desk.supervisorFor(project, lane?.opener);
        if (!to || to === ask.to) continue;
        const moved = await desk.ledger(project, (current) => {
          const entry = current.asks[ask.id];
          if (!entry || entry.status !== "open" || entry.to !== ask.to) return undefined;
          entry.to = to;
          entry.remindedAt = now;
          return { ...entry };
        });
        if (moved) await desk.post(to, `ask:${moved.id}:${to}`, letters.askTo(moved, ask.task ? `the Peer on ${ask.task}, whose reader is gone` : `the Lead of ${ask.lane ?? "a lane"}, whose reader is gone`), project);
        continue;
      }
      if (seats.get(ask.to)?.status !== "idle" || !waited(ask)) continue;
      const age = Math.round((now - ask.openedAt) / 60_000);
      const reminding = ask.reminders < maxReminders;
      if (reminding) {
        await desk.post(ask.to, `remind:${project.slug}:${ask.id}:${ask.reminders}`, letters.reminder(ask, age), project);
        // Escalated only from a Lead: an ask already put to the supervisor has nowhere further up.
      } else if (ask.to === lane?.lead && !can(roleNamed(this.deps.kit, ask.fromRole), "lead") && !ask.escalated) {
        const to = await desk.supervisorFor(project, lane?.opener);
        // Marked escalated only once delivered; with nobody seated it is retried next round.
        if ((await desk.post(to, `escalate:${project.slug}:${ask.id}`, letters.escalated(ask, age, ask.lane ?? "the project"), project)) === "nobody") continue;
      } else continue;
      // Pinned to this round's count so overlapping rounds cannot push it past the owner's maximum.
      await desk.ledger(project, (current) => {
        const entry = current.asks[ask.id];
        if (!entry || entry.reminders !== ask.reminders) return;
        if (reminding) entry.reminders += 1;
        else entry.escalated = true;
        entry.remindedAt = now;
      });
    }
  }

  private writeStatus(project: Project, seats: SeatMap, now: number): void {
    const { kit } = this.deps;
    const waiting = [...seats.values()].filter(
      (seat) => can(seatOf(kit, seat.provider)?.role, "supervise") && projectOf(seat.cwd).slug === project.slug && (seat.pendingPermissions?.length ?? 0) > 0,
    );
    mkdirSync(project.state, { recursive: true });
    const held = this.deps.outbox.letters();
    writeFileSync(join(project.state, "status.md"), statusText(project, loadLedger(project.state), loadConfig(project.state), seats, now, { waiting, held, checks: this.deps.source.teamFor(project).checkpoints }));
  }
}
