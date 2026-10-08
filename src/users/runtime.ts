// One user's runtime (issue #158, design.md "Users: one hopper, separate users"): every part of theirs
// composed over their user store — the plugins config (written on the first start without one), plugin
// host, target pool, executors, question service, engine, job source sync, webhook dispatcher,
// notifiers, failure log. Nothing in it reads or writes another user's: their secrets under their
// secret prefix, their processes with their CLI config dirs, their herdr session.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Clock, EscalationLevel, Executor, ExecutorRegistry, JobSource, PluginsView, QuestionService, Router, SettableUsageSource, SourceRegistry,
  UserStore, WebhookDispatcher,
} from '../domain/ports.ts';
import { DEFAULT_HISTORY_RETENTION_DAYS, IN_FLIGHT_STATUSES, type AttachedMachine, type ConnectedAccountProvider, type HostKeyOffer, type Job, type Question, type User } from '../domain/types.ts';
import { storeSourceContext } from './source-context.ts';
import type { Config } from '../config.ts';
import { createEngine, type Engine } from '../engine/index.ts';
import { logFailures } from '../engine/failure-log.ts';
import { createExecutorRegistry } from '../executors/index.ts';
import type { HerdrClient } from '../executors/herdr/index.ts';
import type { ClientTransport } from '../executors/client.ts';
import { linkToken, mintLinkKey } from '../client/link.ts';
import type { MachineLinks } from '../machines/links.ts';
import type { MachineJoin } from '../plugins/attached-edit.ts';
import { dockerHost } from '../executors/docker.ts';
import { hopperSshAuth, pinHostKeys } from '../executors/ssh.ts';
import { ensureOwnSshKey, type StoredSshKey } from '../executors/ssh-key.ts';
import { createClientReleaseKeeper, createTargetPool, probeContainer, probeHerdrOverSsh, probeSsh, type MachineProbe, type ResolvedTarget } from '../machines/index.ts';
import type { ClientRelease } from '../client/release.ts';
import { BUILTIN_PLUGINS } from '../plugins/builtin.ts';
import { builtinInstances, ensurePluginsConfig } from '../plugins/builtin-instances.ts';
import { createDetectionKit } from '../plugins/detect.ts';
import { unavailableExecutors } from '../plugins/executor-slot.ts';
import { herdrClaudePlugin } from '../plugins/executor/herdr-claude/index.ts';
import { localPlugin, startHerdrSession } from '../plugins/machine-source/local/index.ts';
import { createPluginHost, type BuiltJobSource, type PluginHost } from '../plugins/index.ts';
import { splitSources } from './job-sources.ts';
import { githubAppPlugin } from '../plugins/job-source/github-app/index.ts';
import { githubAccountPlugin } from '../plugins/job-source/github-account/index.ts';
import { grokbotRoutinePlugin } from '../plugins/notifier/grokbot-routine/index.ts';
import { createQuestionService } from '../questions/index.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { createSourceSync, withFixedStatuses, type GitHubApi, type SourceSync } from '../sources/index.ts';
import { createConnectedAccounts, fromRuntime, type ConnectedAccountsService } from '../connected-accounts/service.ts';
import { installations, whoIs } from '../connected-accounts/identity.ts';

import { createUsageRecorder, type UsageRecorder } from '../usage/history.ts';
import { createWebhooksEditor, type WebhooksEditor } from '../webhooks/edit.ts';
import { createWebhookDispatcher, secretProblem } from '../webhooks/index.ts';
import { userCliEnv, userSecrets, userWorkDir } from './env.ts';

/** Doubles at ports.ts seams for one user's parts, for integration tests. Production passes none. */
export interface UserSeams {
  /** Replaces the herdr CLI client of every herdr-claude executor instance (detection then says available). */
  herdr?: HerdrClient;
  /** Registered after the configured executor instances. */
  executors?: Executor[];
  /** Replaces the connected account's adapter of every github-account job source; the account still has to be connected. */
  github?: GitHubApi;
  /** Replaces the App adapter of every github-app job source (detection says available; paused() still follows the app file). */
  githubApp?: GitHubApi;
  /** A hand-settable usage source the decider reads, set through `engine.setFakeUsage` (tests). */
  fakeUsage?: SettableUsageSource;
  /** Run after the configured sources, polled every SEAM_SOURCE_POLL_MS. */
  sources?: JobSource[];
  /** Every grokbot-routine notifier instance's first retry delay (default 1000) and configured check (default 5000), in ms. */
  grokbot?: { baseMs?: number; watchMs?: number };
  /** Replaces the configured router (the plugin host still loads, for /api/plugins). */
  router?: Router;
  /** Replace the configured escalation levels, lowest first; [] = none. The report stays the host's. */
  levels?: EscalationLevel[];
  /** Replaces the probe of every attached machine: online = its herdr session (ssh) or its container (docker) is running. */
  machineProbe?: (machine: AttachedMachine) => Promise<MachineProbe>;
  /** Replaces resolving a new ssh target when the UI adds a machine (issues #18, #59): its pinned host key once herdr is found there, or a rejection with the reason. */
  resolveTarget?: (ssh: string, o: { herdr: boolean; hostKey?: string }) => Promise<ResolvedTarget>;
  /** Replaces reading the host key a new ssh target would be pinned to (issue #293): known_hosts, else what it presents. */
  hostKeyOffer?: (ssh: string) => Promise<HostKeyOffer>;
  /** Replaces starting this machine's herdr session (issue #260): when it is added, and while it is a machine. */
  herdrSession?: (session: string) => Promise<void>;
}

