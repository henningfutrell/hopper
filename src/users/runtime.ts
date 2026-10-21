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
import { doneAtSource, highFirst, IN_FLIGHT_STATUSES, jobPriorityTag, judge, overAtSource, prioritySettingsOf, REVIEW_KINDS, type AttachedMachine, furtherAccount, providerOfKey, type ConnectedAccountProvider, type Job, type MachineSnapshot, type Question, type VaultAccess, type IntakeAccess, type User, type WebhookSubscription } from '../domain/types.ts';
import { pullRequestSettings, storeSourceContext } from './source-context.ts';
import type { Config } from '../config.ts';
import { createEngine, type Engine } from '../engine/index.ts'; import type { JobMoveData } from '../engine/lost-move.ts'; import type { JobRunData } from '../engine/job-run.ts';
import { logFailures } from '../engine/failure-log.ts'; import { createJobTerminal, type JobTerminal } from '../engine/terminal.ts'; import { createMachineTerminal, type MachineTerminal } from '../engine/machine-terminal.ts';
import { linkToken } from '../client/link.ts';
import type { MachineLinks } from '../machines/links.ts'; import { laneSignIn } from '../machines/lane-pool.ts';
import type { MachineJoin } from '../plugins/attached-edit.ts'; import { machineLeave, type MachineLeaveAnswer } from './machine-leave.ts';
import { hopperSshAuth, pinHostKeys } from '../executors/ssh.ts';
import { createTopologyDiscovery, type DiscoverAnswer, type TopologyDiscovery } from '../infra-plans/topology-discovery.ts'; import { createTopologyReader } from '../infra-plans/topology-reader.ts'; import { readClusters } from '../vault/clusters.ts'; import type { ContainerRuntime } from '../domain/sandboxes.ts'; import { readPodmanHosts } from '../sandbox/podman-hosts.ts'; import { createPodmanHostRuntime } from '../sandbox/podman-host.ts'; import { createSshStepHost, createWindowsSteps, NO_WINDOWS_STEPS, readWindowsHosts, type WindowsStepLedger, type WindowsSteps } from '../windows-steps/index.ts'; import { createNeedSteps, NO_NEED_STEPS, type NeedSteps } from '../sandbox/need-steps.ts'; import { createBastions, type Bastions } from '../sandbox/bastions.ts'; import { approvedTarget } from '../sandbox/bastion.ts'; import { userCommandBoxes } from './command-boxes.ts';
import { ensureOwnSshKey, type StoredSshKey } from '../executors/ssh-key.ts';
import { createClientReleaseKeeper, createOwnedHerdrKeeper, createTargetPool, probeOwnedHerdr, withClientWorkTree, probeSsh } from '../machines/index.ts';
import type { ClientRelease } from '../client/release.ts';
import { builtinInstances, ensurePluginsConfig } from '../plugins/builtin-instances.ts';
import { createDetectionKit } from '../plugins/detect.ts';
import { startHerdrSession } from '../plugins/machine-source/local/index.ts';
import { createPluginHost, type BuiltJobSource, type PluginHost } from '../plugins/index.ts';
import { splitSources } from './job-sources.ts';
import { checksRedOf, createFailures, type Failures } from '../failures/index.ts'; import { giveBackChecks } from '../failures/give-backs.ts';
import { createLastAccounts, createLogins, createSignIns, setupTokenSignIn, type Logins, type SignIns } from '../logins/index.ts';
import { createReviewServices } from '../review/index.ts';
import { createMinorDecisions, type MinorDecisions, type TypesafeKey } from '../minor-decisions/index.ts';
import { userTypesafeKey } from './typesafe-key.ts';
import { openTldrs, type Tldrs } from '../tldr/haiku.ts'; import { createItemReconciler } from '../work-items/reconcile.ts';
import { openUserSystemSecrets } from './system-secrets.ts';
import { withSystemScope } from '../vault/system-view.ts';
import type { SystemSecrets } from '../vault/system.ts';
import { answerSignedOut, createQuestionService } from '../questions/index.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { createDirectPullRequests, createSourceSync, followEvery, withFixedStatuses, type SourceSync } from '../sources/index.ts';
import type { AccountSet } from '../connected-accounts/account-set.ts'; import { userAccounts } from './connected-accounts.ts'; import { furtherAccountSources, gitlabAccountSources } from './further-sources.ts'; import { createGitLabAccount, type GitLabAccount } from '../gitlab/account.ts';
import { createUserGitHubProxy, type UserGitHubProxy } from './github-proxy.ts';
import { createUserLink, type UserLink } from './link.ts';

import { createHistoryRecorders, type ResourceRecorder, type UsageRecorder } from './history.ts'; import type { WindowsLinkWatch } from '../machines/windows-link-watch.ts';
import { createWebhooksEditor, type WebhooksEditor } from '../webhooks/edit.ts';
import { createWebhookDispatcher, createWebhookSecrets } from '../webhooks/index.ts'; import { createOutbound, type Outbound, type OutboundGuard } from '../outbound/index.ts'; import { soleLease, type SweepLease } from '../domain/leases.ts'; import type { HostLeases } from '../sagas/index.ts';
import { approvalWait, clientTargets as vaultTargets, openUserVault, reconcilePass, type Vault } from '../vault/index.ts';
import type { JobStream } from '../job-stream/index.ts';
import { openJobStream } from './job-stream.ts';
import { artifactUrl, type UserArtifacts } from '../artifacts/index.ts';
import { liveExecutors } from './executors.ts';
import { userCliEnv, userSecrets, userWorkDir } from './env.ts';
import { seamPlugins, withSeams, type UserSeams } from './seams.ts';
import { machineLanesEditor } from './machine-lanes.ts'; import { traceJobs } from '../telemetry/jobs.ts'; import { recordOutcomes } from '../telemetry/outcomes.ts'; import { traceDeploys } from '../telemetry/deploys.ts';
import { createDirectJobs, type DirectJobs } from '../direct-jobs/index.ts'; import { createUserSearch, type SearchWiring, type UserSearch } from '../search/index.ts'; import { searchHitRoute } from '../domain/search.ts'; import { intakeOutcomeOf } from '../sources/intake-live.ts';
import { planNotice } from '../domain/infra-watchers.ts'; import { stampKeyOf } from '../domain/trust-stamp.ts'; import { createClaudeDrafter } from '../issue-drafts/claude.ts'; import { hostname } from 'node:os'; import type { SandboxRequests } from '../sandbox/requests.ts'; import { sandboxesHeld, holdSweep, userSandboxRequests, type SandboxLauncher } from './sandbox-requests.ts'; import { revokeOnQuarantine, stepsMayRun } from './quarantine.ts'; import { createFastForward, createPushLines } from '../git-mirror/push-lines.ts'; import { guardedVerdict } from '../domain/shrink-guard.ts';

