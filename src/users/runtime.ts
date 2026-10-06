// One user's runtime (issue #158, design.md "Users: one hopper, separate users"): every part of theirs
// composed over their user store — the plugins config (written on the first start without one), plugin
// host, target pool, executors, question service, engine, job source sync, webhook dispatcher,
// notifiers, failure log. Nothing in it reads or writes another user's: their secrets under their
// secret prefix, their processes with their CLI config dirs, their herdr session.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Clock, EscalationLevel, Executor, ExecutorRegistry, GhLogin, JobSource, PluginsView, QuestionService, Router, SettableUsageSource, SourceRegistry,
  UserStore, WebhookDispatcher,
} from '../domain/ports.ts';
import type { AttachedMachine, ConnectedAccountProvider, Question, SourceStatus, User } from '../domain/types.ts';
import { isRerunnable } from '../domain/types.ts';
import type { Config } from '../config.ts';
import { createEngine, type Engine } from '../engine/index.ts';
import { logFailures } from '../engine/failure-log.ts';
import { createExecutorRegistry } from '../executors/index.ts';
import type { HerdrClient } from '../executors/herdr/index.ts';
import { clientSocket, type ClientTransport } from '../executors/client.ts';
import { dockerHost } from '../executors/docker.ts';
import { hopperSshAuth, pinHostKeys } from '../executors/ssh.ts';
import { createClientReleaseKeeper, createTargetPool, probeContainer, probeHerdrOverSsh, probeSsh, type MachineProbe, type ResolvedTarget } from '../machines/index.ts';
import type { ClientRelease } from '../client/release.ts';
import { BUILTIN_PLUGINS } from '../plugins/builtin.ts';
import { builtinInstances, ensurePluginsConfig } from '../plugins/builtin-instances.ts';
import { createDetectionKit } from '../plugins/detect.ts';
import { unavailableExecutors } from '../plugins/executor-slot.ts';
import { herdrClaudePlugin } from '../plugins/executor/herdr-claude/index.ts';
import { localPlugin, startHerdrSession } from '../plugins/machine-source/local/index.ts';
import { createPluginHost, type BuiltJobSource, type PluginHost } from '../plugins/index.ts';
import { githubAppPlugin } from '../plugins/job-source/github-app/index.ts';
import { githubGhPlugin } from '../plugins/job-source/github-gh/index.ts';
import { grokbotRoutinePlugin } from '../plugins/notifier/grokbot-routine/index.ts';
import type { JobSourceInstance } from '../plugins/sdk.ts';
import { createQuestionService } from '../questions/index.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { createGhLogin, createSourceSync, idleStatus, withFixedStatuses, type GitHubApi, type SourceSync } from '../sources/index.ts';
import { createConnectedAccounts, type ConnectedAccountsService } from '../connected-accounts/service.ts';
import { installations, whoIs } from '../connected-accounts/identity.ts';
import { createWebhooksEditor, type WebhooksEditor } from '../webhooks/edit.ts';
import { createWebhookDispatcher, secretProblem } from '../webhooks/index.ts';
import { userCliEnv, userSecrets, userWorkDir } from './env.ts';
import { userProcessEnv } from '../executors/env.ts';

/** Doubles at ports.ts seams for one user's parts, for integration tests. Production passes none. */
export interface UserSeams {
  /** Replaces the herdr CLI client of every herdr-claude executor instance (detection then says available). */
  herdr?: HerdrClient;
  /** Registered after the configured executor instances. */
  executors?: Executor[];
  /** Replaces the `gh` CLI adapter of every github-gh job source (detection then says available). */
  github?: GitHubApi;
  /** Replaces the App adapter of every github-app job source (detection says available; paused() still follows the app file). */
  githubApp?: GitHubApi;
  /** A hand-settable usage source the decider reads, set through `engine.setFakeUsage` (tests). */
  fakeUsage?: SettableUsageSource;
  /** Run after the configured sources, polled every SEAM_SOURCE_POLL_MS. */
  sources?: JobSource[];
  /** First retry delay of every grokbot-routine notifier instance; default 1000. */
  grokbotBaseMs?: number;
  /** Replaces the configured router (the plugin host still loads, for /api/plugins). */
  router?: Router;
  /** Replace the configured escalation levels, lowest first; [] = none. The report stays the host's. */
  levels?: EscalationLevel[];
  /** Replaces the probe of every attached machine: online = its herdr session (ssh) or its container (docker) is running. */
  machineProbe?: (machine: AttachedMachine) => Promise<MachineProbe>;
  /** Replaces resolving a new ssh target when the UI adds a machine (issues #18, #59): its herdr path and pinned host key, or a rejection with the reason. */
  resolveTarget?: (ssh: string, o: { herdr: boolean }) => Promise<ResolvedTarget>;
  /** Replaces starting this machine's herdr session (issue #260): when it is added, and while it is a machine. */
  herdrSession?: (session: string) => Promise<void>;
}