/** A user's side of the machines that dial in (design.md "Joining a machine", issue #308). */
export interface UserMachineLink {
  /** The public half of the hopper's link key for this user: a joining machine derives its client token from it. */
  hopperKey: string;
  /** A machine joining with its machine key, under the name it asks for: the client target it is now. */
  join(j: MachineJoin): Promise<{ ok: true; machine: string } | { ok: false; error: string }>;
  /** The client token of the client target holding this machine key; undefined when none does. */
  tokenFor(key: string): string | undefined;
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
  /** The links of the machines dialled in to this hopper (the instance's; issue #308). */
  links: MachineLinks;
  /** Where the store installs are unpacked (the instance's). */
  installedDir: string;
  /** How often the plugins config's version is checked. */
  pluginsConfigIntervalMs: number;
  /** The UI link to one question (notifications carry it). */
  answerUrl(questionId: string): string;
  /** A GitHub account this user connected from Sources: link it, so signing in with it lands here (issue #214). */
  linkIdentity?(provider: ConnectedAccountProvider, subject: string): void;
  /** Of these source keys, those another user of this hopper has a job for (issue #440): a claim may be theirs. */
  otherUsersKnow?(keys: string[]): Set<string>;
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
  /** The user's connected GitHub account (issue #214). */
  connectedAccounts: ConnectedAccountsService;
  webhooksEditor: WebhooksEditor;
  /** Why the user's runtime gives no secret for a webhook subscription's variable; undefined when it does. */
  secretProblem: (secretEnv: string) => string | undefined;
  /** The user's machines dialling in (issue #308): the hopper's public half, a machine joining, a dial-in's token. */
  machineLink: UserMachineLink;
  /** The usage history's recorder (issue #385): `record` and `prune` now, in tests. */
  usageHistory: UsageRecorder;
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
    if (p.id === 'github-account' && seams.github) return githubAccountPlugin(seams.github);
    if (p.id === 'github-app' && seams.githubApp) return githubAppPlugin(seams.githubApp);
    if (p.id === 'grokbot-routine' && seams.grokbot) return grokbotRoutinePlugin(seams.grokbot);
    return p;
  });
}

