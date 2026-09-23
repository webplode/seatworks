import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHookContext, PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";
import { renderPrompt } from "../catalog/content.ts";
import { type Kit, type RoleSpec, can, seatOf } from "../catalog/kit.ts";
import { type Listed, type ModelCache, applyModels, fetchModels, listingProviders } from "../catalog/models.ts";
import { type AgentConfig, type SessionOpen, applyRole, seatEnv } from "../catalog/launch.ts";
import { applyReconcile, reloadDaemon } from "../catalog/providers.ts";
import { placeProjectFiles } from "../catalog/project-files.ts";
import { placeGuides, seatDir, seedRecords, sweepSnapshots } from "../catalog/seats.ts";
import { stampKit } from "../upkeep/migrate.ts";
import { type StateReport, upgradeState } from "../upkeep/state.ts";
import { type IndexedProxy, type Team, indexedProxies, jevOn, watchOn } from "../catalog/team.ts";
import { guidesDir, home, nodeBin, outboxPath, spoolDir, stateRoot } from "../core/paths.ts";
import { type AgentReload, type FolderSearch, activityOn, agentReload, connectLocal, folderSearch, inventoryOn, seatsOn, workspacesOn } from "../core/paseo-adapter.ts";
import type { PaseoApi } from "../core/paseo.ts";
import type { SeatView, Seats, Workspaces } from "../core/ports.ts";
import type { CodeIndex } from "../desk/context.ts";
import { Desk } from "../desk/desk.ts";
import { type Ledger, type Sibling, alongside, laneOfLead, loadLedger, openAsksTo, taskOfPeer } from "../desk/ledger.ts";
import { letters } from "../desk/letters.ts";
import { appendRecord } from "../desk/records.ts";
import { type Project, gateCommands, loadConfig, projectOf } from "../desk/project.ts";
import { SettingsControl } from "./control.ts";
import { codeIndex } from "./code-index.ts";
import { type Letter, Outbox } from "./outbox.ts";
import { Patrol } from "./patrol.ts";
import { Relink, reloadPlugin } from "./relink.ts";
import { registerRpc } from "./rpc.ts";
import { Seating } from "./seating.ts";
import { spoolDirs, takeRequests, writeReply } from "./spool.ts";
import { TeamSource } from "./team-source.ts";
import { TurnRules } from "./turns.ts";
import { FACT_TITLES, type Fact } from "./watch/facts.ts";
import { type Finding, type Verdict, decide } from "./watch/findings.ts";
import { weigh } from "./watch/jev/rules.ts";
import { keepAssessment, lastKept, readTally } from "./watch/jev/assessments.ts";
import { Assessor, type Reading, type SensorError, type Sensing } from "./watch/jev/sensor.ts";
import { stepText } from "./watch/trail.ts";
import { type SeatContext, type SeatWatch, type WatchedSeat, Watches } from "./watch/watches.ts";
import { Reader } from "./watch/seat/reader.ts";
import { malformed } from "./timeline.ts";
import { loadIncidents } from "../desk/incidents.ts";
import type { WatchLean, WatchView } from "../../shared/views.ts";
import { errorText } from "../core/errors.ts";
import { Supervision } from "./supervision.ts";
import { SupervisionControl } from "./supervision-control.ts";
import { supervisionRpc, bindingRpc, adoptRpc, createSupervisorRpc } from "../../shared/rpc.ts";
import { CommunicationWatch } from "./watch/jev/communication.ts";
import { briefRpc, commitTeamFilesRpc, reloadSupervisorRpc } from "../../shared/brief.ts";

const SIGN_IN_TROUBLE = /not logged in|please run \/login|invalid api key|authentication_error|oauth token has expired|credit balance is too low/i;
import { teamBrief } from "./brief.ts";
import { commitTeamFiles, diffStat, laneReports, uncommittedTeamFiles } from "./landing.ts";
import { outputText } from "./timeline.ts";

type EventName = keyof PluginLifecycleEvents;

const TROUBLES = 10;

const INCIDENTS_SHOWN = 200;

export type RuntimeOptions = { outboxFile?: string; paseo?: PaseoApi; codeIndex?: (proxy: IndexedProxy) => CodeIndex; reloadDaemon?: () => Promise<boolean>; folders?: FolderSearch; reloadAgent?: AgentReload };

