import type { Kit, SensorSpec } from "../catalog/kit/kit.ts";
import type { Team } from "../catalog/team/team.ts";
import { KeyedQueue } from "../core/keyed-queue.ts";
import { errorText } from "../core/errors.ts";
import { recordSpend, tellPastAppetite } from "./seats/spend.ts";
import { MachineHold } from "./machine/hold.ts";
import { dueAsks } from "./messaging/due-asks.ts";
import { type WorkerTurn, workerEnded } from "./tasks/silence.ts";
import { Limiter } from "../core/limiter.ts";
import { daemonLog } from "../core/logger.ts";
import {
  type CodeIndex,
  type Judge,
  type Mailer,
  type Posted,
  type SeatView,
  type Seats,
  type Workspaces,
  midTurn,
} from "../core/ports.ts";
import { join } from "node:path";
import { stateRoot } from "../core/paths.ts";
import { type Fact, type Finding, findingsOf } from "../domain/incident.ts";
import type { DeskBase } from "./base.ts";
import { ToolCalls } from "./calls/tool-calls.ts";
import { Claims } from "./claims.ts";
import type { ToolReply, ToolRequest } from "./context.ts";
import { OwnCopy } from "./copies/own-copy.ts";
import { Slots } from "./copies/slots.ts";
import { Human } from "./human/human.ts";
import { type Letter } from "./letters/envelope.ts";
import { callLetters } from "./letters/call-letters.ts";
import type { Project } from "./project/project.ts";
import { Agents } from "./seats/agents.ts";
import { markGone } from "./seats/gone.ts";
import { leadLost, peerLost } from "./seats/lost.ts";
import { reapKept } from "./seats/kept.ts";
import { Roster } from "./seats/roster.ts";
import { Teardowns } from "./seats/teardown.ts";
import { turnsEnded } from "./seats/turn-ends.ts";
import { orderKey } from "./lanes/land-order.ts";
import type { DeskServices, ToolDef } from "./services.ts";
import { archiveFinished } from "./store/archive.ts";
import { recordEvent } from "./store/event-log.ts";
import type { DeskEvent } from "./store/events.ts";
import { IncidentStore } from "./store/incident-store.ts";
import { Intents } from "./store/intents.ts";
import type { Lane } from "../domain/lane.ts";
import type { Ledger } from "../domain/ledger.ts";
import type { Task } from "../domain/task.ts";
import { loadLedger } from "./store/ledger.ts";
import { LedgerStore } from "./store/ledger-store.ts";
import { tidyRecords } from "./store/records.ts";
import { MergeQueue } from "./tasks/merge-queue.ts";
import { openWaiting } from "./waiting/lanes.ts";
import { startWaiting } from "./waiting/tasks.ts";
import { type Moment, momentCases } from "./review/evidence.ts";
import { judge } from "./review/asking.ts";
import { type Look, lateCase, readLook } from "./watch/brains.ts";
import { type Noticed, closeIncidentsOf, notice, placeOf, retell } from "./watch/notice.ts";
import { Decisions } from "./watch/decisions.ts";
import { Watcher } from "./watch/watcher.ts";

type DeskOptions = {
  kit: Kit;
  tools: ToolDef[];
  outbox: Mailer;
  seats: Seats;
  workspaces: Workspaces;
  log: (project: Project, line: string) => void;
  teamFor: (project?: Project) => Team;
  indexesFor?: (project: Project) => CodeIndex[];
  sensor?: (spec: SensorSpec, key: string) => Judge;
};

/** The desk: it builds the services every tool and flow shares, and is what the runtime, hooks and panel call. */
export class Desk {
  readonly projects: Map<string, Project>;
  readonly human: Human;
  readonly watcher: Watcher;
  private readonly services: DeskServices;
  private readonly intents: Intents;
  private readonly calls: ToolCalls;
  private readonly stop = new AbortController();