export type { UserSeams } from './seams.ts';

/** A user's side of the machines that dial in (design.md "Joining a machine", issue #308). */
export interface UserMachineLink {
  /** The public half of the hopper's link key for this user: a joining machine derives its client token from it. */
  hopperKey: string;
  /** A machine joining with its machine key, under the name it asks for: the client target it is now. */
  join(j: MachineJoin): Promise<{ ok: true; machine: string } | { ok: false; error: string }>;
  /**
   * The client token of the client target holding this machine key; undefined when none does. `leave`: that machine
   * leaves (issue #1284): the jobs still on it, and whether it was retired.
   */
  tokenFor(key: string): string | undefined; leave(key: string): Promise<MachineLeaveAnswer>;
  /** The client target named `machine`, reached down its link, where it dialled in, and which are (issue #708: a box on it). */
  client: Pick<UserLink, 'named' | 'dialled' | 'dialledIn'>;
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
  /** Where the store installs are unpacked (the instance's); when this hopper's build was made, from its install record (issue #1147, the assessor's). */
  installedDir: string; installedAt?: () => string | undefined;
  /** How often the plugins config's version is checked. */
  pluginsConfigIntervalMs: number;
  /**
   * The base of a person's link, given the user's link base (issues #673, #712): a UI link to a view by its hash — one
   * question, `question-<id>`; the Logins view, `logins` (issue #698) — and an artifact's link. Notifications carry them.
   */
  linkBase(userLinkBase: string): string;
  /** Where the hopper is reached from outside now (issue #795, the tunnel watch). Search (issue #945): the index (absent: none), this hopper's instance id, and Access, which decides each hit. */
  reach?: () => string | undefined; search?: SearchWiring; stack?: () => Promise<import('../domain/stack-resources.ts').StackResources>; // the stack resources: the oldest user's stack-health watcher reads them (issue #1077)
  /** A GitHub account this user connected from Sources: link it, so signing in with it lands here (issue #214). */
  linkIdentity?(provider: ConnectedAccountProvider, subject: string): void;
  /** Whether the source email match is on (issue #1380), and infra applies (issue #1722): the instance's settings, read at each check. Absent: on. */
  sourceEmailMatch?(): boolean; infraApplies?(): boolean;
  /** Of these source keys, those another user of this hopper has a job for (issue #440): a claim may be theirs. */
  otherUsersKnow?(keys: string[]): Set<string>;
  /**
   * The hopper's URL as a job on `machine` reaches it (issues #563, #695): `dialled`, the URL a client target dialled in
   * at; `linkBase`, the user's (Settings → Artifacts). Undefined: the machine cannot reach the hopper, and its jobs get no
   * GitHub proxy. Absent: none.
   */
  proxyUrl?(machine: MachineSnapshot, dialled: string | undefined, linkBase: string): string | undefined;
  /** The hopper's addresses (issue #698): an ssh target's probe asks which one it reaches. Absent: not asked. */
  hopperUrls?(): string[]; wslHopperUrl?(): string | undefined; // and the address a WSL machine on the hopper's computer reaches it at (issue #1248 part 4); undefined: the hopper is not in WSL
  /** The hopper's network (issue #711): a machine off it is shown the command that joins it. Absent: none. */
  network?: string;
  /**
   * Access (the instance's, issue #559): where the vault's gate approves a template's operation profiles (issue #584),
   * and what the vault asks before every mint (issue #580); `minter` mints (STS, the Kubernetes API).
   */
  access?: VaultAccess & IntakeAccess; minter?: CredentialMinter;
  /** The whole hopper's system secrets (issue #658): the sign-in realms', shown on the vault's page; its shared secrets (issue #718). */
  instanceSecrets?: SystemSecrets; sharedSecrets?: Parameters<typeof openUserVault>[0]['shared'];
  /** What each box of this user was launched with, by machine name (issue #708): the vault gives it nothing else. Absent: no box is narrowed. `sandboxes`: a job's sandbox request starts its box there (issue #991); absent: none starts. */
  /** Begins a `job-move` saga for this user's job that moves off its lost machine (issue #1569). Absent: such a job fails. */
  /** This user's `job-run` sagas (issue #1662): a claim's run is one, driven on any hopper. Absent: each run is driven where it was claimed. */
  /** A person's topology discovery run (issue #1781 part 3): the saga begun and driven. */
  discoverTopology?: () => Promise<DiscoverAnswer | undefined>; jobMoves?: { begin(userId: string, key: string, data: JobMoveData): void }; jobRuns?: { begin(userId: string, key: string, data: JobRunData): boolean; open(userId: string, jobIds: readonly string[]): Set<string> }; sandboxes?: SandboxLauncher; windowsSteps?: WindowsStepLedger; outboundGuard: OutboundGuard; leases?: HostLeases; jobPods?: { join(pod: string): string; instanceId(): string }; // the process's (issue #1014); job pods (issue #1283): a join code naming a pod, absent none joins
}