export class Runtime {
  readonly kit: Kit;
  readonly outbox: Outbox;
  readonly desk: Desk;
  readonly control: SettingsControl;
  readonly supervision: SupervisionControl;
  private readonly communication: CommunicationWatch;
  private readonly spool = spoolDir();
  private readonly seats: Seats;
  private readonly workspaces: Workspaces;
  private readonly source: TeamSource;
  private readonly seating: Seating;
  private readonly turns: TurnRules;
  private readonly patrol: Patrol;
  private readonly watches: Watches;
  private readonly assessor: Assessor;
  private readonly reader: Reader;
  private readonly sensorNoted = new Map<string, number>();
  private readonly troubles = new Map<string, { kind: string; at: number; detail: string }[]>();
  private readonly offline = new Set<string>();
  private readonly relink = new Relink(reloadPlugin);
  private readonly makeIndex: (proxy: IndexedProxy) => CodeIndex;
  private readonly reload: () => Promise<boolean>;
  private readonly reloadAgent: AgentReload;
  /** The last timeline entry when the Human reloaded an agent: a sign-in failure from before it is history. */
  private readonly reloadedAt = new Map<string, number>();
  private pluginApi: PaseoApi | undefined;
  private briefBusy = false;
  private briefSent = new Map<string, string>();
  private api: PaseoApi | undefined;
  private connection: Awaited<ReturnType<typeof connectLocal>> | undefined;
  private disposed = false;
  private state: StateReport = { upgraded: [], failed: [] };
  private timers: ReturnType<typeof setInterval>[] = [];
  private tick: ReturnType<typeof setTimeout> | undefined;

  constructor(kit: Kit, options: RuntimeOptions = {}) {
    this.kit = kit;
    this.api = options.paseo;
    this.makeIndex = options.codeIndex ?? codeIndex;
    this.reload = options.reloadDaemon ?? reloadDaemon;
    this.reloadAgent = options.reloadAgent ?? agentReload();
    this.seats = seatsOn(() => this.api);
    this.workspaces = workspacesOn(() => this.api);
    this.source = new TeamSource(kit);
    this.seating = new Seating(kit, this.source, { node: nodeBin(), spool: this.spool });
    const supervision = new Supervision(stateRoot());
    this.outbox = new Outbox(
      options.outboxFile ?? outboxPath(),
      (to, list) => this.compose(to, list),
      this.seats,
      (letter, at) =>
        console.error(`seatworks-v2: a letter for ${letter.to} (${letter.key}) was never taken and has been given up on after ${Math.round((at - letter.at) / 3_600_000)} hours`),
      // Never steered into a Watcher's turn: mid-reading, it is read as part of that reading.
      (seat) => {
        const found = seatOf(kit, seat.provider);
        return found?.harness.steers === true && !can(found.role, "watch");
      },
      (letter, seat) => letter.guard ? supervision.validate(letter.guard, seat) : undefined,
    );
    this.supervision = new SupervisionControl({ store: supervision, kit, seats: this.seats, workspaces: this.workspaces,
      outbox: this.outbox, inventory: () => inventoryOn(() => this.api), source: this.source,
      activity: (id, limit) => activityOn(() => this.api, id, limit),
      communication: () => Object.fromEntries(this.communication?.coverage ?? []),
      prepareProviders: async () => { const changed = applyReconcile(this.kit, this.source.teamFor()); if (changed.length && !await this.reload()) throw new Error("Provider configuration was saved but daemon reload failed. Resolve that before creating a Supervisor."); } });
    const log = (project: Project, line: string) => this.log(project, line);
    const remember = (project: Project) => this.remember(project);
    this.desk = new Desk({
      kit,
      supervision: this.supervision,
      outbox: this.outbox,
      seats: this.seats,
      workspaces: this.workspaces,
      log,
      teamFor: (project) => this.source.teamFor(project),
      indexesFor: (project) => this.indexesFor(project),
      sent: (watcher, ref) => this.reader.sent(watcher, ref),
    });
    this.turns = new TurnRules({ kit, desk: this.desk, remember });
    this.communication = new CommunicationWatch(supervision, this.outbox, this.desk, (project) => this.source.teamFor(project));
    this.assessor = new Assessor({
      sensing: (watch) => this.sensing(watch),
      done: (watch, reading) => this.assessed(watch, reading),
      failed: (watch, error) => this.degraded(watch, error),
    });
    this.reader = new Reader({
      pace: (project) => {
        const attention = this.source.teamFor(project).attention;
        if (attention.by !== "seat") return undefined;
        return { quietMs: attention.watcherQuietSeconds * 1000, everyMs: attention.watcherEveryMinutes * 60_000, chars: attention.watcherChars };
      },
      watcher: async (project) => this.desk.watchers(project, await this.seats.open())[0]?.id,
      post: (to, key, text) => this.desk.post(to, key, text),
      judges: kit.watcher?.judges ?? [],
    });
    this.watches = new Watches({
      kit,
      seats: this.seats,
      context: (seat) => this.watchContext(seat),
      found: (watch, facts) => this.watchFound(watch, facts),
      on: (seat) => this.watching(projectOf(seat.cwd)),
      // Each reader answers only where the watch is its own: Jev by jev, the Watcher by a seat.
      moment: (watch, urgent) => {
        this.assessor.moment(watch, urgent);
        this.reader.moment(watch, urgent);
      },
      dropped: (id) => {
        this.assessor.drop(id);
        this.reader.drop(id);
      },
    });
    this.patrol = new Patrol({ kit, source: this.source, desk: this.desk, seats: this.seats, outbox: this.outbox, turns: this.turns, watches: this.watches, reader: this.reader, remember });
    this.control = new SettingsControl({
      kit,
      source: this.source,
      seating: this.seating,
      reconcile: (team) => this.reconcileProviders(team),
      models: () => this.refreshModels(),
      state: () => this.state,
      seats: this.seats,
      held: () => this.outbox.letters(),
      watch: (project, seats) => this.watchView(project, seats),
      folders: options.folders ?? folderSearch(),
      unbind: (root) => {
        const binding = this.supervision.store.read();
        if (!binding.projects.some((p) => p.root === root)) return;
        this.supervision.store.change(binding.revision, (next) => { next.projects = next.projects.filter((p) => p.root !== root); });
      },
    });
  }