/** What the instance gives each user runtime. */
export interface UserRuntimeOptions {
  user: User;
  /** The user's store; the runtime closes it on stop. */
  store: UserStore;
  config: Config;
  seams: UserSeams;
  /** The environment the runtime's secrets come from (process.env; AppSeams.env in tests). */
  env: Record<string, string | undefined>;
  clock: Clock;
  logger: { info(line: string): void; warn(line: string): void };
  /** The client release this hopper loads onto client targets (the install it runs from). */
  clientRelease: ClientRelease;
  /** Where the store installs are unpacked (the instance's). */
  installedDir: string;
  /** How often the plugins config's version is checked. */
  pluginsConfigIntervalMs: number;
  /** The UI link to one question (notifications carry it). */
  answerUrl(questionId: string): string;
  /** A GitHub account this user connected from Sources: link it, so signing in with it lands here (issue #214). */
  linkIdentity?(provider: ConnectedAccountProvider, subject: string): void;
}

/** One user's running parts: what the HTTP edge reads and changes for that user, and tests drive. */
export interface UserRuntime {
  user: User;
  store: UserStore;
  engine: Engine;
  /** The sync loop (syncNow in tests). */
  sources: SourceSync;
  /** Every job source's status, the ones that do not run included (/api/sources). */
  registry: SourceRegistry;
  plugins: PluginsView;
  host: PluginHost;
  questions: QuestionService;
  dispatcher: WebhookDispatcher;
  executors: ExecutorRegistry;
  ghLogin: GhLogin;
  /** The user's connected GitHub account (issue #214). */
  connectedAccounts: ConnectedAccountsService;
  webhooksEditor: WebhooksEditor;
  /** Why the user's runtime gives no secret for a webhook subscription's variable; undefined when it does. */
  secretProblem: (secretEnv: string) => string | undefined;
  /** Start the loops: engine and source sync (the dispatcher and notifiers run from creation). Once. */
  start(): Promise<void>;
  /** Stop every loop and part; close the user's store. Once. */
  stop(): Promise<void>;
}

const SEAM_SOURCE_POLL_MS = 1000;

/** The built-in plugins with the seams (tests) in place of the herdr CLI and the GitHub adapters, and the user's herdr session as herdr-claude's default. */
function withSeams(seams: UserSeams) {
  return BUILTIN_PLUGINS.map((p) => {
    if (p.id === 'herdr-claude') return herdrClaudePlugin(seams.herdr);
    if (p.id === 'local' && seams.herdrSession) return localPlugin(seams.herdrSession);
    if (p.id === 'github-gh' && seams.github) return githubGhPlugin(seams.github);
    if (p.id === 'github-app' && seams.githubApp) return githubAppPlugin(seams.githubApp);
    if (p.id === 'grokbot-routine' && seams.grokbotBaseMs) return grokbotRoutinePlugin({ baseMs: seams.grokbotBaseMs });
    return p;
  });
}

/** The job sources the sync loop runs, and fixed /api/sources entries for the ones that do not. */
type RunningSource = Extract<JobSourceInstance, { source: JobSource }>;

function splitSources(built: BuiltJobSource[]): { running: RunningSource[]; fixed: SourceStatus[] } {
  const running: RunningSource[] = [];
  const fixed: SourceStatus[] = [];
  for (const b of built) {
    if (!b.instance) fixed.push(idleStatus(b.spec.name, b.spec.plugin, 'error', { error: b.reason }));
    else if ('disabled' in b.instance) fixed.push(idleStatus(b.spec.name, b.instance.disabled.kind, 'disabled', { detail: b.instance.disabled.detail }));
    else running.push(b.instance);
  }
  return { running, fixed };
}

/** A seam router (tests) answers as itself; the report stays the host's. */
function seamPlugins(router: Router, host: PluginsView): PluginsView {
  return {
    routerStatus: () => ({ name: router.name, plugin: router.name, fallback: false }), report: host.report, edit: host.edit,
    machinesConfig: host.machinesConfig, editMachines: host.editMachines, editMachineDefaults: host.editMachineDefaults,
    routing: host.routing, editRouting: host.editRouting,
  };
}