/** One user's running parts: what the HTTP edge reads and changes for that user, and tests drive. */
export interface UserRuntime {
  user: User; store: UserStore; engine: Engine;
  /** The sync loop (syncNow in tests). */
  sources: SourceSync;
  /** Every job source's status, the ones that do not run included (/api/sources). */
  registry: SourceRegistry;
  plugins: PluginsView; host: PluginHost;
  questions: QuestionService;
  /** Each review section's review: proposals (issue #537), research (issue #543). */
  reviews: ReviewServices;
  /** The escalation levels' names now: what may review a review section's items (issues #537, #543). */
  levelNames(): string[];
  /** The logins a job or run waits on (issue #476), the tool sign-ins a person starts from Accounts, and the job's terminal (issue #1128). */
  logins: Logins; signIns: SignIns; terminal: JobTerminal; machineTerminal: MachineTerminal;
  /** The failure assessor (issue #509): every failed job judged, shared causes grouped into problems. */
  failures: Failures;
  /** Decider calls, Jev first (issue #550). */
  minorDecisions: MinorDecisions;
  /** The TypeSafe API key Jev asks with (issue #657): kept in the vault's system scope, set on the Jev page. */
  typesafeKey: TypesafeKey;
  /** The TL;DR of every long card (issue #569): its sweep. */
  tldrs: Tldrs;
  dispatcher: WebhookDispatcher; executors: ExecutorRegistry; outbound: Outbound; // the user's outbound sends (issue #1014)
  directJobs: DirectJobs; // issue #901: jobs a person submits straight to the hopper, with no GitHub issue
  /** The user's connected GitHub account (issue #214). */
  connectedAccounts: AccountSet;
  /** The user's GitLab account (issue #1448 part 2). */
  gitlabAccount: GitLabAccount;
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
  machineHistory: ResourceRecorder; windowsLink: WindowsLinkWatch; // the Windows link watch (issue #712): the keep-alive loop's reports
  /** The GitHub proxy's view of this user (issue #563). */
  githubProxy: UserGitHubProxy;
  /** A job's step run on a Windows host the user set up (issue #731); search (issue #945): the index kept from job events, and the permission-checked search; the boxes the user's jobs ask for (issue #991). */
  windowsSteps: WindowsSteps; podmanHost(name: string): ContainerRuntime | undefined; search: UserSearch; sandboxRequests: SandboxRequests; needSteps: NeedSteps; bastions: Bastions; topologyDiscovery: UserTopologyDiscovery; // a job's need steps (issue #1007), its bastion (issue #2146); topology discovery (issue #1781 part 3); a Podman host's runtime by name, read at each look (issue #2272)
  /** Start the loops: engine and source sync (the dispatcher and notifiers run from creation). Once. */
  start(): Promise<void>;
  /** Stop every loop and part; close the user's store. Once. */
  stop(): Promise<void>;
}

// The direct source (issue #901) pulls nothing, its jobs come through the route: a sync only retries a report that failed.
/** One user's topology discovery (issue #1781 part 3): its steps, and a run a person asks for. */
export type UserTopologyDiscovery = TopologyDiscovery & { discover(): Promise<DiscoverAnswer | undefined> }; const SEAM_SOURCE_POLL_MS = 1000, DIRECT_POLL_MS = 60_000;
/** One Jev pick: a TypeSafe call, the Python start included. Past it, no pick: the decision goes on as before. */
const JEV_TIMEOUT_MS = 30_000;