  private watchContext(seat: WatchedSeat): SeatContext | undefined {
    const found = seatOf(this.kit, seat.provider);
    if (!found) return undefined;
    const { harness, role } = found;
    const project = projectOf(seat.cwd);
    const attention = this.source.teamFor(project).attention;
    let owned: string[] | undefined;
    let goal: string | null = "";
    // What the Lead asked beyond the goal and what sibling copies write; without them the sensor calls both invention.
    let context = "";
    let beside: Sibling[] = [];
    try {
      const ledger = loadLedger(project.state);
      const task = taskOfPeer(ledger, seat.id);
      const lane = task ? ledger.lanes[task.lane] : laneOfLead(ledger, seat.id);
      owned = task?.owned;
      if (task) {
        goal = [`Task ${task.id}: ${task.title}`, `Goal: ${task.goal}`, `Acceptance: ${task.acceptance.join("; ")}`, `Out of scope: ${task.outOfScope.join("; ")}`].join("\n");
        context = task.context ?? "";
        beside = alongside(ledger, task);
      }
      else if (lane) goal = [`Lane ${lane.id}: ${lane.title}`, `Outcome: ${lane.outcome}`, `Acceptance: ${lane.acceptance.join("; ")}`, `Out of scope: ${lane.outOfScope.join("; ")}`].join("\n");
    } catch (error) {
      goal = null;
      this.desk.event(project, { kind: "watch.unbriefed", agent: seat.id, error: errorText(error) });
    }
    return {
      goal,
      context,
      beside,
      role: [role.label, role.description].filter(Boolean).join(": "),
      rules: {
        destructive: new RegExp(attention.destructive, "i"),
        testPath: new RegExp(attention.testPath, "i"),
        suppressed: new RegExp(attention.suppressed, "i"),
        exit: harness.exitPattern ? new RegExp(harness.exitPattern) : undefined,
        gates: gateCommands(seat.cwd, loadConfig(project.state).gate),
        cwd: seat.cwd,
        temp: tmpdir(),
        owned,
        repeatsAt: attention.repeatsAt,
        recoverWithin: 10,
      },
      heardSince: (at) => {
        try {
          const handback = taskOfPeer(loadLedger(project.state), seat.id)?.handback;
          return Boolean(handback && handback.at >= at && !handback.gate);
        } catch {
          return false;
        }
      },
    };
  }

  /** `attention.by`: by a Watcher seat the watch is always on; by Jev only with a key. */
  private watching(project: Project): boolean {
    return watchOn(this.source.teamFor(project));
  }

  private sensing(watch: SeatWatch): Sensing | undefined {
    const project = projectOf(watch.seat.cwd);
    const team = this.source.teamFor(project);
    const sensor = team.sensor;
    // Between the key being taken away, or the watch going to a Watcher seat, and the round after.
    if (!sensor || !jevOn(team)) return undefined;
    const brief = watch.brief();
    if (!brief || brief.goal === null) return undefined;
    const { goal, context, beside, role, rules } = brief;
    return { spec: sensor.spec, key: sensor.key, brief: { goal, context, beside, role, gates: rules.gates, workingCopy: watch.seat.cwd }, rules: { exit: rules.exit, destructive: rules.destructive } };
  }

  private assessed(watch: SeatWatch, reading: Reading): void {
    const project = projectOf(watch.seat.cwd);
    const { assessment, views, questions, facts } = reading;
    this.desk.event(project, { kind: "watch.sensor", agent: watch.seat.id, model: assessment.model, id: assessment.id, cost: assessment.cost, answers: assessment.answers, stateChars: JSON.stringify(views).length });
    watch.readings += 1;
    watch.spent += assessment.cost ?? 0;
    watch.readAt = Date.now();
    // Peaks per question, kept: one overall peak is whatever reads high every turn and hid the one that mattered.
    for (const [question, p] of Object.entries(assessment.answers)) if (p > (watch.peaks.get(question) ?? -1)) watch.peaks.set(question, p);
    const before = watch.reading && watch.reading.turnId === reading.turnId ? watch.reading.answers : undefined;
    watch.reading = { turnId: reading.turnId, answers: assessment.answers };
    const { findings, verdicts } = weigh(assessment, questions, facts, { unclear: reading.spec.unclear, ended: !reading.running, before });
    this.keep(project, watch, reading, findings, verdicts);
    this.judged(watch, verdicts);
    void this.located(watch, reading, findings).then((located) => this.noticed(watch, located));
  }