  constructor(options: DeskOptions) {
    const projects = new Map<string, Project>();
    const touched = (project: Project) => {
      projects.set(project.slug, project);
    };
    // A measurement holds the machine: meanwhile no gate or setup starts on any of its projects.
    const machine = new MachineHold();
    const base: DeskBase = {
      kit: options.kit,
      projects,
      ledgers: new LedgerStore(touched),
      incidents: new IncidentStore(touched),
      mail: {
        post: async (to, letter) => (to ? options.outbox.post({ to, ...letter }) : "nobody"),
        withdraw: (to, key) => options.outbox.withdraw(to, key),
      },
      log: options.log,
      teamFor: options.teamFor,
      indexesFor: options.indexesFor ?? (() => []),
      sensorFor: (spec, key) => options.sensor?.(spec, key),
      seating: new Claims(),
      closing: new Claims(),
      landings: new KeyedQueue(),
      gates: new Limiter(() => (machine.held() ? 0 : options.teamFor().gatesAtOnce)),
      machine,
      stopping: this.stop.signal,
    };
    this.intents = new Intents(join(stateRoot(), "intents.json"));
    const roster = new Roster(options.kit, options.seats, this.intents);
    const slots = new Slots(base, options.workspaces);
    const ownCopy = new OwnCopy(base, slots);
    const teardowns = new Teardowns(base, slots, ownCopy);
    const agents = new Agents(base, roster, slots, teardowns, options.workspaces);
    this.watcher = new Watcher(base, roster, agents);
    const merges = new MergeQueue(base, (project) => startWaiting(this.services, project, true));
    const decisions = new Decisions(options.kit);
    this.services = { ...base, roster, slots, ownCopy, teardowns, agents, merges, watcher: this.watcher, decisions };
    this.calls = new ToolCalls(this.services, options.tools, this.intents);
    this.watcher.settleLate((project, kept, outcome) => {
      lateCase(this.services, project, kept, outcome).catch((error) =>
        daemonLog.error(`${project.slug}: a case taken up after a restart could not be settled:`, error),
      );
    });
    this.projects = projects;
    this.human = new Human(this.services);
  }

  /** Once the merges and ordered landings under way for the project have run, and its decisions' records been read. */
  async settled(project: Project): Promise<void> {
    await this.calls.settled(project);
    await this.services.merges.settled(project);
    await this.services.landings.idle(orderKey(project));
  }

  event(project: Project, data: DeskEvent): void {
    recordEvent(project, data);
  }

  notice(project: Project, seat: Noticed, findings: Finding[]): ReturnType<typeof notice> {
    return notice(this.services, project, seat, findings);
  }

  /** What the code saw in a seat's turn: its facts booked for whoever supervises, and the moment asked about as review's evidence. */
  saw(project: Project, seat: Noticed, facts: Fact[], moment: Omit<Moment, "facts">): ReturnType<typeof notice> {
    const place = placeOf(this.services.kit, project, seat);
    for (const found of momentCases(this.services.kit, place, { ...moment, facts }))
      void judge(this.services, project, found);
    return notice(this.services, project, seat, findingsOf(facts), place);
  }

  async look(project: Project, seat: Noticed, look: Look): Promise<void> {
    try {
      await readLook(this.services, project, seat, look);
    } catch (error) {
      daemonLog.error(`${project.slug}: the watch's brains could not read ${seat.id}:`, error);
    }
  }

  retell(project: Project): Promise<string[]> {
    return retell(this.services, project);
  }

  archived(project: Project, seat: string, watched: boolean): void {
    markGone(this.services, project, seat);
    try {
      this.services.decisions.forget(project, seat);
    } catch (error) {
      this.services.log(project, `pending watch decisions for ${seat} could not be forgotten: ${errorText(error)}`);
    }
    if (watched) closeIncidentsOf(this.services, project, seat);
  }

  post(to: string | undefined, letter: Letter): Promise<Posted | "nobody"> {
    return this.services.mail.post(to, letter);
  }