/** A seam router (tests) answers as itself; the report stays the host's. */
function seamPlugins(router: Router, host: PluginsView): PluginsView {
  return {
    routerStatus: () => ({ name: router.name, plugin: router.name, fallback: false }), report: host.report, edit: host.edit,
    machinesConfig: host.machinesConfig, editMachines: host.editMachines, machineHostKey: host.machineHostKey, editMachineDefaults: host.editMachineDefaults,
    routing: host.routing, editRouting: host.editRouting, notifierAction: host.notifierAction,
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
  // The hopper's own ssh key (issue #293): kept in the database, written to the work dir at every start —
  // an ephemeral container has no durable ~/.ssh. A key the runtime mounts is used instead.
  let ownKey: StoredSshKey | undefined;
  if (!secret('HOPPER_SSH_KEY_FILE')) {
    try {
      ownKey = ensureOwnSshKey({ stored: () => store.settings.getSshKey(), store: (k) => store.settings.setSshKey(k), dataDir });
    } catch (e) {
      logger.warn(`hopper: no ssh key of the hopper's own could be made (${e instanceof Error ? e.message : String(e)}); ssh targets are reached with the keys ~/.ssh holds`);
    }
  }
  // How the hopper proves itself to an ssh target, asked at every connection (design.md "Target authentication").
  const sshAuth = () => hopperSshAuth({ env: secret, dataDir });
  // The hopper's link key for this user (issue #308): minted once and kept in the user's store, like the
  // hopper's own ssh key; its public half is what a joining machine is given. A client target's token is
  // derived from it and the machine key, at each call.
  let linkKey = store.settings.getLinkKey();
  if (!linkKey) { linkKey = mintLinkKey(); store.settings.setLinkKey(linkKey); }
  const hopperLink = linkKey;
  const clientTransport = (machine: string, key: string): ClientTransport => ({
    machine, link: () => o.links.link(user.id, key), token: () => linkToken(hopperLink.privateKey, key),
  });
  let clientTargets = (): AttachedMachine[] => [];
  /** The client target named `machine` now, reached down its link; undefined when none is. */
  const clientNamed = (machine: string): ClientTransport | undefined => {
    const m = clientTargets().find((t) => t.name === machine);
    return m && 'client' in m ? clientTransport(m.name, m.client.key) : undefined;
  };
  const keepClient = createClientReleaseKeeper({ release: o.clientRelease, logger });
  let executorNames = (): string[] => [];
  let jobsOnMachine = (_name: string): string[] => [];
  let applyJobSources = (_built: BuiltJobSource[]): void => {};
  // How the hopper reaches each attached machine (issue #74: the machine-source context's `target`).
  const target = createTargetPool({
    clock, logger,
    // A client target that dials in is probed at once, not at the next 30 s.
    reachedAt: (m) => ('client' in m ? o.links.dialledAt(user.id, m.client.key) : 0),
    probe: seams.machineProbe
      ?? ((m) => ('client' in m
        ? keepClient(clientTransport(m.name, m.client.key), () => jobsOnMachine(m.name).length > 0)
        : 'docker' in m
          ? probeContainer({ container: m.docker, dockerHost: () => dockerHost(secret) }).then((online) => ({ online }))
          // An ssh target's home comes with every probe: `~` in a job's work tree resolves there (issue #323).
          // One after the other, over the one shared ssh connection.
          : probeSsh({ target: m.ssh, controlDir: join(dataDir, 'ssh'), auth: sshAuth }).then(async (found) => ({
            online: m.herdr ? await probeHerdrOverSsh({ target: m.ssh, session: m.session, controlDir: join(dataDir, 'ssh'), auth: sshAuth }) : true,
            ...found,
          })))),
  });
  // The GitHub account the user's work comes through (issue #214): from signing in with it, or
  // connected from Sources, through the hopper's app; their job sources and jobs ask here for tokens.
  const connectedAccounts = createConnectedAccounts({
    // GitHub App user tokens expire after 8 h (issues #358, #441): renewed with the refresh token, sealed at rest.
    store, apps: config.hopperApps, clock, logger, ...fromRuntime(config.hopperApps, o.env, logger),
    whoIs: (provider, token) => whoIs(config.hopperApps[provider], token),
    installations: (token) => installations(config.hopperApps.github, token),
    onExpired: (provider, account, reason) => { store.events.append({ type: 'connected_account.expired', data: { provider, account, reason } }); },
    onRenewed: () => { void engine.renewCredentials(); }, // running jobs get the new token on their machines (issue #441); after `engine` exists
    ...(o.linkIdentity ? { link: o.linkIdentity } : {}),
    // Reached only after `sync` exists: a connection is made long after the runtime starts.
    onChange: (provider) => {
      for (const s of sync.statuses().filter((j) => j.kind === `${provider}-account`)) void sync.syncNow(s.name).catch(() => undefined);
    },
  });
  const notEnded = () => store.jobs.list({ status: [...IN_FLIGHT_STATUSES] });
  const builtin = builtinInstances(config.answerTimeoutMs, config.localMachine);
  const host = createPluginHost({
    ...(config.pluginDir ? { pluginDir: config.pluginDir } : {}), installedDir: o.installedDir,
    config: store.config, dataDir, clock, logger, userEnv: cliEnv,
    defaultMachines: builtin.machines, defaultExecutors: builtin.executors,
    kit: createDetectionKit({ env: { ...o.env, ...cliEnv }, secret, secretName: (n) => `${user.secretPrefix}${n}` }),
    builtins: withSeams(seams),
    jobSourceContext: { ...storeSourceContext(store, o.otherUsersKnow), connectedAccounts },
    machineContext: { executors: () => executorNames(), target },
    executorContext: { client: clientNamed },
    intervalMs: o.pluginsConfigIntervalMs,
    // The job sources follow the plugins config live (issue #356); reached only after `sync` exists.
    jobSourcesChanged: (built) => applyJobSources(built),
    executorInUse: (name) => notEnded().filter((j) => j.spec.executor === name).map((j) => j.id),
    attached: {
      inUse: (name) => jobsOnMachine(name), pinned: (name) => notEnded().filter((j) => j.spec.machineId === name).map((j) => j.id),
      sshAuth, ...(seams.resolveTarget ? { resolveTarget: seams.resolveTarget } : {}), ...(seams.hostKeyOffer ? { hostKeyOffer: seams.hostKeyOffer } : {}),
      publicKey: () => (secret('HOPPER_SSH_KEY_FILE') ? undefined : ownKey?.publicKey),
      startSession: seams.herdrSession ?? ((s) => startHerdrSession(s, cliEnv)),
      localMachine: config.localMachine,
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
  clientTargets = () => host.targets();
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
  let { running, fixed } = splitSources(host.jobSources());
  const jobSources = () => [...running.map((r) => r.source), ...(seams.sources ?? [])];
  // A job's source as the sync loop has it now: a removed one still answers for its own jobs (issue #356).
  const sourceOf = (job: Job) => sync.source(job.source?.source ?? '');
  const engine: Engine = createEngine({
    store, clock, executors, router, questions, queueSorter: host.queueSorter,
    routing: { rules: () => host.routingRules(), machines: () => host.machineIds() },
    ...(seams.fakeUsage ? { fakeUsage: seams.fakeUsage } : {}),
    // Every machine follows the plugins config without a restart (issues #18, #74); the pinned host keys with it.
    machines: { list: () => { pinned(host.targets()); return host.machines().list(); } },
    // The usage sources follow the plugins config live (issue #356).
    usage: () => [...host.usageSources(), ...(seams.fakeUsage ? [seams.fakeUsage] : [])],
    policy: {
      softLimit: config.softLimit, hardLimit: config.hardLimit, routerCheapBoost: config.routerCheapBoost,
      laneIdleGraceMs: config.laneIdleGraceMs, resumeBoost: config.resumeBoost, pacing: config.pacing,
    },
    tickMs: config.tickMs,
    maxQuestions: config.maxQuestions,
    keepPanes: config.keepPanes, reconnectGraceMs: config.reconnectGraceMs,
    // Completion is the job's source's to judge (issues #171, #187); a job of no source, or of one that does not judge, is complete.
    notComplete: async (job) => sourceOf(job)?.notComplete?.(job),
    // A job of a connected account acts through it (issue #214); any other job runs with nothing added.
    credentials: async (job) => sourceOf(job)?.credentials?.(job),
  });
  jobsOnMachine = (name) => engine.jobsOnMachine(name);
  const sync = createSourceSync({
    sources: jobSources(), host: engine.sourceHost, clock,
    pollMs: (name) => running.find((r) => r.source.name === name)?.pollMs ?? SEAM_SOURCE_POLL_MS,
  });
  applyJobSources = (built) => { ({ running, fixed } = splitSources(built)); sync.setSources(jobSources()); };
  const raw = runtimeSecrets(o.env);
  // Deliveries and notifiers from now on, so an instance event (update.applied at boot) reaches them.
  const stopFailureLog = logFailures(store);
  dispatcher.start();
  // Issue #378: the notifiers also read the questions open at the human (oldest first) and where each is answered.
  host.startNotifiers({ subscribe: (l) => store.events.subscribe(l), job: (id) => store.jobs.get(id), question: (id) => store.questions.get(id), waitingOnHuman: () => store.questions.list({ status: ['open'], order: 'oldest-first' }).filter((q) => q.tier === 'human'), answerUrl: o.answerUrl });
  const usageHistory = createUsageRecorder({
    readings: () => engine.getUsage(), sources: () => engine.getUsageSources(), history: store.usageHistory, clock, logger,
    // Read at every prune: a retention set in the UI applies without a restart (issue #356).
    retentionDays: () => store.settings.getHistoryRetentionDays() ?? DEFAULT_HISTORY_RETENTION_DAYS,
  });
  let started = false;
  let stopped: Promise<void> | undefined;
  return {
    user, store, engine, sources: sync, registry: withFixedStatuses(sync, () => fixed), plugins, host, questions, dispatcher, executors,
    connectedAccounts,
    usageHistory,
    webhooksEditor: createWebhooksEditor({ store }),
    // The variable the user's runtime reads: the subscription's, under the user's prefix.
    secretProblem: (secretEnv) => secretProblem(raw, `${user.secretPrefix}${secretEnv}`),
    machineLink: {
      hopperKey: hopperLink.publicKey,
      join: (j) => host.joinMachine(j),
      tokenFor: (key) => (host.targets().some((m) => 'client' in m && m.client.key === key) ? linkToken(hopperLink.privateKey, key) : undefined),
    },
    async start() {
      if (started) return;
      started = true;
      await engine.start();
      sync.start();
      usageHistory.start();
      connectedAccounts.start(); // the renewer (issue #441): a token that expired while the hopper was down renews at once
    },
    stop() {
      stopped ??= (async () => {
        await sync.stop();
        usageHistory.stop();
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
