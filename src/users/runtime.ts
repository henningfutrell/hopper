// One user's runtime (issue #158, design.md "Users: one hopper, separate users"): every part of theirs
// composed over their user store — the plugins config (written on the first start without one), plugin
// host, target pool, executors, question service, engine, job source sync, webhook dispatcher,
// notifiers, failure log. Nothing in it reads or writes another user's: their secrets under their
// secret prefix, their processes with their CLI config dirs, their herdr session.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Clock, EscalationLevel, ExecutorRegistry, PluginsView, QuestionService, ReviewServices, SourceRegistry,
  UserStore, WebhookDispatcher, CredentialMinter,
} from '../domain/ports.ts';
import { doneAtSource, highFirst, IN_FLIGHT_STATUSES, jobPriorityTag, judge, overAtSource, prioritySettingsOf, REVIEW_KINDS, type AttachedMachine, type ConnectedAccountProvider, type Job, type MachineSnapshot, type Question, type VaultAccess, type User, type WebhookSubscription } from '../domain/types.ts';
import { storeSourceContext } from './source-context.ts';
import type { Config } from '../config.ts';
import { createEngine, type Engine } from '../engine/index.ts';
import { logFailures } from '../engine/failure-log.ts';
import { linkToken } from '../client/link.ts';
import type { MachineLinks } from '../machines/links.ts';
import type { MachineJoin } from '../plugins/attached-edit.ts';
import { dockerHost } from '../executors/docker.ts';
import { hopperSshAuth, pinHostKeys } from '../executors/ssh.ts';
import { ensureOwnSshKey, type StoredSshKey } from '../executors/ssh-key.ts';
import { createClientReleaseKeeper, createTargetPool, withClientWorkTree, probeContainer, probeHerdrOverSsh, probeSsh } from '../machines/index.ts';
import type { ClientRelease } from '../client/release.ts';
import { builtinInstances, ensurePluginsConfig } from '../plugins/builtin-instances.ts';
import { createDetectionKit } from '../plugins/detect.ts';
import { startHerdrSession } from '../plugins/machine-source/local/index.ts';
import { createPluginHost, type BuiltJobSource, type PluginHost } from '../plugins/index.ts';
import { splitSources } from './job-sources.ts';
import { createFailures, type Failures } from '../failures/index.ts';
import { createLogins, type Logins } from '../logins/index.ts';
import { createReviewServices } from '../review/index.ts';
import { createMinorDecisions, type MinorDecisions, type TypesafeKey } from '../minor-decisions/index.ts';
import { userTypesafeKey } from './typesafe-key.ts';
import { createQuestionService } from '../questions/index.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { sealerOf } from '../secrets/sealer.ts';
import { MASTER_KEY_VARIABLE } from '../secrets/token-box.ts';
import { createSourceSync, withFixedStatuses, type SourceSync } from '../sources/index.ts';
import { accountEvents, createConnectedAccounts, fromRuntime, type ConnectedAccountsService } from '../connected-accounts/service.ts';
import { createUserGitHubProxy, type UserGitHubProxy } from './github-proxy.ts';
import { createUserLink } from './link.ts';
import { installations, whoIs } from '../connected-accounts/identity.ts';