  /** Findings quote their step so the incident says where to look; a literal answer about a sibling's file is excused here. */
  private async located(watch: SeatWatch, reading: Reading, findings: Finding[]): Promise<Finding[]> {
    const located = await Promise.all(
      findings.map(async (finding) => {
        const question = reading.questions[finding.kind];
        if (!question) return finding;
        const step = await this.assessor.locate(watch, reading, finding.kind);
        if (step?.note && question.excusedBeside) return undefined;
        return step ? { ...finding, quote: `${step.p < 0.5 ? "probably " : ""}${stepText(step)}` } : finding;
      }),
    );
    return located.filter((finding): finding is Finding => finding !== undefined);
  }

  private judged(watch: SeatWatch, verdicts: Verdict[]): void {
    if (verdicts.length === 0 || this.watches.get(watch.seat.id) !== watch) return;
    this.desk.judge(projectOf(watch.seat.cwd), watch.seat, verdicts).catch((error) => console.error("seatworks-v2: what the sensor said of an incident could not be recorded:", error));
  }

  private keep(project: Project, watch: SeatWatch, reading: Reading, findings: Finding[], verdicts: Verdict[]): void {
    const { assessment } = reading;
    const unkept = (error: unknown) => {
      const key = `unkept:${project.slug}`;
      const now = Date.now();
      if (now - (this.sensorNoted.get(key) ?? 0) < 60_000) return;
      this.sensorNoted.set(key, now);
      this.desk.event(project, { kind: "sensor.unkept", error: errorText(error) });
    };
    try {
      keepAssessment(project.state, {
        at: Date.now(),
        askedAt: reading.askedAt,
        seat: watch.seat.id,
        provider: watch.seat.provider,
        turnId: reading.turnId,
        running: reading.running,
        sensor: reading.spec.id,
        model: assessment.model,
        id: assessment.id,
        cost: assessment.cost,
        questions: Object.fromEntries(Object.entries(reading.questions).map(([name, question]) => [name, { view: question.view, instructions: question.instructions, ...(question.criteria ? { criteria: question.criteria } : {}) }])),
        answers: assessment.answers,
        facts: reading.facts.map(({ kind, level, quote }) => ({ kind, level, quote })),
        found: findings.map((finding) => finding.kind),
        verdicts: verdicts.map(({ kind, question, says, p }) => ({ kind, question, says, p })),
        views: reading.views,
      }).catch(unkept);
    } catch (error) {
      unkept(error);
    }
  }

  private noticed(watch: SeatWatch, findings: Finding[]): void {
    if (findings.length === 0 || this.watches.get(watch.seat.id) !== watch) return;
    const project = projectOf(watch.seat.cwd);
    this.desk
      .notice(project, watch.seat, findings)
      // Pending judgements are read now, not at the next quiet moment; re-asked after the wait since the seat may be gone.
      .then(() => {
        const judges = this.kit.watcher?.judges ?? [];
        if (this.watches.get(watch.seat.id) === watch && findings.some((finding) => judges.includes(finding.kind))) this.reader.moment(watch, true);
      })
      .catch((error) => console.error("seatworks-v2: what the watch noticed could not be recorded:", error));
  }

  private degraded(watch: SeatWatch, error: SensorError): void {
    const project = projectOf(watch.seat.cwd);
    const key = `degraded:${project.slug}`;
    const now = Date.now();
    if (now - (this.sensorNoted.get(key) ?? 0) < 60_000) return;
    this.sensorNoted.set(key, now);
    this.desk.event(project, { kind: "sensor.degraded", agent: watch.seat.id, status: error.status ?? null, error: error.message });
    this.troubled(project, "sensor.degraded", `${watch.seat.id}: ${error.status ?? "no status"} ${error.message}`);
  }

  /** Trouble nobody is mailed about, kept where a screen can show it rather than only in the log. */
  private troubled(project: Project, kind: string, detail: string): void {
    const list = this.troubles.get(project.slug) ?? [];
    list.push({ kind, at: Date.now(), detail });
    if (list.length > TROUBLES) list.splice(0, list.length - TROUBLES);
    this.troubles.set(project.slug, list);
  }

  /** A call the harness refused because its input was not JSON; it never reaches the desk, so only this reports it. */
  private malformedCalls(event: PluginLifecycleEvents["agent.turn_ended"]): void {
    const role = seatOf(this.kit, event.agent.provider)?.role;
    if (!role?.tools) return;
    const project = projectOf(event.agent.cwd);
    for (const call of malformed(event.timeline)) {
      this.desk.event(project, { kind: "call.malformed", agent: event.agent.id, role: role.role, tool: call.tool, error: call.quote });
      this.troubled(project, "call.malformed", `the ${role.label}'s ${call.tool} sent a request that was not valid JSON, so Seatworks never received it. Ask it to try again`);
    }
  }