/** Build one user's parts; start the plugin host, the webhook dispatcher and the notifiers. The engine and source sync start with `start()`. */
export async function createUserRuntime(o: UserRuntimeOptions): Promise<UserRuntime> {
  const { user, store, config, seams, clock, logger } = o;
  const linkBase = (): string => o.linkBase(store.artifacts.settings().linkBase), uiUrl = (hash: string): string => `${linkBase()}/#${hash}`; // a person's links (issue #712)
  // The plugins config is the one truth: the built-in instances are written on the start that finds none.
  ensurePluginsConfig({ config: store.config, answerTimeoutMs: config.answerTimeoutMs, localMachine: config.localMachine, userId: user.id, logger });
  // Every secret comes from the runtime, under the user's prefix (issue #56, #158) — but the TypeSafe API key and the
  // GitHub App's private key, the hopper's own (issues #657, #1243), kept in the vault's system scope.
  // The hopper's own secrets are in the vault's system scope (issue #658): the old copies moved in at this start.
  const { system, keys, readBackends } = openUserSystemSecrets({ user, store, env: o.env, ...(o.access ? { access: o.access } : {}), clock, logger });
  const runtime = userSecrets(o.env, user);
  const { jev, typesafeKey, secret: withTypesafe } = userTypesafeKey({ user, store, env: o.env, runtime, system, ...(seams.jev ? { seamJev: seams.jev } : {}), timeoutMs: JEV_TIMEOUT_MS, clock, logger });
  const secret = withTypesafe;
  const dataDir = userWorkDir(config.workDir, user);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 }); const outbound = createOutbound({ guard: o.outboundGuard, clock, log: store.outboundSends }), lease = (name: string): SweepLease => o.leases?.lease(`${user.id}/${name}`) ?? soleLease(); // deliveries and notifier posts, into the send log (issue #1014)
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
  const commandBoxes = o.sandboxes && userCommandBoxes(user.id, o.sandboxes, join(dataDir, 'command-boxes')); // a container target's commands, each in a box of its own (issue #865)
  // The addresses an ssh target's probe asks (issues #695, #698): the user's link base (Settings → Artifacts) first, when
  // set, then the hopper's own; a job there gets only the one the probe found it reaches, the link base too.
  const wslAsked = (u = o.wslHopperUrl?.()): { wsl?: { url: string } } => (u ? { wsl: { url: u } } : {}); const sshCandidates = (urls: string[]): string[] => { const b = store.artifacts.settings().linkBase.replace(/\/+$/, ''); return b ? [b, ...urls.filter((u) => u !== b)] : urls; };
  // The hopper's link key for this user (issue #308), and its client targets reached down their links.
  let clientTargets = (): AttachedMachine[] => [];
  const link = createUserLink({ store, links: o.links, userId: user.id, targets: () => clientTargets() });
  // Trust stamps (issue #655): every job made from here on is stamped; a job that has not ended and has none is stamped now.
  const { key: hopperLink, transport: clientTransport, named: clientNamed } = link; const backfilled = store.jobs.useStampKey(stampKeyOf(hopperLink.privateKey, user.id)); if (backfilled.length) logger.info(`hopper: ${backfilled.length} job(s) of ${user.id} had no trust stamp and were stamped by the rules`);
  // Client targets on the hopper's client release (issue #545); ssh targets on the hopper's own herdr (issue #741).
  const keepClient = createClientReleaseKeeper({ release: o.clientRelease, logger }), keepHerdr = createOwnedHerdrKeeper({ logger });
  let executorNames = (): string[] => [];
  let jobsOnMachine = (_name: string): string[] => [];
  let applyJobSources = (_built: BuiltJobSource[]): void => {};
  // How the hopper reaches each attached machine (issue #74: the machine-source context's `target`).
  const target = createTargetPool({
    // A box of a template not approved takes no new job (issue #602): the template's approval, read at every list.
    clock, logger, templateWait: (name) => approvalWait(name, store.vault.template(name)), leaving: (key) => o.links.leaving(user.id, key), ...(o.network ? { network: o.network } : {}), probeEveryMs: seams.machineProbeEveryMs,
    // A client target that dials in is probed at once, not at the next 30 s.
    reachedAt: (m) => ('client' in m ? o.links.dialledAt(user.id, m.client.key) : 0),
    probe: seams.machineProbe
      ?? ((m) => ('client' in m
        ? keepClient(clientTransport(m.name, m.client.key), () => jobsOnMachine(m.name)).then((p) => withClientWorkTree(clientTransport(m.name, m.client.key), m.workTree, p))
        : 'image' in m
          // A container target (issue #865): online while a sandbox box can start for the user.
          ? (commandBoxes?.problem() ?? Promise.resolve('no sandbox module')).then((problem) => ({ online: problem === undefined }))
          // An ssh target's home comes with every probe: `~` in a job's work tree resolves there (issue #323);
          // and its work tree is made there (issue #361); which of the hopper's addresses it reaches (issue #698). One
          // after the other, over the one shared ssh connection.
          : probeSsh({ target: m.ssh, controlDir: join(dataDir, 'ssh'), auth: sshAuth, ...(m.workTree !== undefined ? { workTree: m.workTree } : {}), ...(o.hopperUrls ? { hopperUrls: sshCandidates(o.hopperUrls()) } : {}), ...wslAsked() }).then(async (found) => ({
            ...found,
            // Its herdr session running, its herdr client and server versions, and first the herdr the hopper owns there (issue #741): installed, linked, the session server moved to it when nothing is lost.
            ...(m.herdr ? await probeOwnedHerdr(keepHerdr, { target: m.ssh, session: m.session, controlDir: join(dataDir, 'ssh'), auth: sshAuth }, () => jobsOnMachine(m.name).length > 0) : { online: true }),
          })))),
  });
  // The user's connected accounts (src/users/connected-accounts.ts). Reached only after `sync` exists: a connection is made long
  // after the runtime starts; a further account (issue #1448) changes which job sources there are, and the plugins follow at once.
  const connectedAccounts = userAccounts({ store, apps: config.hopperApps, clock, logger, secrets: system, env: o.env, events: store.events, link: o.linkIdentity, sourceEmailMatch: o.sourceEmailMatch, onChange: (key) => {
    if (furtherAccount(key)) void host.reload().catch(() => undefined);
    for (const s of sync.statuses().filter((j) => j.kind === `${providerOfKey(key)}-account`)) void sync.syncNow(s.name).catch(() => undefined);
  } });
  // The GitHub proxy (issue #563): a client target's jobs reach the hopper where it dialled in.
  const proxy = createUserGitHubProxy({ user, store, clock, logger, linkPrivateKey: hopperLink.privateKey, accounts: connectedAccounts, gitlabUrl: () => store.settings.getGitLabAccount()?.baseUrl, traceparent: (jobId) => jobTraces.traceContext(jobId).TRACEPARENT, url: (m) => o.proxyUrl?.(m, link.dialled(m.id), store.artifacts.settings().linkBase), artifactUrl: (id) => artifactUrl(linkBase(), id), publicUrl: () => config.publicUrl ?? o.reach?.(), sources: () => sync.statuses(), ...(o.stack ? { stack: o.stack } : {}), pushLines: createPushLines({ dir: join(dataDir, 'git-mirrors'), log: (line) => logger.warn(line) }), fastForward: createFastForward({ dir: join(dataDir, 'git-mirrors'), log: (line) => logger.warn(line) }), issueDrafter: seams.issueDrafter ?? createClaudeDrafter({ cwd: dataDir, userEnv: cliEnv }), hostname: hostname() }); // the shrink guard's (issue #1096) and direct push's (issue #1806), in the user's mirrors
  // The user's GitLab account (issue #1448 part 2): its source comes and goes with it, and syncs at each change.
  // Who on GitLab starts the user's jobs (issue #1448 part 3): Access decides, the GitLab account told as the trusted actor.
  const gitlabAccount = createGitLabAccount({ settings: store.settings, secrets: system, clock, logger, ...(o.sourceEmailMatch ? { emailMatch: () => o.sourceEmailMatch!() } : {}),
    ...(o.access ? { startsJobs: (actor, actors) => o.access!.decideGitLabIntakeActor(user.id, actor, actors) } : {}), onChange: (presence) => {
    if (presence) void host.reload().catch(() => undefined);
    for (const s of sync.statuses().filter((j) => j.kind === 'gitlab-account')) void sync.syncNow(s.name).catch(() => undefined);
  } });
  const notEnded = () => store.jobs.list({ status: [...IN_FLIGHT_STATUSES] });
  const builtin = builtinInstances(config.answerTimeoutMs, config.localMachine); const lanePodSignIn = laneSignIn(() => host.targets(), (ask) => vault.podCredential(ask)); // a lane pod's agent sign-in, its jobs' and its usage reads' (issue #1287); reached only after `vault` exists
  let searchChanged = (_keys: readonly string[]): void => undefined; const host = createPluginHost({ // searchChanged: set once search exists (issue #945)
    ...(config.pluginDir ? { pluginDir: config.pluginDir } : {}), installedDir: o.installedDir,
    config: store.config, dataDir, clock, logger, userEnv: cliEnv,
    defaultMachines: builtin.machines, defaultExecutors: builtin.executors,
    kit: createDetectionKit({ env: { ...o.env, ...cliEnv }, secret, secretName: (n) => `${user.secretPrefix}${n}` }),
    builtins: withSeams(seams, outbound),
    jobSourceContext: { ...storeSourceContext(store, o.otherUsersKnow, o.access && ((login, actors) => o.access!.decideIntakeActor(user.id, login, actors)), { dataDir, logger }, (keys) => searchChanged(keys), () => clock.now(), lease), connectedAccounts, gitlabAccount },
    machineContext: { executors: () => executorNames(), target },
    executorContext: { client: clientNamed, ...(commandBoxes ? { boxes: commandBoxes } : {}), ...(o.jobPods ? { pods: { join: o.jobPods.join, instanceId: o.jobPods.instanceId, leave: (pod: string) => host.leavePod(pod), agentCredential: (ask: Parameters<Vault['podCredential']>[0]) => vault.podCredential(ask) } } : {}) }, // job pods (issue #1283), their agent's sign-in (issue #1287)
    usageSourceContext: { agentSignIn: (machine) => lanePodSignIn(machine) }, intervalMs: o.pluginsConfigIntervalMs,
    // The job sources follow the plugins config live (issue #356); reached only after `sync` exists.
    jobSourcesChanged: (built) => applyJobSources(built),
    derivedJobSources: (configured) => [...furtherAccountSources(configured, connectedAccounts.keys()), ...gitlabAccountSources(configured, store.settings.getGitLabAccount() !== undefined)], // a source for each further GitHub account, and the GitLab account's (issue #1448)
    executorInUse: (name) => notEnded().filter((j) => j.spec.executor === name).map((j) => j.id),
    attached: {
      inUse: (name) => jobsOnMachine(name), pinned: (name) => notEnded().filter((j) => j.spec.machineId === name).map((j) => j.id),
      sshAuth, ...(seams.resolveTarget ? { resolveTarget: seams.resolveTarget } : {}), ...(seams.hostKeyOffer ? { hostKeyOffer: seams.hostKeyOffer } : {}),
      publicKey: () => (secret('HOPPER_SSH_KEY_FILE') ? undefined : ownKey?.publicKey),
      startSession: seams.herdrSession ?? ((s) => startHerdrSession(s, cliEnv)),
      localMachine: config.localMachine,
    },
  });
  // Then the system secrets kept in a vault backend are read (issue #658, requirement 6), and read again from then on.
  const stopBackendReads = await host.start().then(() => readBackends(() => host.vaultBackends()));
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
  // The webhook signing secrets (issues #451, #658): system secrets in the user's vault. A subscription from before reads its variable.
  const webhookSecrets = createWebhookSecrets({ store, system, runtime: runtimeSecrets(o.env), prefix: user.secretPrefix });
  const dispatcher = createWebhookDispatcher({ store, clock, secretOf: (sub) => webhookSecrets.of(sub), outbound, baseMs: config.webhookBaseMs });
  // The service calls the engine and the engine calls the service: the engine's handlers are
  // reached through closures that run only after `engine` exists (design.md "Construction
  // contract added").
  // The logins (issue #476): a login a job or an escalation level's run waits on, never a question.
  // And the tool sign-ins (issue #1128): started by the usage sources that read each machine's tool. One that completes answers
  // the not-signed-in questions on its machine (`onSignedIn`, reached only after `questions` exists).
  const logins = createLogins({ store, clock, lastAccounts: createLastAccounts({ repo: store.lastAccounts, sources: () => host.usageSources().map((u) => ({ name: u.name, ...u.state?.() })) }) }), signIns = createSignIns({ logins, sources: () => host.usageSources(), clock, ...(o.leases ? { hosts: o.leases } : {}), onSignedIn: (s) => { answerSignedOut({ store, questions }, s); }, setupToken: setupTokenSignIn({ ...seams.setupToken, dir: dataDir, set: (x, by) => vault.set(x, by) }) }); // the Claude sign-in for pods (issue #1287)
  // Decider calls (issue #550) go through Jev first, through TypeSafe with the user's TypeSafe API key (issue #657).
  const minorDecisions: MinorDecisions = createMinorDecisions({ store, clock, logger, timeoutMs: JEV_TIMEOUT_MS, jev, typesafeKey: () => typesafeKey.view() });
  // The TL;DR of every long card (issue #569): Claude Haiku through the `claude` CLI, in the user's work dir.
  const tldrs = openTldrs({ store, clock, logger, sweepMs: config.tickMs, lease: lease('tldr'), cwd: dataDir, userEnv: cliEnv, ...(seams.tldrWriter ? { writer: seams.tldrWriter } : {}) }), itemReconciler = createItemReconciler({ ledger: store.workItems, jobs: store.jobs, events: store.events, outbox: store.githubOutbox, lease: lease('item-reconcile'), runAgain: (jobId, brief) => sync.rerun(jobId, 'reconciler', brief), now: () => clock.now().toISOString(), log: (line) => logger.warn(line), ...(seams.itemReconcileEveryMs ? { intervalMs: seams.itemReconcileEveryMs } : {}) }); // the item reconciler (issue #1891)
  // Read at each question and failure: reached only after `engine` exists.
  const gated = (machineId: string): boolean => engine.blastRadius.gates(machineId);
  const questions = createQuestionService({
    store, clock, levels, logins, stageTimeoutMs: config.answerTimeoutMs, config: store.config, gated, risk: minorDecisions, lease: lease('questions'),
    renotifyMs: config.humanRenotifyMs, humanTimeoutMs: config.humanTimeoutMs,
    answerUrl: (id) => uiUrl(`question-${id}`),
    onAnswered: (q: Question) => engine.onAnswered(q),
    onExpired: (q: Question) => engine.onExpired(q),
    // onShift: a level's suggested phase shift (issue #548), made when the phase-shift settings allow the level.
    // onToHuman: a direct query's question that reaches a person goes to its caller's callback too (issue #2184).
    onDismissed: (q: Question) => engine.onDismissed(q), onCorrected: (q: Question) => engine.onCorrected(q), onShift: (q, suggest, by) => engine.phaseShifts.byLevel(q, suggest, by), onToHuman: (q, answerUrl) => directJobs.questionAsked(q, answerUrl),
  });
  // Each review section's review (issues #537, #543): the escalation levels its settings name review; the engine ends,
  // moves on or re-queues the job.
  const reviews = createReviewServices({
    store, clock, levels, logins, stageTimeoutMs: config.answerTimeoutMs, config: store.config,
    onDecided: (p) => engine.onDecided(p), onRevise: (p, brief) => engine.onRevise(p, brief),
  });
  let { running, fixed } = splitSources(host.jobSources());
  const directJobs = createDirectJobs({ store, host: () => engine.sourceHost, url: (id) => uiUrl(`direct-jobs/${id}`), artifactUrl: (id) => artifactUrl(linkBase(), id), now: () => clock.now().toISOString(), pullRequests: createDirectPullRequests({ accounts: connectedAccounts, clock, ...pullRequestSettings(store) }) }); // its pull request followed with the user's own GitHub connection (issue #1068)
  const jobSources = () => [...running.map((r) => r.source), directJobs.source, ...(seams.sources ?? [])];
  // A job's source as the sync loop has it now: a removed one still answers for its own jobs (issue #356).
  const sourceOf = (job: Job) => sync.source(job.source?.source ?? '');
  // The vault's view carries the system scope too (issue #658): the user's and the whole hopper's own secrets, and their audit trail.
  const vault = withSystemScope(await openUserVault({ ...o.config, env: o.env, user: user.id, store, access: o.access, ...(o.minter ? { minter: o.minter } : {}), clock, logger, targets: () => vaultTargets(host.targets()), holds: (p) => proxy.githubProxy.user.holds(p), backends: () => host.vaultBackends(), plans: proxy.githubProxy.infraPlans, ...(o.infraApplies ? { applies: () => o.infraApplies!() } : {}), ...(o.sharedSecrets ? { shared: o.sharedSecrets } : {}), ...(o.sandboxes ? { elsewhere: () => o.sandboxes!.elsewhere() } : {}) }), { system, ...(o.instanceSecrets ? { instance: o.instanceSecrets } : {}), events: store.events });
  const engine: Engine = createEngine({
    store, clock, executors, router, questions, reviews, logins, queueSorter: host.queueSorter, lease,
    routing: { rules: () => host.routingRules(), machines: () => host.machineIds() }, configuredMachines: () => host.configuredMachineIds(),
    ...(seams.fakeUsage ? { fakeUsage: seams.fakeUsage } : {}),
    // Every machine follows the plugins config without a restart (issues #18, #74); the pinned host keys with it.
    machines: { list: () => { pinned(host.targets()); return host.machines().list(); } },
    // The usage sources follow the plugins config live (issue #356).
    usage: () => [...host.usageSources(), ...(seams.fakeUsage ? [seams.fakeUsage] : [])],
    policy: { softLimit: config.softLimit, hardLimit: config.hardLimit, routerCheapBoost: config.routerCheapBoost,
      laneIdleGraceMs: config.laneIdleGraceMs, resumeBoost: config.resumeBoost, pacing: config.pacing },
    tickMs: config.tickMs,
    maxQuestions: config.maxQuestions, keepPanes: config.keepPanes, reconnectGraceMs: config.reconnectGraceMs, linkGraceMs: config.linkGraceMs, doneRecheckMs: config.doneRecheckMs, doneReadRetryMs: config.doneReadRetryMs, ownCommandGraceMs: config.ownCommandGraceMs,
    // Completion is the job's source's to judge (issues #171, #187, #579); a job of no source, or of one that does not judge, is complete.
    // A job whose last push the shrink guard refused (issue #1096) does not end done: tending failed, whatever its source says.
    verdict: (job) => guardedVerdict(store.events.recent(200, ['github_proxy.refused', 'github_proxy.done'], job.id), job, () => judge(sourceOf(job), job)),
    // Before a nudge (issue #627): the job's work over at its source, or a credential a person is asked for.
    overAtSource: (job) => overAtSource(sourceOf(job), job), credentialRequests: () => vault.view().requests ?? [], waitReads: { endedWatched: async (job, refs) => sourceOf(job)?.endedWatched?.(refs), pullRequestChecks: async (job, repo, n) => sourceOf(job)?.waitedChecks?.(repo, n), pullRequestReviews: async (job, repo, n) => sourceOf(job)?.waitedReviews?.(repo, n) }, // a wait check's reads (issue #1694)
    // Every job on a machine that reaches the hopper asks it for GitHub (issue #563): its token, the script, the URL, and
    // git's way to GitHub through it (issue #652). No job holds a GitHub token of its own.
    // A box's blast radius includes its template's rating (issue #605), read live from the vault.
    // A job's processes join its trace (issue #1486): its run span's context, from the job traces below (made before the engine starts).
    jobProxy: proxy.jobProxy, agentSignIn: (job, machine) => lanePodSignIn(machine.id, job.id), deliveredSecrets: (jobId) => vault.deliveredTo(jobId), boxRadius: (machine) => vault.boxRadius(machine), traceContext: (jobId) => jobTraces.traceContext(jobId),
    // Read at each Decision; reached only after `failures` (and `sandboxRequests`) exists. An applied lane recommendation edits the machine (issue #688).
    // The sandboxes a waiting job's prompt names are asked for before it starts, and hold it until approved and ready (issue #1471).
    problems: () => failures.blocks(), machineLanes: machineLanesEditor(plugins), sandboxesHeld: (waiting) => sandboxesHeld(sandboxRequests, () => vault.view().templates, waiting),
    // A machine's lanes and a waiting job's machine are decider calls too (issue #688).
    jevFirst: minorDecisions, ...(o.jobMoves ? { jobMoves: { begin: (key: string, data: JobMoveData) => o.jobMoves!.begin(user.id, key, data) } } : {}), ...(o.jobRuns ? { jobRuns: { begin: (key: string, data: JobRunData) => o.jobRuns!.begin(user.id, key, data), open: (ids: readonly string[]) => o.jobRuns!.open(user.id, ids) } } : {}),
  });
  jobsOnMachine = (name) => engine.jobsOnMachine(name);
  const sync = createSourceSync({
    // The in-motion cycle (issue #985): the pull requests in motion every cycle, every followed one each intake sync interval.
    sources: jobSources(), host: engine.sourceHost, clock, jevFirst: minorDecisions, followEvery,
    // Poll backoff and the call log (issue #1264): the configured job sources poll less while nothing changes, and each pass's calls are kept.
    pollMs: (name) => running.find((r) => r.source.name === name)?.pollMs ?? (name === directJobs.source.name ? DIRECT_POLL_MS : SEAM_SOURCE_POLL_MS), backoff: (name) => running.some((r) => r.source.name === name), calls: store.sourceCalls,
  });
  // The failure assessor (issue #509): its runs again go through the sync loop's Run again.
  const failures = createFailures({
    store, clock, logger, sweepMs: config.tickMs, lease: lease('failures'),
    // Continue (issue #551): the job's own agent session resumes where the engine says it can.
    rerun: sync.rerun, continueJob: sync.continueJob, takesBack: sync.takesBack, finishShipped: (jobId, result) => engine.sourceHost.finishShipped(jobId, result),
    resumable: (job) => engine.resumable(job), reopens: (job) => engine.reopens(job), dismiss: (jobId, by) => { engine.dismiss(jobId, by); }, machines: () => host.machines().list(), discarding: (jobId) => engine.discarding(jobId),
    // Own PR checks red (issue #1230): the job's own pull request's checks, run again once, and their logs, by its source; Own PR unfinished (issue #1265): the step that finishes it.
    workState: async (job) => sourceOf(job)?.workState?.(job), pullRequestOpen: async (job) => sourceOf(job)?.pullRequestOpen?.(job), doneAtSource: (job) => doneAtSource(sourceOf(job), job), ...checksRedOf(sourceOf), checksWaitMs: config.checksWaitMs, unfinishedPullRequest: async (job) => sourceOf(job)?.unfinishedPullRequest?.(job),
    trigger: (reason) => engine.trigger(reason), minorDecisions: { first: minorDecisions, gated }, ...(o.installedAt ? { installedAt: o.installedAt } : {}),
  });
  sync.giveBackChecks(giveBackChecks({ failures, store, resumable: (job) => engine.resumable(job), reopens: (job) => engine.reopens(job), takesBack: sync.takesBack, continueJob: sync.continueJob, checkTendAgain: sync.checkTendAgain })); applyJobSources = (built) => { ({ running, fixed } = splitSources(built)); sync.setSources(jobSources()); }; // Retry, Continue, I fixed it, Push it, Tend again: checked by the failures service at the answer and at the send of their GitHub outbox rows (issue #1238 part 5)
  // Deliveries and notifiers from now on, so an instance event (update.applied at boot) reaches them.
  // Each job one trace (issue #1486, design.md "Telemetry"): built from its events; a no-op while telemetry is off.
  const stopFailureLog = logFailures(store), jobTraces = traceJobs({ subscribe: (l) => store.events.subscribe(l), job: (id) => store.jobs.get(id) }), stopOutcomes = recordOutcomes({ subscribe: (l) => store.events.subscribe(l) }), stopDeploys = traceDeploys({ subscribe: (l) => store.events.subscribe(l), job: (id) => store.jobs.get(id) }), stopQuarantineRevokes = revokeOnQuarantine({ store, vault }); // issue #655 part 6: a quarantine revokes the item's vault grant
  dispatcher.start();
  // Issue #378: the notifiers also read the questions open at the human (oldest first) and where each is answered.
  host.startNotifiers({ subscribe: (l) => store.events.subscribe(l), job: (id) => store.jobs.get(id), question: (id) => store.questions.get(id), waitingOnHuman: () => highFirst(store.questions.list({ status: ['open'], order: 'oldest-first' }).filter((q) => q.tier === 'human'), (q) => jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), q.jobId)?.high === true), answerUrl: (id) => uiUrl(`question-${id}`), loginsUrl: () => uiUrl('logins'), accessUrl: () => uiUrl('access-requests'), infraUrl: () => uiUrl('infra'), infraPlan: (id) => { const p = store.infraPlans.get(id); return p ? planNotice(p, store.infraPlans.approval(id), store.settings.getInfraWatchers() ?? {}) : undefined; }, highPriority: () => prioritySettingsOf(store.settings.getPriorityLanes()).highPriority, tldr: (q) => tldrs.tldrOrSummary('question', q), artifactUrl: (id) => artifactUrl(linkBase(), id), deliveries: store.notifierDeliveries, ...(o.reach ? { reach: o.reach } : {}) });
  // The usage history (issue #385) and machine resources over time (issue #560): the machines as the engine lists them; lane tuning (issue #688) after new samples.
  const history = createHistoryRecorders({ readings: () => engine.getUsage(), sources: () => engine.getUsageSources(), machines: () => host.machines().list(), afterMachineRecord: () => engine.laneTuning.record(), store, clock, logger });
  const { jobStream, artifacts } = openJobStream({ userId: user.id, store, clock, logger, keys, lease: lease('artifacts'), ...(seams.jobStream?.inlineMax !== undefined ? { inlineMax: seams.jobStream.inlineMax } : {}) });
  // Steps: Windows (issue #731, over ssh), box steps (issue #1004, in a job's own box), need steps (issue #1007, one-shot need boxes).
  const mintReconcile = reconcilePass(() => vault.reconcileMints(), logger), sandboxRequests = userSandboxRequests({ userId: user.id, store, templates: () => vault.view().templates, clock, jevFirst: minorDecisions, jevDenied: (id) => { engine.denied(id, 'jev'); } /* Jev's sandbox-request check (issue #655 part 13) */, ...(o.access?.minTrusts ? { minTrusts: () => o.access!.minTrusts!() } : {}) /* the stamp's capabilities (part 16) */ }), sandboxHolds = holdSweep(sandboxRequests) /* a sandbox request no person answered in 24 hours, declined (issue #655 part 9) */, windowsSteps = createWindowsSteps({ userId: user.id, hosts: () => readWindowsHosts(store.config), dir: join(dataDir, 'windows-steps'), record: (e) => { store.events.append(e); }, log: (l) => logger.warn(l), now: () => clock.now(), secret: (ask) => vault.forStep(ask), host: seams.windowsStepHost ?? createSshStepHost({ auth: sshAuth, sshDir: join(dataDir, 'ssh') }), steps: o.windowsSteps?.steps ?? NO_WINDOWS_STEPS, atWork: stepsMayRun(store.jobs), ...(o.windowsSteps ? { sagas: { begin: (step) => o.windowsSteps!.sagas.begin(step, user.id), abort: (saga, reason) => o.windowsSteps!.sagas.abort(saga, reason) } } : {}) }); const launcher = o.sandboxes, needSteps = createNeedSteps({ userId: user.id, templates: () => vault.view().templates, mint: (ask) => vault.mintForNeedStep(ask), secret: (ask) => vault.forStep(ask), release: (box) => vault.releaseMints(box), planFile: (id) => proxy.githubProxy.infraPlans.file(id), ...(o.infraApplies ? { applies: () => o.infraApplies!() } : {}), dir: join(dataDir, 'need-steps'), record: (e) => { store.events.append(e); }, log: (l) => logger.warn(l), now: () => clock.now(), steps: launcher?.steps ?? NO_NEED_STEPS, ran: (step) => launcher?.ran(step) ?? false, atWork: stepsMayRun(store.jobs), ...(launcher ? { run: (box, io, run) => launcher.needStep(user.id, box, io, run), hostOffline: () => launcher.hostOffline(user.id), sagas: { begin: (step) => launcher.sagas.begin(step, user.id), abort: (saga, reason) => launcher.sagas.abort(saga, reason) } } : {}) }), bastions = createBastions({ userId: user.id, mint: (ask) => vault.mintForNeedStep(ask), release: (box) => vault.releaseMints(box), secret: (ask) => vault.forStep(ask), mayRelay: (a) => (o.access?.decideRelay ? o.access.decideRelay({ userId: user.id, ...a, approved: approvedTarget(vault.view().templates.find((t) => t.name === a.template), a.target) }) : Promise.resolve({ allowed: false, reason: 'access is not part of this hopper' })), dir: join(dataDir, 'bastions'), record: (e) => { store.events.append(e); }, log: (l) => logger.warn(l), now: () => clock.now(), atWork: stepsMayRun(store.jobs), ...(launcher ? { run: (box, io, run) => launcher.needStep(user.id, box, io, run) } : {}) }); // a box step is a need step in a sandbox of its own (issue #1349); a Windows step is kept in the database and run by its saga (issue #1611); a bastion is the one need box that outlives a step (issue #2146)
  // Search (issue #945): the user's documents in the index, kept from job events; each hit decided by Access.
  const search = createUserSearch({ scope: { instance: o.search?.instanceId ?? 'local', user: user.id }, store, index: o.search?.index, access: o.search?.access, clock, logger, url: (type, ref, job) => { const route = searchHitRoute(type, ref, job); return route === undefined ? ref : uiUrl(route); }, intake: (key) => intakeOutcomeOf(sync.statuses(), key) }); searchChanged = (keys) => search.changed(keys); let started = false, stopped: Promise<void> | undefined, recovering: Promise<void> = Promise.resolve();
  return {
    search, jobStream, artifacts, githubProxy: proxy.githubProxy, windowsSteps, podmanHost: (name) => { const h = readPodmanHosts(store.config).find((x) => x.name === name); return h && createPodmanHostRuntime(h, { auth: sshAuth, sshDir: join(dataDir, 'ssh') }); }, needSteps, bastions, directJobs, sandboxRequests,
    user, store, engine, sources: sync, registry: withFixedStatuses(sync, () => fixed, (name) => host.duplicateJobSources().get(name)), plugins, host, questions, reviews, logins, signIns, failures, minorDecisions, typesafeKey, tldrs, dispatcher, executors, outbound, terminal: createJobTerminal({ store, executors, clock }), machineTerminal: createMachineTerminal({ store, executors, clock, machines: () => host.machines().list() }),
    levelNames: () => levels().map((l) => l.name), connectedAccounts, gitlabAccount,
    ...history.recorders, windowsLink: history.windowsLink,
    webhooksEditor: createWebhooksEditor({ store, secrets: webhookSecrets, logger }),
    secretProblem: (sub) => webhookSecrets.problem(sub), vault, topologyDiscovery: { ...createTopologyDiscovery({ store, topology: proxy.githubProxy.topology, reader: seams.topologyReader ?? createTopologyReader(), secrets: () => vault.view().secrets, mint: (asset) => vault.mintForDiscovery(asset), overrides: () => readClusters(store.config) }), discover: () => o.discoverTopology?.() ?? Promise.resolve(undefined) }, // issues #558, #585, #586; topology discovery (issue #1781 part 3)
    machineLink: { hopperKey: hopperLink.publicKey, join: (j) => host.joinMachine(j), client: link,
      tokenFor: (key) => (host.targets().some((m) => 'client' in m && m.client.key === key) ? linkToken(hopperLink.privateKey, key) : undefined), leave: machineLeave({ userId: user.id, links: o.links, targets: () => host.targets(), jobsOn: (name) => jobsOnMachine(name), config: store.config, edit: (e) => host.edit(e) }) }, // issue #1284
    async start() {
      if (started) return; started = true;
      search.start(); await engine.start(); // search first: every job event from here on marks its job for the index
      await failures.backfill.once(); // the done-check backfill (issue #637), before the sync and the assessor judge the same failures
      sync.start();
      history.start(); minorDecisions.start(); tldrs.start(); failures.start(); recovering = proxy.githubProxy.promotions.recover().catch((e: unknown) => { logger.warn(`hopper: Promote to GitHub: the sends a stop left could not be looked for: ${(e as Error).message}`); }); // the promotions' sends a stop left (issue #1591): each linked to what GitHub made, or gone
      connectedAccounts.start(); mintReconcile.start(); // the renewer (issue #441); the sandboxes' tokens a hopper that stopped left bound, unbound at start, then every 5 minutes (issue #1371): a token that expired while the hopper was down renews at once
      sandboxHolds.start(); jobStream.start(); itemReconciler.start(); proxy.githubProxy.bugReports.start(); proxy.githubProxy.watches.start(); proxy.githubProxy.componentWatchers.start(); proxy.githubProxy.landingBatches.start(); proxy.githubProxy.ledgerFallbackRead.start(); proxy.githubProxy.repoChecks.start(); proxy.githubProxy.pendingApprovals.start(); proxy.githubProxy.subIssueLinks.start(); // Report a bug's kept reports (issue #694), the GitHub watches (issue #427), the component watchers (issue #1077), the landing batches (issue #1073), the ledger's fallback read (issue #1067), the repositories' checks' schedule (issue #1250), the pending approvals' (issue #2088), the kept sub-issue links (issue #1607)

    },
    stop() {
      stopped ??= (async () => {
        await search.stop(); jobStream.stop(); itemReconciler.stop(); await recovering; await proxy.githubProxy.bugReports.stop(); await proxy.githubProxy.watches.stop(); await proxy.githubProxy.componentWatchers.stop(); await proxy.githubProxy.landingBatches.stop(); await proxy.githubProxy.ledgerFallbackRead.stop(); await proxy.githubProxy.repoChecks.stop(); await proxy.githubProxy.pendingApprovals.stop(); await proxy.githubProxy.subIssueLinks.stop();
        await failures.stop(); signIns.stop(); await bastions.stopAll(); await mintReconcile.stop(); sandboxHolds.stop();
        minorDecisions.stop(); await tldrs.stop();
        await sync.stop();
        history.stop(); connectedAccounts.stop();
        await questions.stop();
        await Promise.all(REVIEW_KINDS.map((k) => reviews[k].stop()));
        await engine.stop();
        await dispatcher.stop(); await host.stopNotifiers(); outbound.stop();
        stopFailureLog(); stopDeploys(); jobTraces.stop(); stopOutcomes(); stopQuarantineRevokes();
        host.stop(); stopBackendReads();
        store.close();
      })();
      return stopped;
    },
  };
}