import { createHistoryRecorders, type ResourceRecorder, type UsageRecorder } from './history.ts';
import { createWebhooksEditor, type WebhooksEditor } from '../webhooks/edit.ts';
import { createWebhookDispatcher, createWebhookSecrets } from '../webhooks/index.ts';
import { approvalWait, clientTargets as vaultTargets, openUserVault, type Vault } from '../vault/index.ts';
import type { JobStream } from '../job-stream/index.ts';
import { openJobStream } from './job-stream.ts';
import { artifactUrl, type UserArtifacts } from '../artifacts/index.ts';
import { userArtifactKey } from './artifact-key.ts';
import { liveExecutors } from './executors.ts';
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
  /** The base of an artifact's link in a notification, given the user's link base (issue #673). */
  artifactLinkBase(linkBase: string): string;
  /** A GitHub account this user connected from Sources: link it, so signing in with it lands here (issue #214). */
  linkIdentity?(provider: ConnectedAccountProvider, subject: string): void;
  /** Of these source keys, those another user of this hopper has a job for (issue #440): a claim may be theirs. */
  otherUsersKnow?(keys: string[]): Set<string>;
  /**
   * The hopper's URL as a job on `machine` reaches it (issue #563): `dialled`, the URL a client target dialled in
   * at. Undefined: the machine cannot reach the hopper, and its jobs get no GitHub proxy. Absent: none.
   */
  proxyUrl?(machine: MachineSnapshot, dialled: string | undefined): string | undefined;
  /**
   * Access (the instance's, issue #559): where the vault's gate approves a template's operation profiles (issue #584),
   * and what the vault asks before every mint (issue #580); `minter` mints (STS, the Kubernetes API).
   */
  access?: VaultAccess; minter?: CredentialMinter;
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
  /** Decider calls, Jev first (issue #550). */
  minorDecisions: MinorDecisions;
  /** The TypeSafe API key Jev asks with (issue #657): kept in the vault's system scope, set on the Jev page. */
  typesafeKey: TypesafeKey;
  dispatcher: WebhookDispatcher;
  executors: ExecutorRegistry;
  /** The user's connected GitHub account (issue #214). */
  connectedAccounts: ConnectedAccountsService;
  webhooksEditor: WebhooksEditor;
  /** Why a webhook subscription has no secret to sign with (issue #451); undefined when it has one. Never the secret. */
  secretProblem: (sub: WebhookSubscription) => string | undefined;
  /** The user's machines dialling in (issue #308): the hopper's public half, a machine joining, a dial-in's token. */
  machineLink: UserMachineLink;
  vault: Vault; // issue #558: write-only secrets; issue #586: in the hopper or in a container of its own
  /** The job stream (issue #613): what the user's running jobs subscribe to, and the sweep of its watches. */
  jobStream: JobStream;
  /** The artifacts the user's jobs make for a person to see (issue #624); their sweep starts and stops with the job stream. */
  artifacts: UserArtifacts;
  /** The usage history's recorder (issue #385): `record` and `prune` now, in tests. */
  usageHistory: UsageRecorder;
  /** The resource recorder (issue #560): `record` and `prune` now, in tests. */
  machineHistory: ResourceRecorder;
  /** The GitHub proxy's view of this user (issue #563). */
  githubProxy: UserGitHubProxy;
  /** Start the loops: engine and source sync (the dispatcher and notifiers run from creation). Once. */
  start(): Promise<void>;
  /** Stop every loop and part; close the user's store. Once. */
  stop(): Promise<void>;
}

const SEAM_SOURCE_POLL_MS = 1000;
/** One Jev pick: a TypeSafe call, the Python start included. Past it, no pick: the decision goes on as before. */
const JEV_TIMEOUT_MS = 30_000;

