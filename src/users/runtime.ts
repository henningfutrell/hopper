// One user's runtime (issue #158, design.md "Users: one hopper, separate users"): every part of theirs
// composed over their user store — the plugins config (written on the first start without one), plugin
// host, target pool, executors, question service, engine, job source sync, webhook dispatcher,
// notifiers, failure log. Nothing in it reads or writes another user's: their secrets under their
// secret prefix, their processes with their CLI config dirs, their herdr session.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Clock, EscalationLevel, Executor, ExecutorRegistry, PluginsView, QuestionService, ReviewServices, SourceRegistry,
  UserStore, WebhookDispatcher,
} from '../domain/ports.ts';
import { DEFAULT_HISTORY_RETENTION_DAYS, highFirst, IN_FLIGHT_STATUSES, jobPriorityTag, prioritySettingsOf, REVIEW_KINDS, type AttachedMachine, type ConnectedAccountProvider, type Job, type Question, type User, type WebhookSubscription } from '../domain/types.ts';
import { storeSourceContext } from './source-context.ts';
import type { Config } from '../config.ts';
import { createEngine, type Engine } from '../engine/index.ts';
import { logFailures } from '../engine/failure-log.ts';
import { createExecutorRegistry } from '../executors/index.ts';
import type { ClientTransport } from '../executors/client.ts';
import { linkToken, mintLinkKey } from '../client/link.ts';
import type { MachineLinks } from '../machines/links.ts';
import type { MachineJoin } from '../plugins/attached-edit.ts';
import { dockerHost } from '../executors/docker.ts';
import { hopperSshAuth, pinHostKeys } from '../executors/ssh.ts';
import { ensureOwnSshKey, type StoredSshKey } from '../executors/ssh-key.ts';
import { createClientReleaseKeeper, createTargetPool, withClientWorkTree, probeContainer, probeHerdrOverSsh, probeSsh } from '../machines/index.ts';
import type { ClientRelease } from '../client/release.ts';
import { builtinInstances, ensurePluginsConfig } from '../plugins/builtin-instances.ts';
import { createDetectionKit } from '../plugins/detect.ts';
import { unavailableExecutors } from '../plugins/executor-slot.ts';
import { startHerdrSession } from '../plugins/machine-source/local/index.ts';
import { createPluginHost, type BuiltJobSource, type PluginHost } from '../plugins/index.ts';
import { splitSources } from './job-sources.ts';
import { createFailures, type Failures } from '../failures/index.ts';
import { createLogins, type Logins } from '../logins/index.ts';
import { createReviewServices } from '../review/index.ts';
import { createQuestionService } from '../questions/index.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { sealerOf } from '../secrets/sealer.ts';
import { TOKEN_KEY_VARIABLE } from '../secrets/token-box.ts';
import { createSourceSync, withFixedStatuses, type SourceSync } from '../sources/index.ts';
import { createConnectedAccounts, fromRuntime, type ConnectedAccountsService } from '../connected-accounts/service.ts';
import { installations, whoIs } from '../connected-accounts/identity.ts';

import { createUsageRecorder, type UsageRecorder } from '../usage/history.ts';
import { createWebhooksEditor, type WebhooksEditor } from '../webhooks/edit.ts';
import { createWebhookDispatcher, createWebhookSecrets } from '../webhooks/index.ts';
import { userCliEnv, userSecrets, userWorkDir } from './env.ts';
import { seamPlugins, withSeams, type UserSeams } from './seams.ts';