/** Build one user's parts; start the plugin host, the webhook dispatcher and the notifiers. The engine and source sync start with `start()`. */
export async function createUserRuntime(o: UserRuntimeOptions): Promise<UserRuntime> {
  const { user, store, config, seams, clock, logger } = o;
  // The plugins config is the one truth: the built-in instances are written on the start that finds none.
  ensurePluginsConfig({ config: store.config, answerTimeoutMs: config.answerTimeoutMs, localMachine: config.localMachine, userId: user.id, logger });
  // Every secret comes from the runtime, under the user's prefix (issue #56, #158).
  const secret = userSecrets(o.env, user);
  const dataDir = userWorkDir(config.workDir, user);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // The CLIs' logins of a user added later are their own (GH_CONFIG_DIR, CLAUDE_CONFIG_DIR in their work dir).
  const cliEnv = userCliEnv(config.workDir, user);
  for (const dir of Object.values(cliEnv)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // How the hopper proves itself to an ssh target, asked at every connection (design.md "Target authentication").
  const sshAuth = () => hopperSshAuth({ env: secret, dataDir });
  // Where client targets' reverse tunnels open their sockets: this user's alone (design.md "Client targets").
  mkdirSync(join(dataDir, 'clients'), { recursive: true, mode: 0o700 });
  const clientTransport = (machine: string, tokenEnv: string): ClientTransport => ({
    machine, socket: clientSocket(dataDir, machine), token: () => secret(tokenEnv) ?? '',
  });
  const keepClient = createClientReleaseKeeper({ release: o.clientRelease, logger });
  let executorNames = (): string[] => [];
  let jobsOnMachine = (_name: string): string[] => [];
  // How the hopper reaches each attached machine (issue #74: the machine-source context's `target`).
  const target = createTargetPool({
    clock, logger,
    probe: seams.machineProbe
      ?? ((m) => ('client' in m
        ? keepClient(clientTransport(m.name, m.client.tokenEnv), () => jobsOnMachine(m.name).length > 0)
        : ('docker' in m
          ? probeContainer({ container: m.docker, dockerHost: () => dockerHost(secret) })
          : m.herdr
            ? probeHerdrOverSsh({ target: m.ssh, herdrBin: m.herdrBin, session: m.session, controlDir: join(dataDir, 'ssh'), auth: sshAuth })
            : probeSsh({ target: m.ssh, controlDir: join(dataDir, 'ssh'), auth: sshAuth })
        ).then((online) => ({ online })))),
  });
  // The GitHub account the user's work comes through (issue #214): from signing in with it, or
  // connected from Sources, through the hopper's app; their job sources and jobs ask here for tokens.
  const connectedAccounts = createConnectedAccounts({
    store, apps: config.hopperApps, clock, logger,
    whoIs: (provider, token) => whoIs(config.hopperApps[provider], token),
    installations: (token) => installations(config.hopperApps.github, token),
    ...(o.linkIdentity ? { link: o.linkIdentity } : {}),
    // Reached only after `sync` exists: a connection is made long after the runtime starts.
    onChange: (provider) => {
      for (const s of jobSources.filter((j) => j.kind === `${provider}-account`)) void sync.syncNow(s.name).catch(() => undefined);
    },
  });
  const notEnded = () => store.jobs.list({ status: ['queued', 'held', 'claimed', 'running', 'waiting_answer'] });
  const builtin = builtinInstances(config.answerTimeoutMs, config.localMachine);
  const host = createPluginHost({
    ...(config.pluginDir ? { pluginDir: config.pluginDir } : {}), installedDir: o.installedDir,
    config: store.config, dataDir, clock, logger, userEnv: cliEnv,
    defaultMachines: builtin.machines, defaultExecutors: builtin.executors,
    kit: createDetectionKit({ env: { ...o.env, ...cliEnv }, secret }),
    builtins: withSeams(seams),
    jobSourceContext: {
      knownKeys: (keys) => new Set(keys.filter((k) => store.jobs.getBySourceKey(k))),
      rerunnable: (keys) => new Set(keys.filter((k) => { const j = store.jobs.getBySourceKey(k); return j !== undefined && isRerunnable(j); })),
      connectedAccounts,
    },
    machineContext: { executors: () => executorNames(), target },
    intervalMs: o.pluginsConfigIntervalMs,
    executorInUse: (name) => notEnded().filter((j) => j.spec.executor === name).map((j) => j.id),
    attached: {
      inUse: (name) => jobsOnMachine(name), pinned: (name) => notEnded().filter((j) => j.spec.machineId === name).map((j) => j.id),
      sshAuth, ...(seams.resolveTarget ? { resolveTarget: seams.resolveTarget } : {}),
      startSession: seams.herdrSession ?? ((s) => startHerdrSession(s, cliEnv)),
    },
  });
  await host.start();
  // The pinned host keys follow the plugins config: rewritten when it changes, each problem logged once.
  const pinProblems = new Set<string>();
  const pinned = (machines: AttachedMachine[]): AttachedMachine[] => {
    for (const p of pinHostKeys(dataDir, machines)) if (!pinProblems.has(p)) { pinProblems.add(p); logger.warn(`hopper: ${p}`); }
    return machines;
  };
  pinned(host.targets());
  // Executors follow the plugins config live (issue #142): every lookup reads the host's instances now.
  const currentExecutors = (): ExecutorRegistry => {
    const built = host.executors();
    return createExecutorRegistry([...built.flatMap((b): Executor[] => (b.executor ? [b.executor] : [])), ...(seams.executors ?? [])], unavailableExecutors(built));
  };
  const executors: ExecutorRegistry = {
    get: (name) => currentExecutors().get(name),
    names: () => currentExecutors().names(),
    unavailable: () => currentExecutors().unavailable(),
  };
  executorNames = () => executors.names();
  const plugins: PluginsView = seams.router ? seamPlugins(seams.router, host) : host;
  const router = seams.router ?? host.router;
  // Seam doubles win over the host's live instances (looked up per question).
  const levels = (): readonly EscalationLevel[] => seams.levels ?? host.levels();
  const dispatcher = createWebhookDispatcher({ store, clock, secret, baseMs: config.webhookBaseMs });
  // The service calls the engine and the engine calls the service: the engine's handlers are
  // reached through closures that run only after `engine` exists (design.md "Construction
  // contract added").
  const questions = createQuestionService({
    store, clock, levels, stageTimeoutMs: config.answerTimeoutMs, config: store.config,
    renotifyMs: config.humanRenotifyMs, humanTimeoutMs: config.humanTimeoutMs,
    answerUrl: o.answerUrl,
    onAnswered: (q: Question) => engine.onAnswered(q),
    onExpired: (q: Question) => engine.onExpired(q),
    onDismissed: (q: Question) => engine.onDismissed(q),
  });
  const { running, fixed } = splitSources(host.jobSources());
  const jobSources = [...running.map((r) => r.source), ...(seams.sources ?? [])];
  const engine: Engine = createEngine({
    store, clock, executors, router, questions, queueSorter: host.queueSorter,
    routing: { rules: () => host.routingRules(), machines: () => host.machineIds() },
    ...(seams.fakeUsage ? { fakeUsage: seams.fakeUsage } : {}),
    // Every machine follows the plugins config without a restart (issues #18, #74); the pinned host keys with it.
    machines: { list: () => { pinned(host.targets()); return host.machines().list(); } },
    usage: [...host.usageSources(), ...(seams.fakeUsage ? [seams.fakeUsage] : [])],
    policy: {
      softLimit: config.softLimit, hardLimit: config.hardLimit, routerCheapBoost: config.routerCheapBoost,
      laneIdleGraceMs: config.laneIdleGraceMs, resumeBoost: config.resumeBoost,
    },
    tickMs: config.tickMs,
    maxQuestions: config.maxQuestions,
    keepPanes: config.keepPanes,
    // Completion is the job's source's to judge (issues #171, #187); a job of no source, or of one that does not judge, is complete.
    notComplete: async (job) => jobSources.find((s) => s.name === job.source?.source)?.notComplete?.(job),
    // A job of a connected account acts through it (issue #214); any other job runs with nothing added.
    credentials: async (job) => (await jobSources.find((s) => s.name === job.source?.source)?.credentials?.(job)) ?? {},
  });
  jobsOnMachine = (name) => engine.jobsOnMachine(name);
  const sync = createSourceSync({
    sources: jobSources, host: engine.sourceHost, clock,
    pollMs: (name) => running.find((r) => r.source.name === name)?.pollMs ?? SEAM_SOURCE_POLL_MS,
  });
  const raw = runtimeSecrets(o.env);
  // Deliveries and notifiers from now on, so an instance event (update.applied at boot) reaches them.
  const stopFailureLog = logFailures(store);
  dispatcher.start();
  host.startNotifiers({ subscribe: (l) => store.events.subscribe(l), job: (id) => store.jobs.get(id) });
  let started = false;
  let stopped: Promise<void> | undefined;
  return {
    user, store, engine, sources: sync, registry: withFixedStatuses(sync, fixed), plugins, host, questions, dispatcher, executors,
    // gh login (issue #138): the gh on the daemon's PATH, the github-gh source's default `bin`, with the user's gh config.
    ghLogin: createGhLogin({ bin: 'gh', env: Object.keys(cliEnv).length === 0 ? o.env : userProcessEnv(cliEnv, o.env) }),
    connectedAccounts,
    webhooksEditor: createWebhooksEditor({ store }),
    // The variable the user's runtime reads: the subscription's, under the user's prefix.
    secretProblem: (secretEnv) => secretProblem(raw, `${user.secretPrefix}${secretEnv}`),
    async start() {
      if (started) return;
      started = true;
      await engine.start();
      sync.start();
    },
    stop() {
      stopped ??= (async () => {
        await sync.stop();
        connectedAccounts.stop();
        await questions.stop();
        await engine.stop();
        await dispatcher.stop();
        await host.stopNotifiers();
        stopFailureLog();
        host.stop();
        store.close();
      })();
      return stopped;
    },
  };
}