  supervisorFor(project: Project, preferred?: string): Promise<string | undefined> {
    return this.services.roster.supervisorFor(project, preferred);
  }

  readerOf(project: Project, lane: Lane | undefined): ReturnType<Roster["readerOf"]> {
    return this.services.roster.readerOf(project, lane);
  }

  archive(agentId: string | undefined, force = false): Promise<void> {
    return this.services.roster.archive(agentId, force);
  }

  archiving(agentId: string): boolean {
    return this.services.roster.archiving(agentId);
  }

  stopped(agentId: string): Promise<void> {
    return turnsEnded(this.services, (id) => id === agentId);
  }

  /**
   * The first round after a start. The turns that ended while the plugin was down end now, so what waited on them goes
   * on, and an answer promised as mail that the stop lost is owned up to.
   */
  async resume(listed: Map<string, SeatView>): Promise<void> {
    await this.services.roster.archiveWaiting(listed);
    await turnsEnded(this.services, (id) => !midTurn(listed.get(id)?.status));
    for (const promised of this.intents.promised()) {
      if (listed.has(promised.agent)) await this.services.mail.post(promised.agent, callLetters.unanswered(promised));
      this.intents.kept(promised);
    }
  }

  resumeMerges(project: Project): Promise<void> {
    return this.services.merges.resume(project);
  }

  reapSlots(project: Project, live: Set<string>): Promise<void> {
    return reapKept(this.services, project, live);
  }

  /** Asks left waiting: a reader gone, a Lead's ask past its lapse, and asks their reader or both sides sit on. */
  dueAsks(
    project: Project,
    ledger: Ledger,
    seats: Map<string, SeatView>,
    now: number,
    missingOf: (ids: string[]) => Promise<Set<string>>,
  ): Promise<void> {
    return dueAsks(this.services, project, ledger, seats, now, missingOf);
  }

  peerLost(project: Project, ledger: Ledger, task: Task): Promise<void> {
    return peerLost(this.services, project, ledger, task);
  }

  leadLost(project: Project, lane: Lane): Promise<boolean> {
    return leadLost(this.services, project, lane);
  }

  workerEnded(project: Project, ledger: Ledger, turn: WorkerTurn): Promise<void> {
    return workerEnded(this.services, project, ledger, turn);
  }

  recordSpend(project: Project, seats: Iterable<SeatView>): void {
    recordSpend(this.services, project, seats);
  }

  /** A hold on the machine past its time is let go, and what waited on it starts. */
  machineTick(now = Date.now()): void {
    if (this.services.machine.expire(now)) this.services.gates.admit();
  }

  pastAppetite(project: Project): Promise<void> {
    return tellPastAppetite(this.services, project);
  }

  /** The patrol's net under a close or accept that never started what waited on it; a failed start waits for more. */
  async openWaiting(project: Project): Promise<void> {
    await openWaiting(this.services, project, false);
    await startWaiting(this.services, project, false);
  }

  async archiveFinished(project: Project, gone: (agentId: string) => boolean): Promise<void> {
    archiveFinished(this.services, project, gone);
  }

  async sweep(project: Project, busy = false): Promise<void> {
    await this.services.slots.sweep(project, busy);
    const dropped = tidyRecords(project.state, loadLedger(project.state));
    if (dropped.length > 0) recordEvent(project, { kind: "records.tidied", files: dropped.length });
  }

  inFlight(agentId: string): boolean {
    return this.calls.inFlight(agentId);
  }

  answer(request: ToolRequest, options?: Parameters<ToolCalls["answer"]>[1]): Promise<ToolReply> {
    return this.calls.answer(request, options);
  }

  mailLost(request: ToolRequest, reply: ToolReply): Promise<unknown> {
    return this.calls.mailLost(request, reply);
  }

  /** The plugin stops: gates still running are killed with their process groups, not left writing into a copy. */
  dispose(): void {
    this.stop.abort();
  }
}