  private watchView(project: Project, open: Iterable<SeatView> = []): WatchView {
    const team = this.source.teamFor(project);
    const spec = team.sensor?.spec;
    const questions = spec?.questions ?? {};
    const items = Object.values(loadIncidents(project.state).items);
    const now = Date.now();
    const ago = (at: number) => Math.max(0, Math.round((now - at) / 60_000));
    const titleOf = (kind: string) => questions[kind]?.label ?? this.kit.watcher?.kinds[kind]?.label ?? FACT_TITLES[kind] ?? kind.replace(/[-_]/g, " ");
    let ledger: Ledger | undefined;
    try {
      ledger = loadLedger(project.state);
    } catch {}
    const nameOf = (id: string, fallback: string) => {
      const task = ledger ? taskOfPeer(ledger, id) : undefined;
      if (task) return `${task.kind === "review" ? "Reviewer" : "Peer"} · ${task.id} ${task.title}`;
      const lane = ledger ? laneOfLead(ledger, id) : undefined;
      return lane ? `Lead · ${lane.id} ${lane.title}` : fallback;
    };

    // Only questions that can open an incident lean; fact-judging ones read high on every good turn.
    const leanOf = (watch: SeatWatch): WatchLean | null => {
      if (!spec || !watch.reading) return null;
      let best: WatchLean | null = null;
      for (const [name, p] of Object.entries(watch.reading.answers)) {
        const question = questions[name];
        const bar = question?.threshold;
        if (!question || bar === undefined || (!question.level && !question.agrees?.length)) continue;
        if (p >= bar || p < bar - spec.unclear) continue;
        if (!best || p - bar > best.p - best.bar) best = { title: titleOf(name), p, bar };
      }
      return best;
    };
    const watched = this.watches.all().filter((watch) => projectOf(watch.seat.cwd).slug === project.slug);
    const seats = watched.map((watch) => ({ id: watch.seat.id, name: nameOf(watch.seat.id, watch.seat.title ?? watch.seat.id), running: watch.running, lean: leanOf(watch) }));
    const lanes = new Set(watched.map((watch) => (ledger ? (taskOfPeer(ledger, watch.seat.id)?.lane ?? laneOfLead(ledger, watch.seat.id)?.id) : undefined)).filter(Boolean)).size;

    const incidents = items
      .filter((item) => item.open)
      .sort((a, b) => (a.level === b.level ? b.last - a.last : a.level === "page" ? -1 : 1))
      .slice(0, INCIDENTS_SHOWN)
      .map((item) => {
        const source = item.by === "watcher" ? ("watcher" as const) : item.p !== undefined ? ("jev" as const) : ("code" as const);
        const bar = questions[item.kind]?.threshold;
        return {
          id: item.id,
          title: titleOf(item.kind),
          level: item.level,
          name: nameOf(item.seat, item.where),
          minutes: ago(item.last),
          quote: item.quote.replace(/\s+/g, " ").slice(0, 300),
          source,
          sure: source === "jev" && item.p !== undefined && bar !== undefined ? { p: item.p, bar } : null,
          told: item.told !== undefined ? (item.toldTo ?? null) : null,
          lane: item.lane ?? null,
          held: item.told === undefined ? (item.held ?? null) : null,
        };
      });

    const troubles = this.troubles.get(project.slug) ?? [];
    const lastRead = lastKept(project.state) ?? null;
    // Against the last answer itself: whole-minute file age rounds a failure before and after it to the same.
    const degraded = troubles.filter((entry) => entry.kind === "sensor.degraded").at(-1);
    const answered = Math.max(0, ...watched.map((watch) => watch.readAt));
    const failing = jevOn(team) && degraded && degraded.at > answered ? { minutes: ago(degraded.at), detail: degraded.detail } : null;
    const seat = [...open]
      .filter((entry) => !entry.archivedAt && entry.cwd && projectOf(entry.cwd).slug === project.slug && can(seatOf(this.kit, entry.provider)?.role, "watch"))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];