/** Build one user's parts; start the plugin host, the webhook dispatcher and the notifiers. The engine and source sync start with `start()`. */
export async function createUserRuntime(o: UserRuntimeOptions): Promise<UserRuntime> {
  const { user, store, config, seams, clock, logger } = o;
  // The plugins config is the one truth: the built-in instances are written on the start that finds none.
  ensurePluginsConfig({ config: store.config, answerTimeoutMs: config.answerTimeoutMs, localMachine: config.localMachine, userId: user.id, logger });
  // Every secret comes from the runtime, under the user's prefix (issue #56, #158) — but the TypeSafe API key, the
  // hopper's own (issue #657), kept in the vault's system scope.
  const keys = sealerOf(runtimeSecrets(o.env));
  const { jev, typesafeKey, secret } = userTypesafeKey({
    user, store, env: o.env, runtime: userSecrets(o.env, user), keys, ...(o.access ? { access: o.access } : {}),
    ...(seams.jev ? { seamJev: seams.jev } : {}), timeoutMs: JEV_TIMEOUT_MS, clock, logger,
  });
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
  // The hopper's link key for this user (issue #308), and its client targets reached down their links.
  let clientTargets = (): AttachedMachine[] => [];
  const link = createUserLink({ store, links: o.links, userId: user.id, targets: () => clientTargets() });
  const { key: hopperLink, transport: clientTransport, named: clientNamed } = link;
  const keepClient = createClientReleaseKeeper({ release: o.clientRelease, logger });
  let executorNames = (): string[] => [];
  let jobsOnMachine = (_name: string): string[] => [];
  let applyJobSources = (_built: BuiltJobSource[]): void => {};
  // How the hopper reaches each attached machine (issue #74: the machine-source context's `target`).
  const target = createTargetPool({
    // A box of a template not approved takes no new job (issue #602): the template's approval, read at every list.
    clock, logger, templateWait: (name) => approvalWait(name, store.vault.template(name)),
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
    store, apps: config.hopperApps, clock, logger, ...fromRuntime(config.hopperApps, o.env),
    whoIs: (provider, token) => whoIs(config.hopperApps[provider], token),
    installations: (token) => installations(config.hopperApps.github, token),
    // Its end, each renewal and each failed renewal are recorded (issues #358, #647), never with a token.
    ...accountEvents(store.events),
    ...(o.linkIdentity ? { link: o.linkIdentity } : {}),
    // Reached only after `sync` exists: a connection is made long after the runtime starts.
    onChange: (provider) => {
      for (const s of sync.statuses().filter((j) => j.kind === `${provider}-account`)) void sync.syncNow(s.name).catch(() => undefined);
    },
  });
  // The GitHub proxy (issue #563): a client target's jobs reach the hopper where it dialled in.
  const proxy = createUserGitHubProxy({ user, store, linkPrivateKey: hopperLink.privateKey, accounts: connectedAccounts, url: (m) => o.proxyUrl?.(m, link.dialled(m.id)) });
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
  const executors = liveExecutors(host, seams.executors ?? []);
  executorNames = () => executors.names();
  const plugins: PluginsView = seams.router ? seamPlugins(seams.router, host) : host;
  const router = seams.router ?? host.router;
  // Seam doubles win over the host's live instances (looked up per question).
  const levels = (): readonly EscalationLevel[] => seams.levels ?? host.levels();
  // The webhook signing secrets (issue #451): sealed in the user's store under the runtime's master key; one
  // an older key sealed is sealed again under the current one now. A subscription from before reads its variable.
  if (keys.problem) logger.warn(`hopper: ${keys.problem}: webhook signing secrets cannot be stored, and a stored one is not opened`);
  const webhookSecrets = createWebhookSecrets({ store, keys, runtime: runtimeSecrets(o.env), prefix: user.secretPrefix, logger });
  const resealed = webhookSecrets.resealAll();
  if (resealed > 0) logger.info(`hopper: ${resealed} webhook signing secret(s) sealed again under the current ${MASTER_KEY_VARIABLE}`);
  const dispatcher = createWebhookDispatcher({ store, clock, secretOf: (sub) => webhookSecrets.of(sub), baseMs: config.webhookBaseMs });
  // The service calls the engine and the engine calls the service: the engine's handlers are
  // reached through closures that run only after `engine` exists (design.md "Construction
  // contract added").
  // The logins (issue #476): a login a job or an escalation level's run waits on, never a question.
  const logins = createLogins({ store, clock });
  // Decider calls (issue #550) go through Jev first, through TypeSafe with the user's TypeSafe API key (issue #657).
  const minorDecisions: MinorDecisions = createMinorDecisions({ store, clock, logger, timeoutMs: JEV_TIMEOUT_MS, jev, typesafeKey: () => typesafeKey.view() });
  // Read at each question and failure: reached only after `engine` exists.
  const gated = (machineId: string): boolean => engine.blastRadius.gates(machineId);
  const questions = createQuestionService({
    store, clock, levels, logins, stageTimeoutMs: config.answerTimeoutMs, config: store.config, minorDecisions: { first: minorDecisions, gated },
    renotifyMs: config.humanRenotifyMs, humanTimeoutMs: config.humanTimeoutMs,
    answerUrl: o.answerUrl,
    onAnswered: (q: Question) => engine.onAnswered(q),
    onExpired: (q: Question) => engine.onExpired(q),
    // onShift: a level's suggested phase shift (issue #548), made when the phase-shift settings allow the level.
    onDismissed: (q: Question) => engine.onDismissed(q), onCorrected: (q: Question) => engine.onCorrected(q), onShift: (q, suggest, by) => engine.phaseShifts.byLevel(q, suggest, by),
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
  const vault = await openUserVault({ ...o.config, env: o.env, user: user.id, store, access: o.access, ...(o.minter ? { minter: o.minter } : {}), clock, logger, targets: () => vaultTargets(host.targets()), holds: (p) => proxy.githubProxy.user.holds(p), backends: () => host.vaultBackends() });
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
    maxQuestions: config.maxQuestions, keepPanes: config.keepPanes, reconnectGraceMs: config.reconnectGraceMs, doneRecheckMs: config.doneRecheckMs,
    // Completion is the job's source's to judge (issues #171, #187, #579); a job of no source, or of one that does not judge, is complete.
    verdict: (job) => judge(sourceOf(job), job),
    // Before a nudge (issue #627): the job's work over at its source, or a credential a person is asked for.
    overAtSource: (job) => overAtSource(sourceOf(job), job), credentialRequests: () => vault.view().requests ?? [],
    // Every job on a machine that reaches the hopper asks it for GitHub (issue #563): its token, the script, the URL, and
    // git's way to GitHub through it (issue #652). No job holds a GitHub token of its own.
    // A box's blast radius includes its template's rating (issue #605), read live from the vault.
    jobProxy: proxy.jobProxy, boxRadius: (machine) => vault.boxRadius(machine),
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
    // Continue (issue #551): the job's own agent session resumes where the engine says it can.
    rerun: sync.rerun, continueJob: sync.continueJob, finishShipped: (jobId, result) => engine.sourceHost.finishShipped(jobId, result),
    resumable: (job) => engine.resumable(job), dismiss: (jobId) => { engine.dismiss(jobId); }, machines: () => host.machines().list(),
    workState: async (job) => sourceOf(job)?.workState?.(job), pullRequestOpen: async (job) => sourceOf(job)?.pullRequestOpen?.(job), doneAtSource: (job) => doneAtSource(sourceOf(job), job),
    trigger: (reason) => engine.trigger(reason), minorDecisions: { first: minorDecisions, gated },
  });
  applyJobSources = (built) => { ({ running, fixed } = splitSources(built)); sync.setSources(jobSources()); };
  // Deliveries and notifiers from now on, so an instance event (update.applied at boot) reaches them.
  const stopFailureLog = logFailures(store);
  dispatcher.start();
  // Issue #378: the notifiers also read the questions open at the human (oldest first) and where each is answered.
  host.startNotifiers({ subscribe: (l) => store.events.subscribe(l), job: (id) => store.jobs.get(id), question: (id) => store.questions.get(id), waitingOnHuman: () => highFirst(store.questions.list({ status: ['open'], order: 'oldest-first' }).filter((q) => q.tier === 'human'), (q) => jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), q.jobId)?.high === true), answerUrl: o.answerUrl, highPriority: () => prioritySettingsOf(store.settings.getPriorityLanes()).highPriority,
    artifactUrl: (id) => artifactUrl(o.artifactLinkBase(store.artifacts.settings().linkBase), id) });
  // The usage history (issue #385) and machine resources over time (issue #560): the machines as the engine lists them.
  const history = createHistoryRecorders({
    readings: () => engine.getUsage(), sources: () => engine.getUsageSources(), machines: () => host.machines().list(), store, clock, logger,
  });
  // The key content URLs are signed under, kept in the vault's system scope (issue #673).
  const contentKey = userArtifactKey({ userId: user.id, store, keys, clock, logger });
  const { jobStream, artifacts } = openJobStream({ userId: user.id, store, clock, logger, contentKey, ...(seams.jobStream?.inlineMax !== undefined ? { inlineMax: seams.jobStream.inlineMax } : {}) });
  let started = false, stopped: Promise<void> | undefined;
  return {
    jobStream, artifacts, githubProxy: proxy.githubProxy,
    user, store, engine, sources: sync, registry: withFixedStatuses(sync, () => fixed), plugins, host, questions, reviews, logins, failures, minorDecisions, typesafeKey, dispatcher, executors,
    levelNames: () => levels().map((l) => l.name), connectedAccounts,
    ...history.recorders,
    webhooksEditor: createWebhooksEditor({ store, secrets: webhookSecrets, logger }),
    secretProblem: (sub) => webhookSecrets.problem(sub), vault, // issues #558, #585, #586
    machineLink: {
      hopperKey: hopperLink.publicKey,
      join: (j) => host.joinMachine(j),
      tokenFor: (key) => (host.targets().some((m) => 'client' in m && m.client.key === key) ? linkToken(hopperLink.privateKey, key) : undefined),
    },
    async start() {
      if (started) return;
      started = true;
      await engine.start();
      await failures.backfill.once(); // the done-check backfill (issue #637), before the sync and the assessor judge the same failures
      sync.start();
      history.start(); minorDecisions.start();
      failures.start();
      connectedAccounts.start(); // the renewer (issue #441): a token that expired while the hopper was down renews at once
      jobStream.start();
    },
    stop() {
      stopped ??= (async () => {
        jobStream.stop();
        await failures.stop();
        minorDecisions.stop();
        await sync.stop();
        history.stop();
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