export type { UserSeams } from './seams.ts';

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
  /** Each review section's review: proposals (issue #537), research (issue #543). */
  reviews: ReviewServices;
  /** The escalation levels' names now: what may review a review section's items (issues #537, #543). */
  levelNames(): string[];
  /** The logins a job or run waits on (issue #476). */
  logins: Logins;
  /** The failure assessor (issue #509): every failed job judged, shared causes grouped into problems. */
  failures: Failures;
  dispatcher: WebhookDispatcher;
  executors: ExecutorRegistry;
  /** The user's connected GitHub account (issue #214). */
  connectedAccounts: ConnectedAccountsService;
  webhooksEditor: WebhooksEditor;
  /** Why a webhook subscription has no secret to sign with (issue #451); undefined when it has one. Never the secret. */
  secretProblem: (sub: WebhookSubscription) => string | undefined;
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
        ? keepClient(clientTransport(m.name, m.client.key), () => jobsOnMachine(m.name).length > 0).then((p) => withClientWorkTree(clientTransport(m.name, m.client.key), m.workTree, p))
        : 'docker' in m
          ? probeContainer({ container: m.docker, dockerHost: () => dockerHost(secret) }).then((online) => ({ online }))
          // An ssh target's home comes with every probe: `~` in a job's work tree resolves there (issue #323);
          // and its work tree is made there (issue #361). One after the other, over the one shared ssh connection.
          : probeSsh({ target: m.ssh, controlDir: join(dataDir, 'ssh'), auth: sshAuth, ...(m.workTree !== undefined ? { workTree: m.workTree } : {}) }).then(async (found) => ({
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
  // The webhook signing secrets (issue #451): sealed in the user's store under the runtime's token key; one
  // an older key sealed is sealed again under the current one now. A subscription from before reads its variable.
  const keys = sealerOf(runtimeSecrets(o.env));
  if (keys.problem) logger.warn(`hopper: ${keys.problem}: webhook signing secrets cannot be stored, and a stored one is not opened`);
  const webhookSecrets = createWebhookSecrets({ store, keys, runtime: runtimeSecrets(o.env), prefix: user.secretPrefix, logger });
  const resealed = webhookSecrets.resealAll();
  if (resealed > 0) logger.info(`hopper: ${resealed} webhook signing secret(s) sealed again under the current ${TOKEN_KEY_VARIABLE}`);
  const dispatcher = createWebhookDispatcher({ store, clock, secretOf: (sub) => webhookSecrets.of(sub), baseMs: config.webhookBaseMs });
  // The service calls the engine and the engine calls the service: the engine's handlers are
  // reached through closures that run only after `engine` exists (design.md "Construction
  // contract added").
  // The logins (issue #476): a login a job or an escalation level's run waits on, never a question.
  const logins = createLogins({ store, clock });
  const questions = createQuestionService({
    store, clock, levels, logins, stageTimeoutMs: config.answerTimeoutMs, config: store.config,
    renotifyMs: config.humanRenotifyMs, humanTimeoutMs: config.humanTimeoutMs,
    answerUrl: o.answerUrl,
    onAnswered: (q: Question) => engine.onAnswered(q),
    onExpired: (q: Question) => engine.onExpired(q),
    onDismissed: (q: Question) => engine.onDismissed(q),
  });
  // Each review section's review (issues #537, #543): the escalation levels its settings name review; the engine ends,
  // moves on or re-queues the job.
  const reviews = createReviewServices({
    store, clock, levels, logins, stageTimeoutMs: config.answerTimeoutMs, config: store.config,
    onDecided: (p) => engine.onDecided(p), onRevise: (p, brief) => engine.onRevise(p, brief),
  });
  let { running, fixed } = splitSources(host.jobSources());
  const jobSources = () => [...running.map((r) => r.source), ...(seams.sources ?? [])];
  // A job's source as the sync loop has it now: a removed one still answers for its own jobs (issue #356).
  const sourceOf = (job: Job) => sync.source(job.source?.source ?? '');
  const engine: Engine = createEngine({
    store, clock, executors, router, questions, reviews, logins, queueSorter: host.queueSorter,
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
    // Read at each Decision; reached only after `failures` exists.
    problems: () => failures.blocks(),
  });
  jobsOnMachine = (name) => engine.jobsOnMachine(name);
  const sync = createSourceSync({
    sources: jobSources(), host: engine.sourceHost, clock,
    pollMs: (name) => running.find((r) => r.source.name === name)?.pollMs ?? SEAM_SOURCE_POLL_MS,
  });
  // The failure assessor (issue #509): its runs again go through the sync loop's Run again.
  const failures = createFailures({
    store, clock, logger, sweepMs: config.tickMs,
    rerun: (jobId, by) => sync.rerun(jobId, by), dismiss: (jobId) => { engine.dismiss(jobId); },
    machines: () => host.machines().list(), itemClosed: async (job) => sourceOf(job)?.itemClosed?.(job),
    trigger: (reason) => engine.trigger(reason),
  });
  applyJobSources = (built) => { ({ running, fixed } = splitSources(built)); sync.setSources(jobSources()); };
  // Deliveries and notifiers from now on, so an instance event (update.applied at boot) reaches them.
  const stopFailureLog = logFailures(store);
  dispatcher.start();
  // Issue #378: the notifiers also read the questions open at the human (oldest first) and where each is answered.
  host.startNotifiers({ subscribe: (l) => store.events.subscribe(l), job: (id) => store.jobs.get(id), question: (id) => store.questions.get(id), waitingOnHuman: () => highFirst(store.questions.list({ status: ['open'], order: 'oldest-first' }).filter((q) => q.tier === 'human'), (q) => jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), q.jobId)?.high === true), answerUrl: o.answerUrl, highPriority: () => prioritySettingsOf(store.settings.getPriorityLanes()).highPriority });
  const usageHistory = createUsageRecorder({
    readings: () => engine.getUsage(), sources: () => engine.getUsageSources(), history: store.usageHistory, clock, logger,
    // Read at every prune: a retention set in the UI applies without a restart (issue #356).
    retentionDays: () => store.settings.getHistoryRetentionDays() ?? DEFAULT_HISTORY_RETENTION_DAYS,
  });
  let started = false;
  let stopped: Promise<void> | undefined;
  return {
    user, store, engine, sources: sync, registry: withFixedStatuses(sync, () => fixed), plugins, host, questions, reviews, logins, failures, dispatcher, executors,
    levelNames: () => levels().map((l) => l.name),
    connectedAccounts,
    usageHistory,
    webhooksEditor: createWebhooksEditor({ store, secrets: webhookSecrets, logger }),
    secretProblem: (sub) => webhookSecrets.problem(sub),
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
      failures.start();
      connectedAccounts.start(); // the renewer (issue #441): a token that expired while the hopper was down renews at once
    },
    stop() {
      stopped ??= (async () => {
        await failures.stop();
        await sync.stop();
        usageHistory.stop();
        connectedAccounts.stop();
        await questions.stop();
        await Promise.all(REVIEW_KINDS.map((k) => reviews[k].stop()));
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