    return {
      by: team.attention.by,
      on: this.watching(project),
      keyed: Boolean(team.sensor),
      telling: team.attention.watch,
      judgeMinutes: team.attention.by === "seat" ? team.attention.watcherJudgeMinutes : 2,
      failing,
      watcher: seat ? { id: seat.id, status: seat.status, minutes: ago(Date.parse(seat.updatedAt)), queued: this.outbox.pending(seat.id).length } : null,
      lanes,
      seats,
      lastRead,
      read: readTally(project.state),
      marks: {
        total: items.length,
        open: items.filter((item) => item.open).length,
        useful: items.filter((item) => item.label === "useful").length,
        noise: items.filter((item) => item.label === "noise").length,
        unknown: items.filter((item) => item.label === "unknown").length,
      },
      incidents,
      trouble: troubles.map((entry) => ({ kind: entry.kind, minutes: ago(entry.at), detail: entry.detail })).reverse(),
    };
  }

  private watchFound(watch: SeatWatch, facts: Fact[]): void {
    const project = projectOf(watch.seat.cwd);
    for (const fact of facts) this.desk.event(project, { kind: "watch.fact", agent: watch.seat.id, fact: fact.kind, level: fact.level, quote: fact.quote });
    this.noticed(watch, decide(facts));
  }

  prepare(): void {
    try {
      mkdirSync(stateRoot(), { recursive: true });
      // Before anything reads a kept file: a seat opened on a half-read ledger would write it back wrong.
      this.state = upgradeState(stateRoot());
      if (this.state.failed.length) throw new Error(this.state.failed.map((failed) => `${failed.where}: ${failed.error}`).join("; "));
      spoolDirs(this.spool);
      placeGuides(this.kit);
      sweepSnapshots();
      stampKit(this.kit, home());
    } catch (error) {
      console.error("seatworks-v2: could not prepare the state directory:", error);
      throw error;
    }
    const team = this.source.teamFor();
    for (const problem of team.errors) console.error(`seatworks-v2: settings: ${problem}`);
  }

  async connect(): Promise<void> {
    const connection = await connectLocal();
    if (this.disposed) { await connection.close(); return; }
    this.connection = connection;
    this.api = connection;
    for (const project of this.supervision.store.read().projects) this.remember(projectOf(project.root));
  }

  /** The Supervisor's last reply, when it says the agent cannot sign in: sending it work would only repeat that. */
  private async signInTrouble(agent: string): Promise<string | undefined> {
    try {
      const { entries } = await activityOn(() => this.api, agent, 4);
      const since = this.reloadedAt.get(agent) ?? -1;
      for (const entry of [...entries].reverse()) {
        if (entry.seqEnd <= since) return undefined;
        const item = JSON.parse(entry.content) as { type?: string; text?: string };
        if (item.type !== "assistant_message") continue;
        return SIGN_IN_TROUBLE.test(item.text ?? "") ? item.text!.slice(0, 200) : undefined;
      }
    } catch { /* an unreadable timeline says nothing about sign-in */ }
    return undefined;
  }

  private async brief() {
    const binding = this.supervision.store.read();
    const seats = await this.seats.open();
    const signIn = binding.supervisor ? await this.signInTrouble(binding.supervisor.agent) : undefined;
    if (this.supervision.store.read().revision !== binding.revision) throw new Error("Scope changed. Refresh team status.");
    return teamBrief(binding, seats, (root) => {
      const scope = binding.projects.find(p => p.root === root)!;
      const { project } = this.supervision.store.authorize(binding.supervisor!.agent, scope.id, "observe");
      return loadLedger(project.state);
    }, this.outbox.letters(), {
      reports: (root) => laneReports(projectOf(root).state),
      diff: (root, lane) => diffStat(lane.worktree ?? root, lane.base, lane.branch),
      teamFiles: (root) => uncommittedTeamFiles(root),
    }, signIn);
  }

  private async publishBrief() {
    if (this.disposed || !this.pluginApi || this.briefBusy) return;
    this.briefBusy = true;
    try {
      const data = await this.brief();
      if (!data.supervisor) return;
      const key = JSON.stringify(data);
      if (this.briefSent.get(data.supervisor) === key) return;
      await this.pluginApi.agents.ref(data.supervisor).timeline.append({ type: "plugin", id: "team-status", kind: "team-status", version: 1, data });
      this.briefSent.set(data.supervisor, key);
    } catch (error) { console.error("Seatworks team status could not update:", errorText(error)); }
    finally { this.briefBusy = false; }
  }

  register(server: PluginServerContext): void {
    server.handle(reloadSupervisorRpc, async () => {
      const agent = this.supervision.store.read().supervisor?.agent;
      if (!agent) throw new Error("There is no Supervisor to reload yet.");
      const last = await activityOn(() => this.api, agent, 1).then((a) => a.entries.at(-1)?.seqEnd ?? -1, () => -1);
      await this.reloadAgent(agent);
      this.reloadedAt.set(agent, last);
      this.briefSent.delete(agent);
      void this.publishBrief();
      return { agent };
    });
    server.handle(commitTeamFilesRpc, async (input) => {
      const scope = this.supervision.store.read().projects.find(p => p.id === input.scope);
      if (!scope) throw new Error("That project is no longer supervised. Refresh and try again.");
      const result = commitTeamFiles(scope.root);
      void this.publishBrief();
      return result;
    });
    server.handle(briefRpc, async (_input, context) => { this.pluginApi = context.paseo; const data = await this.brief(); void this.publishBrief(); return data; });
    this.timers.push(setInterval(() => void this.publishBrief(), 5000));
    server.handle(supervisionRpc, async () => await this.supervision.view() as never);
    server.handle(bindingRpc, async (input) => await this.supervision.bind(input) as never);
    server.handle(adoptRpc, async (input) => await this.supervision.adopt(input) as never);
    server.handle(createSupervisorRpc, async (input) => await this.supervision.create(input.revision) as never);
    registerRpc(server, this.control, (paseo) => {
      if (!this.connection) this.api = paseo;
    });
    server.before("agent.create", ({ request }, context) => {
      this.pluginApi = context.paseo;
      if (!this.connection) this.api = context.paseo;
      return { ...request, config: this.launchConfig(request.config) };
    });
    server.before("agent.session_open", ({ request }, context) => {
      this.pluginApi = context.paseo;
      if (!this.connection) this.api = context.paseo;
      return this.openSession(request);
    });
    this.on(server, "agent.turn_started", async ({ agent }) => this.turnStarted(agent.id));
    this.on(server, "agent.turn_ended", (event) => this.turnEnded(event));
    this.on(server, "agent.permission_requested", (event) => this.permissionRequested(event));
    this.on(server, "agent.created", async ({ agent }) => this.watches.follow(agent));
    this.on(server, "agent.archived", async ({ agent }) => {
      this.outbox.archived(agent.id);
      this.turns.forget(agent.id);
      this.watches.drop(agent.id);
      if (this.watches.watched(agent.provider)) await this.desk.closeIncidents(projectOf(agent.cwd), agent.id);
    });
    this.timers.push(setInterval(() => this.serveSpool(), 500));
    // The cadence is read every time round, so changing it in settings takes hold without a reload.
    const patrol = () => {
      if (this.api) this.patrol.tick().then(() => this.supervision.dependencies.recover()).then(() => this.communication.tick()).then(() => this.offline.clear(), (error) => this.tickFailed(error));
      this.tick = setTimeout(patrol, Math.max(5, this.source.teamFor().attention.tickSeconds) * 1000);
    };
    this.tick = setTimeout(patrol, this.source.teamFor().attention.tickSeconds * 1000);
  }

  private tickFailed(error: unknown): void {
    console.error("seatworks-v2: tick failed:", error);
    if (this.tick && this.relink.failed(errorText(error))) console.error("seatworks-v2: lost the daemon link; reloading the plugin.");
    if (!/not connected|client closed|transport/i.test(errorText(error))) return;
    for (const project of this.desk.projects.values()) {
      if (this.offline.has(project.slug)) continue;
      this.offline.add(project.slug);
      this.desk.event(project, { kind: "watch.offline", error: errorText(error) });
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.connection?.close();
    this.watches.dispose();
    this.assessor.dispose();
    this.reader.dispose();
    this.communication.dispose();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.tick) clearTimeout(this.tick);
    this.tick = undefined;
  }

  private launchConfig(config: AgentConfig): AgentConfig {
    const seat = seatOf(this.kit, config.provider);
    if (!seat) return config;
    const project = can(seat.role, "supervise") ? undefined : projectOf(config.cwd);
    if (project) this.remember(project);
    const team = this.seating.ensure(seat.role.role, seat.harness, project);
    const render = (role: Parameters<typeof renderPrompt>[1]) => renderPrompt(this.kit, role, { guides: guidesDir(), state: project?.state ?? join(stateRoot(), "supervisor-home") });
    return applyRole(this.kit, team, config, render, project?.state ?? join(stateRoot(), "supervisor-home"), this.seating.servers(team, seat.role.role));
  }

  private openSession(request: SessionOpen): SessionOpen {
    const seat = seatOf(this.kit, request.provider);
    if (!seat) return request;
    if (can(seat.role, "supervise")) {
      const state = join(stateRoot(), "supervisor-home");
      // The records are the Supervisor's: one notebook across the projects it supervises.
      try {
        seedRecords(this.kit, state);
      } catch (error) {
        console.error("seatworks-v2: could not seed the Supervisor's records:", error);
      }
      this.seating.ensure(seat.role.role, seat.harness);
      return seatEnv(this.kit, request, seatDir(this.kit, seat.role, seat.harness, home()), { root: request.cwd, state });
    }
    const project = projectOf(request.cwd);
    this.remember(project);
    try {
      if (this.kit.team) placeProjectFiles(project.root, this.kit.team);
    } catch (error) {
      console.error("seatworks-v2: could not write the team's block into the project's AGENTS.md:", error);
    }
    this.seating.ensure(seat.role.role, seat.harness, project);
    return seatEnv(this.kit, request, seatDir(this.kit, seat.role, seat.harness, home(), project), project);
  }

  private turnStarted(agentId: string): void {
    this.communication.started(agentId);
    this.turns.started(agentId);
    this.outbox.turnStarted(agentId);
  }

  private async turnEnded(event: PluginLifecycleEvents["agent.turn_ended"]): Promise<void> {
    this.communication.ended(event.agent.id, outputText(event.timeline), event.outcome.kind === "completed");
    this.outbox.turnEnded(event.agent.id);
    this.malformedCalls(event);
    // Wrapped: a throw here left the seat's mail waiting until some unrelated event pumped it.
    try {
      const archiving = this.desk.pendingArchive.has(event.agent.id);
      if (archiving) await this.desk.archive(event.agent.id, true);
      await this.desk.stopped(event.agent.id);
      if (archiving) return;
      await this.turns.ended(event);
    } finally {
      await this.outbox.pump(event.agent.id);
    }
  }

  private async permissionRequested({ agent, request }: PluginLifecycleEvents["agent.permission_requested"]): Promise<void> {
    const role = seatOf(this.kit, agent.provider)?.role;
    if (!role?.tools) return;
    const project = projectOf(agent.cwd);
    const what = request.title ?? request.name ?? request.kind;
    if (can(role, "supervise")) {
      this.log(project, `waiting on the Human: ${agent.id} ${what}`);
      return;
    }
    this.watches.urgent(agent.id);
    const owner = await this.turns.ownerOf(project, agent.id, role);
    await this.desk.post(owner, `permission:${agent.id}:${request.id}`, letters.permission(`${role.label} ${agent.title ?? agent.id}`, request, this.addressOf(project, agent.id, role)), project);
  }

  private addressOf(project: Project, agentId: string, role: RoleSpec): string | undefined {
    try {
      const ledger = loadLedger(project.state);
      return can(role, "lead") ? laneOfLead(ledger, agentId)?.id : taskOfPeer(ledger, agentId)?.id;
    } catch {
      return undefined;
    }
  }

  private remember(project: Project): void {
    this.desk.projects.set(project.slug, project);
    this.source.record(project);
  }

  private indexesFor(project: Project): CodeIndex[] {
    return indexedProxies(this.source.teamFor(project)).map((proxy) => this.makeIndex(proxy));
  }

  /** Explicit discovery must install its role providers before the host can list their models. */
  async refreshModels(): Promise<ModelCache> {
    const paseo = this.api;
    if (!paseo) throw new Error("Paseo is not connected, so it cannot list the agents' models");
    const registered = applyReconcile(this.kit, this.source.teamFor());
    if (registered.length && !await this.reload()) throw new Error("Provider configuration was saved but could not be reloaded. Retry discovery after resolving the host error.");
    // Scoped to one directory: unscoped, Paseo probes the agent for every workspace it has ever opened.
    const cwd = stateRoot();
    await Promise.all([...listingProviders(this.kit).values()].map((provider) => paseo.providers.refresh({ cwd, providers: [provider] })));
    const { cache, changed } = await fetchModels(this.kit, (provider) => paseo.providers.listModels(provider, { cwd }) as Promise<Listed>, stateRoot());
    applyModels(this.kit, cache);
    if (changed) {
      this.seating.forget();
      this.reconcileProviders(this.source.teamFor());
    }
    return cache;
  }

  private reconcileProviders(team: Team): void {
    try {
      const changed = applyReconcile(this.kit, team);
      if (changed.length === 0) return;
      console.log(`seatworks-v2: config updated (${changed.join(", ")}); reloading the daemon`);
      void this.reload();
    } catch (error) {
      console.error("seatworks-v2: could not reconcile role providers:", error);
    }
  }

  private log(project: Project, line: string): void {
    try {
      appendRecord(project.state, "attention", `${new Date().toISOString()}  ${line}\n`);
    } catch (error) {
      console.error("seatworks-v2: attention log write failed:", error);
    }
  }

  private async compose(to: string, list: Letter[]): Promise<string> {
    const items = list.map((letter) => letter.guard ? `[Delivery ${letter.id}]\n${letter.text}` : letter.text);
    try {
      const seat = await this.seats.look(to);
      if (!seat.cwd) return letters.mailbox(items, []);
      return letters.mailbox(items, openAsksTo(loadLedger(projectOf(seat.cwd).state), to));
    } catch {
      return letters.mailbox(items, []);
    }
  }

  private on<N extends EventName>(server: PluginServerContext, name: N, handler: (event: PluginLifecycleEvents[N], context: PluginHookContext) => Promise<void>): void {
    server.on(name, async (event, context) => {
      this.pluginApi = context.paseo;
      if (!this.connection) this.api = context.paseo;
      try {
        await handler(event, context);
      } catch (error) {
        console.error(`seatworks-v2: ${name} handler failed:`, error);
      }
    });
  }

  private serveSpool(): void {
    if (!this.api) return;
    let requests;
    try {
      requests = takeRequests(this.spool);
    } catch (error) {
      console.error("seatworks-v2: spool read failed:", error);
      return;
    }
    for (const request of requests) {
      this.desk
        .answer(request)
        .catch((error) => ({ ok: false, text: `The desk failed: ${errorText(error)}` }))
        .then((reply) => writeReply(this.spool, request.id, reply))
        .catch((error) => console.error("seatworks-v2: spool reply failed:", error));
    }
  }
}
