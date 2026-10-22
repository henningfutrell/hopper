// Composition root (design.md "Users: one hopper, separate users"): config → instance store →
// sign-in config → plugin store → one user runtime per user (src/users/: the plugins config, plugin host, engine,
// sources, questions, webhooks, notifiers) → updater → server. Adapters are built by their plugins,
// through each user's host (integration tests call startApp, with doubles at the seams).
import { personBase } from './artifacts/links.ts';
import { jobHopperUrl } from './github-proxy/reach.ts';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createMachineLinks } from './machines/links.ts'; import { LANE_POOL_KEY_VARIABLE } from './machines/lane-pool.ts';
import { hopperAddresses, wslHopperUrl } from './machines/hopper-address.ts';
import { createAccess, LIVE_JOB_STATUSES, type Access } from './authz/service.ts';
import { createCredentialMinter } from './vault/minter.ts';
import { createOpenFgaServer } from './authz/openfga.ts'; import { createSolrIndex } from './search/solr.ts'; import type { SearchIndex } from './domain/search.ts';
import { fileURLToPath } from 'node:url';
import type { AuthorizationServer, ContainerRuntime, InstanceStore, ReleaseCheck, Restarter, StackProbe, UpdateBuilder, Updater } from './domain/ports.ts';
import { machineOfLane } from './domain/raised-by.ts';
import type { MachineSnapshot, User } from './domain/types.ts';
import { daemonHelp, loadConfig, type Config } from './config.ts';
import { logStartup } from './startup-log.ts';
import { createAllowedHosts, createCloudLinkParts, createDisplayName, createInfraApplies, createSourceEmailMatch, createGitHubDeliveries, createRemoteAccess, createServer, kernelVersion, runsInWsl, tunnelCaller, type TailnetSource } from './http/index.ts'; import { watchHeld, type HeldWatch } from './http/event-loop-held.ts'; import type { CloudLinkTarget } from './http/cloud-link-agent.ts';
import { claimGithubAdmin, createSignIn, prepareSignIn, type AuthConfig } from './auth/index.ts';
import { readRelease } from './client/release.ts'; import { inCluster } from './client/cluster.ts';
import { BUILTIN_PLUGINS } from './plugins/builtin.ts';
import { createPluginStore, DEFAULT_PLUGIN_STORE, installedDirOf } from './plugins/plugin-store.ts';
import { logMasterKey, resolveMasterKey, withMasterKey, type MasterKey } from './secrets/master-key.ts';
import { masterKeyRotation } from './users/master-key-rotation.ts';
import { createRateLimiterControl } from './github-limiter/settings.ts';
import { createMasterKeyStatus, type MasterKeyStatus } from './http/master-key.ts'; import type { SandboxLauncher } from './users/sandbox-requests.ts';
import { logMask } from './secrets/log-mask.ts';
import { runtimeSecrets } from './secrets/runtime.ts';
import { CLIENT_SECRET_VARIABLE } from './connected-accounts/web-flow.ts';
import { openInstanceStore } from './store/index.ts';
import { clusterChannelTag, clusterInstall, createInstallScriptBuilder, createReleaseCheck, createRestarter, releaseAccount, createStackProbe, databaseHostOf, createUpdater, startStackDrift, renameBoot, RESTART_EXIT_CODE, restartBlockers } from './update/index.ts';
import { userForIdentity } from './users/identities.ts';
import type { UserRuntime, UserSeams } from './users/runtime.ts';
import { createRuntimes } from './users/runtimes.ts'; import { createOutboundGuard } from './outbound/index.ts';
import { openInstanceSecrets } from './users/instance-secrets.ts';
import { podmanHostsInUse, sandboxClientsOf } from './users/sandbox-boxes.ts'; import { mintJoinCode } from './machines/join-code.ts';
import { NO_RUNTIME, NO_RUNTIME_IN_CLUSTER, selectRuntime } from './sandbox/runtime.ts'; import { createPlayground, type Playground } from './sandbox/playground.ts'; import { createOpenFgaMeter, createRemoteBoxMeter, createSolrMeter, createStack, meterFor, openFgaMetricsUrl, type StackRecorder } from './stack-resources/index.ts';
import { createSandboxes, hopperNetwork, ownContainer, usersTemplates, type Sandboxes } from './sandbox/service.ts'; import { createEgress } from './sandbox/egress.ts';
import { createHostLeases, createSagas, sagaOwner } from './sagas/index.ts'; import { createGitPushes, GIT_PUSH_SAGA } from './github-proxy/index.ts'; import { createTopologyDiscoveries, topologyDiscoverySaga } from './infra-plans/topology-discovery.ts'; import { NEED_STEP_SAGA, needStepSaga } from './sandbox/need-step-saga.ts'; import { jobMoveSaga } from './engine/job-move-saga.ts'; import { JOB_MOVE_SAGA } from './engine/lost-move.ts'; import { jobRunSaga } from './engine/job-run-saga.ts'; import { JOB_RUN_SAGA } from './engine/job-run.ts'; import { sagaEnded } from './domain/sagas.ts'; import { WINDOWS_STEP_SAGA, windowsStepSaga } from './windows-steps/step-saga.ts';
import { foldLeftoverAdmin } from './users/leftover-admin.ts';
import { observeQueueOf } from './telemetry/queue.ts'; import { NO_TELEMETRY, startProcessTelemetry, type TelemetryControl } from './telemetry/start.ts'; import { createTelemetrySettings } from './telemetry/settings.ts';

export type { UserSeams } from './users/runtime.ts';

export interface App {
  /** Always the loopback URL, whatever the bind address. */
  url: string;
  config: Config;
  /** The sign-in config as it applies now (loaded at start, changed from Settings → Sign-in). */
  auth: () => AuthConfig;
  /** The UI link to one question, as notifications carry it, on the hopper's link base (no user's): `personBase`. */
  answerUrl(questionId: string): string;
  /** The instance store: users, identity links, sessions, login codes, the sign-in config, instance settings. */
  instance: InstanceStore;
  updater: Updater;
  /** Access (issue #559): the decision the vault asks before every mint, the approvals, the model. */
  access: Access;
  /** The sandbox boxes the hopper starts and removes (issue #603), and the sandbox playground (issue #1410). */
  sandboxes: Sandboxes; playground: Playground;
  /** The master key's status (issue #659): its source, the one reveal, a person's word that they saved it. The stack
   * recorder (issue #947): the stack's resources over time. */
  masterKey: MasterKeyStatus; stackHistory: StackRecorder;
  /** Every user, oldest first. */
  users(): User[];
  /** A running user's parts (store, engine, sources, plugins) — for tests; throws for a user with none. */
  user(id: string): UserRuntime;
  /** A new user under a unique name, its runtime started (POST /ui/api/users does the same). */
  addUser(name: string): Promise<User>;
  /** Close the server; stop every user runtime (sync loop, questions, engine ≤ 5 s, dispatcher, notifiers, plugin host, store); close the instance store. */
  stop(): Promise<void>;
}

/** Doubles at ports.ts seams, for integration tests. Production passes none. The user seams apply to every user's runtime, `perUser` over them. */
export interface AppSeams extends UserSeams {
  /** The environment the parts read their secrets from (design.md "Secrets"); default process.env. */
  env?: Record<string, string | undefined>;
  /** How often the plugins config's version (and the users table) is checked; default PLUGINS_CONFIG_CHECK_MS. */
  pluginsConfigIntervalMs?: number;
  /** One user's seams over the shared ones (each user its own job source, in tests). */
  perUser?(userId: string): UserSeams;
  /** The default plugin store (issue #445); default DEFAULT_PLUGIN_STORE; null: none. */
  pluginStoreDefault?: string | null;
  /** The built UI bundle; default UI_DIR. */
  uiDir?: string;
  /** OpenFGA (issue #559); default the server HOPPER_OPENFGA_URL names, else none. */
  authorizationServer?: AuthorizationServer;
  /** The container runtime (issue #708); default the one src/sandbox/runtime.ts selects from the config, else none. What reads
   * the stack's containers (issue #947); default the meter on the sandbox runtime's socket, else none. And what reads
   * OpenFGA's checks; default its metrics endpoint beside HOPPER_OPENFGA_URL, else none. And what reads the search index's
   * Solr; default its metrics API beside HOPPER_SOLR_URL, else none. */
  containerRuntime?: ContainerRuntime; containerMeter?: import('./domain/stack-resources.ts').ContainerMeter; remoteBoxMeter?: import('./domain/stack-resources.ts').RemoteBoxMeter; openFgaMeter?: import('./domain/stack-resources.ts').OpenFgaMeter; solrMeter?: import('./domain/stack-resources.ts').SolrMeter;
  /** The search index (issue #945); default Solr at HOPPER_SOLR_URL, else none; null: none. And
   * Cloudflare's and ngrok's APIs, which remote access mints the tunnel at (issue #968); default the real ones. */
  searchIndex?: SearchIndex | null; tunnelProviders?: Record<import('./domain/remote-access.ts').RemoteAccessProvider, import('./remote-access/provider.ts').TunnelProvider>; /** This host's tailnet (issue #1024); default tailscaled's local API, else the Tailscale interface; null: none. */ tailnet?: TailnetSource | null; /** The kernel's /proc/version text (issue #712); default the file. */ procVersion?: string; /** The thread that reads a held event loop, with the health port (issue #1383); default watchHeld's; null: none (a test process starts many daemons, issue #1717). */ held?: HeldWatch | null; /** The daemon's telemetry (issue #1486), which the telemetry setting applies to; default none: the setting is only kept. */ telemetry?: TelemetryControl;
  /** Self-update: the install dir (default APP_DIR), the build (default install.sh build-only mode), the restart (default exit or respawn). */
  /** `stackProbe`: what the hopper sees of its stack (issue #697); default the compose network's names and the vault container's /health. */
  /** And hopper.io with the pins of its key, for the cloud link's agent (issue #2039); default HOPPER_IO, which pins none. */
  update?: { appDir?: string; builder?: UpdateBuilder; restart?: Restarter; stackProbe?: StackProbe; release?: ReleaseCheck }; cloudLink?: CloudLinkTarget;
}

const PLUGINS_CONFIG_CHECK_MS = 5000;
const UI_DIR = fileURLToPath(new URL('../ui/dist', import.meta.url));
/** The install (or checkout) this process runs from: install.json and src/ live here. */
const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** HOPPER_* variables that are set but read by nothing: one loud line. */
function warnLeftoverEnv(config: Config): void {
  const names = Object.keys(config.leftoverEnv).sort();
  if (names.length === 0) return;
  console.warn(`hopper: WARNING: set but no longer read (the plugins config configures every part; remove them from the unit): ${names.join(', ')}`);
}

/** The user seams of one user: the shared ones, `perUser`'s over them. */
function seamsOf(seams: AppSeams, userId: string): UserSeams {
  const { env: _env, telemetry: _telemetry, pluginsConfigIntervalMs: _ms, perUser, uiDir: _ui, cloudLink: _cloudLink, update: _up, pluginStoreDefault: _store, authorizationServer: _fga, containerRuntime: _box, containerMeter: _meter, remoteBoxMeter: _remoteMeter, openFgaMeter: _fgaMeter, solrMeter: _solrMeter, searchIndex: _search, tunnelProviders: _tunnel, tailnet: _tailnet, procVersion: _proc, held: _held, ...shared } = seams;
  return { ...shared, ...perUser?.(userId) };
}

export async function startApp(config: Config, seams: AppSeams = {}): Promise<App> {
  const clock = { now: () => new Date() };
  const logger = { info: (l: string) => console.log(l), warn: (l: string) => console.warn(l) };
  warnLeftoverEnv(config);
  const store = openInstanceStore({ url: config.databaseUrl, clock });
  // Held shared while the daemon runs, so several hoppers share one database (issue #1662): the operator CLI refuses
  // `user transfer` while any daemon runs (issue #212).
  if (!store.holdDaemonLock()) logger.warn('hopper: an operator command holds this database alone (hopper user transfer?)');
  const env = seams.env ?? process.env;
  // The master key (issue #659): from the launch (its variable or a mounted Secret file, issue #1288), checked against the database's fingerprint before anything opens a
  // secret; a wrong key, or none while the database keeps secrets, stops the start (issue #1296: never limited).
  // The parts read it through `keyed`, never from the file or the old token key.
  let masterKey: MasterKey;
  try {
    const { settings } = store;
    masterKey = resolveMasterKey({ env, kept: () => store.keptSecrets(), record: { fingerprint: () => settings.masterKeyFingerprint(), setFingerprint: (fp) => settings.setMasterKeyFingerprint(fp), rotation: () => settings.masterKeyRotation() } });
  } catch (e) {
    store.close();
    throw e;
  }
  const { env: keyed, use: useKey } = withMasterKey(env, masterKey);
  // A rotation (issue #659): every secret sealed again, then the running hopper on the new key (src/users/master-key-rotation.ts).
  const masterKeyStatus = createMasterKeyStatus(masterKey, store.settings, masterKeyRotation({ store, keyed: { use: useKey }, mask: logMask, vaultUrl: config.vaultUrl, logger, append: (e) => runtimes.events.append(e) }), env.HOPPER_MASTER_KEY_SEALED || undefined);
  logMasterKey(masterKey, masterKeyStatus.view().saved, logger);
  // The sign-in realms' secrets are in the instance's vault (issue #658): moved there now, before the sign-in config is read.
  const secrets = openInstanceSecrets(store, { env: keyed, clock, logger, migrate: true });
  const { instance } = secrets;
  // Before anything starts: the sign-in config with what the environment sets (no bootstrap login, issue
  // #238); an invalid one stops the daemon (sign-in fails closed).
  let auth: AuthConfig;
  let signInEnvironment: string[];
  try {
    ({ config: auth, environment: signInEnvironment } = prepareSignIn({ instance, env, secret: runtimeSecrets(env), logger }));
  } catch (e) {
    instance.close();
    throw e;
  }
  // The leftover default admin account goes into the first GitHub admin's user (issue #265), before any runtime.
  try {
    const folded = foldLeftoverAdmin(instance);
    if (folded) logger.info(`hopper: the leftover user ${folded.from} is folded into ${folded.into}, the first GitHub admin's user: its work is theirs`);
  } catch (e) {
    instance.close();
    throw e;
  }
  const workDir = config.workDir;
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  let port = config.port; const inPod = inCluster(env); const wsl = !inPod && runsInWsl(seams.procVersion ?? kernelVersion()); // its container shares the kernel (issue #712); a WSL machine here is asked its host link (issue #1248 part 4); a pod is never WSL (issue #1289)
  // The base of a person's link (issues #673, #712): the user's link base, else the public URL, else the host link base
  // (Settings → Host link), else an IP or `.local` LAN name, else localhost. Never a container's bare name.
  const linkBase = (userLinkBase: string): string => personBase({ linkBase: userLinkBase, publicUrl: config.publicUrl, hostLinkBase: instance.settings.getHostLinkBase(), lanNames: config.lanNames, port });
  const uiUrl = (hash: string): string => `${linkBase('')}/#${hash}`;
  const intervalMs = seams.pluginsConfigIntervalMs ?? PLUGINS_CONFIG_CHECK_MS;
  // The client release this hopper loads onto its client targets: the client files of the install it runs from (issue #70).
  const clientRelease = readRelease(join(APP_DIR, 'src', 'client'));
  // The links of the machines dialled in (issue #308): the instance's, each keyed by user and machine key.
  const links = createMachineLinks();
  // Where a job reaches the hopper (issues #563, #695, #698): a client target, its client door (else the URL it dialled in
  // at); this machine, loopback; an ssh target, the address its probe found it reaches, never a guessed one
  // (src/machines/hopper-address.ts); a container target, the user's link base, the public URL, else a LAN name, an
  // address first (src/github-proxy/reach.ts).
  const proxyUrl = (m: MachineSnapshot, dialled: string | undefined, linkBase: string): string | undefined => m.ssh ? m.hopperUrl : jobHopperUrl({ machine: m, dialled, linkBase, publicUrl: config.publicUrl, lanNames: config.lanNames, port });
  // Access (issue #559): the instance's. Who is live (issue #581): each user's live jobs, each on the machine it runs on
  // and with the level its stamp verifies at (issue #655, part 15), and each box with its template; a template is rated from every user's vault templates of its name (issue #584).
  // Made before the runtimes: each user's vault approves profiles in it.
  const fgaKey = runtimeSecrets(env);
  const access = createAccess({
    repo: instance.access, clock, logger,
    server: seams.authorizationServer ?? (config.openFgaUrl ? createOpenFgaServer({ url: config.openFgaUrl, key: () => fgaKey('HOPPER_OPENFGA_KEY') }) : undefined),
    jobStatus: (userId, jobId) => runtimes.get(userId)?.store.jobs.get(jobId)?.status,
    requesters: () => runtimes.all().map((rt) => ({
      userId: rt.user.id,
      jobs: rt.store.jobs.list({ status: [...LIVE_JOB_STATUSES] }).map((j) => {
        const machine = machineOfLane(j.laneId) ?? j.resumeOn, trust = rt.store.jobs.trustLevel(j);
        return { jobId: j.id, ...(machine === undefined ? {} : { machine }), ...(trust === undefined ? {} : { trust }) };
      }),
      boxes: rt.vault.boxes(),
    })),
    templates: () => runtimes.all().flatMap((rt) => rt.vault.templateScopes()),
    // Every live share of an artifact (issue #624): a viewer in OpenFGA while it lasts.
    shares: () => {
      const now = clock.now().toISOString();
      return runtimes.all().flatMap((rt) => rt.store.artifacts.liveShares(now).map((s) => ({
        ownerId: rt.user.id, artifactId: s.artifactId, shareId: s.id, ...(s.kind === 'user' && s.userId !== undefined ? { userId: s.userId } : {}),
      })));
    },
    // A person in OpenFGA is the email their user is known by (issue #1380); a user with none yet, its id.
    emails: () => new Map(instance.users.list().flatMap((u) => (u.email === undefined ? [] : [[u.id, u.email] as const]))),
  });
  // The vault mints through STS and the Kubernetes API (issue #580), only after access allows it. The
  // tunnel watch (issue #795, remoteAccess below): whether the remote access URL is up, so each user's Grok Bot routine is
  // told where the hopper is.
  // Search (issue #945): one Solr core for the hopper, each user's documents apart by the instance id and the user id.
  // One outbound guard for the process (issue #1014): every user's sends to one destination share its limits. The shared
  // secrets (issue #718): the instance's, every user's vault lists them and delivers them after Access allows it.
  const leases = createHostLeases({ repo: instance.sweepLeases, owner: sagaOwner(instance.settings.instanceId()), logger }), outboundGuard = createOutboundGuard({ clock, logger, keys: instance.outboundKeys }), minter = createCredentialMinter(), search = { index: seams.searchIndex !== undefined ? seams.searchIndex ?? undefined : config.solrUrl ? createSolrIndex({ url: config.solrUrl }) : undefined, instanceId: instance.settings.instanceId(), access }, sandboxLauncher: SandboxLauncher = { needStep: (userId, box, io, run) => sandboxes.needStep(userId, box, io, run), stepProblem: (userId, s) => sandboxes.stepProblem(userId, s), hostOffline: (userId) => sandboxes.hostOffline(userId), steps: instance.needSteps, ran: (step) => instance.sandboxRuns.get(step) !== undefined, elsewhere: () => sandboxes.elsewhere(), sagas: { begin: (step, userId) => sagas.begin(NEED_STEP_SAGA, step, { step }, { userId }).id, abort: (saga, reason) => sagas.abort(saga, reason) } }; // a job's need and box steps, each in a sandbox burned after it (issue #1349), through the sandbox module made below; each kept in the database and run by its saga (issue #1568)
  const runtimes = createRuntimes({
    instance, logger,
    options: (user) => ({
      config, seams: seamsOf(seams, user.id), search, env: keyed, clock, logger, clientRelease, links, proxyUrl, hopperUrls: () => hopperAddresses({ publicUrl: config.publicUrl, lanNames: config.lanNames, port }), wslHopperUrl: () => wslHopperUrl({ wsl, hostLinkBase: instance.settings.getHostLinkBase(), port }), ...(inPod ? {} : { network: hopperNetwork(config) }), access, minter, instanceSecrets: secrets.system, sharedSecrets: secrets.shared(access), sandboxes: sandboxLauncher, windowsSteps: { steps: instance.windowsSteps, sagas: { begin: (step, userId) => sagas.begin(WINDOWS_STEP_SAGA, step, { step }, { userId }).id, abort: (saga, reason) => sagas.abort(saga, reason) } }, discoverTopology: () => topologyDiscoveries.discover(user.id), jobMoves: { begin: (userId, key, data) => { sagas.begin(JOB_MOVE_SAGA, key, { ...data }, { userId }); } }, jobRuns: { begin: (userId, key, data) => !sagaEnded(sagas.begin(JOB_RUN_SAGA, key, { ...data }, { userId })), open: (userId, ids) => new Set(instance.sagas.open().filter((s) => s.kind === JOB_RUN_SAGA && s.userId === userId && ids.includes(s.data.jobId as string)).map((s) => s.data.jobId as string)) }, outboundGuard, leases, jobPods: { join: (pod) => mintJoinCode(instance, clock, user.id, { pod }).code, instanceId: () => instance.settings.instanceId() }, // a job pod's join code, naming it (issue #1283)
      installedDir: installedDirOf(workDir), installedAt: () => updater.status().installed?.installedAt, pluginsConfigIntervalMs: intervalMs, linkBase, reach: () => remoteAccess.watch.url(), sourceEmailMatch: () => instance.settings.getSourceEmailMatch(), infraApplies: () => instance.settings.getInfraApplies(), ...(user.id === instance.users.list()[0]?.id ? { stack: () => stack.resources.read() } : {}), // the stack (issue #1077): only the oldest user's watcher checks it
      // A GitHub account connected from Sources is linked to its user under each realm of that
      // type (issue #214): signing in with it later lands in the same user. A link to another user stays.
      linkIdentity: (provider, subject) => {
        for (const r of signIn.config().realms.filter((x) => x.type === provider)) {
          const linked = instance.identities.userOf(r.name, subject);
          if (linked === undefined) instance.identities.link(r.name, subject, user.id);
          else if (linked !== user.id) logger.warn(`hopper: the ${provider} account connected by ${user.id} already signs in as ${linked}; left as it is`);
        }
      },
    }),
  });
  // The plugin store (issue #75): the instance's. Its installs are kept in the database (issue #93) and
  // unpacked into the work dir, scratch, so they are restored before any user's host loads plugins;
  // every user's host rescans after an install or removal.
  // Where the plugin store is, is an instance setting (issue #445): HOPPER_PLUGIN_STORE only seeds it.
  const defaultRepo = seams.pluginStoreDefault === undefined ? DEFAULT_PLUGIN_STORE : seams.pluginStoreDefault ?? undefined;
  const pluginStore = createPluginStore({
    ...(config.pluginStore ? { seed: config.pluginStore } : {}), ...(defaultRepo ? { defaultRepo } : {}),
    ...(config.pluginDir ? { pluginDir: config.pluginDir } : {}),
    workDir, settings: instance.settings, builtinIds: new Set(BUILTIN_PLUGINS.map((p) => p.id)), plugins: runtimes.plugins,
    events: runtimes.events, clock, logger,
  });
  await pluginStore.restore();
  try {
    await runtimes.sync();
  } catch (e) {
    await runtimes.stop();
    instance.close();
    throw e;
  }
  // The instance's vault events (issue #658) reach every user's log now that their runtimes exist.
  secrets.connect((e) => runtimes.events.append(e));
  // Remote access (issue #880): the tunnel's settings, set in the UI, its authtoken in the instance's vault (an install's NGROK_AUTHTOKEN and
  // HOPPER_PUBLIC_URL from before moved there once), and its watch. The allowed hosts (issue #1024): the admin's, and this host's tailnet's.
  const remoteAccess = createRemoteAccess({ settings: store.settings, secrets: secrets.system, events: runtimes.events, port: () => port, mints: { begin: (kind, key, data) => sagas.begin(kind, key, data), drive: (id) => sagas.drive(id), abort: (id, reason) => sagas.abort(id, reason), open: () => instance.sagas.open() }, instanceId: instance.settings.instanceId(), tunnelApis: config.tunnelApis, ...(seams.tunnelProviders ? { providers: seams.tunnelProviders } : {}), env, publicUrl: config.publicUrl, now: () => clock.now(), logger }), allowedHosts = createAllowedHosts({ settings: store.settings, events: runtimes.events, tailnet: seams.tailnet, lanNames: config.lanNames, port: () => port, logger }), telemetrySettings = createTelemetrySettings({ settings: store.settings, events: runtimes.events, control: seams.telemetry ?? NO_TELEMETRY, logger });
  // The hopper's app's client secret turns GitHub sign-in by redirect on (issue #258). A bad one (NAME and
  // NAME_FILE both set, an unreadable file) stops the start; read again at each use, so a rotated one counts.
  const secret = runtimeSecrets(env);
  try {
    secret(CLIENT_SECRET_VARIABLE);
  } catch (e) {
    await runtimes.stop();
    instance.close();
    throw e;
  }
  const signIn = createSignIn({
    config: auth, clock, origin: () => config.publicUrl ?? `http://localhost:${port}`, apps: config.hopperApps,
    claimGithubAdmin: (who) => claimGithubAdmin(instance, who), accounts: instance.localAccounts,
    githubClientSecret: () => { try { return secret(CLIENT_SECRET_VARIABLE); } catch { return undefined; } },
  });
  // Self-update (issue #44): the restart reaches app.stop() through `restartApp`, set below.
  let restartApp: Restarter = async () => {};
  // A cluster install (issue #1285): updated by helm upgrade of its release, never by compose.
  const appDir = seams.update?.appDir ?? APP_DIR, cluster = clusterInstall(env);
  const updater = createUpdater({
    appDir, cluster, dataDir: workDir, settings: instance.settings, events: runtimes.events, clock, logger,
    builder: seams.update?.builder ?? createInstallScriptBuilder({ logFile: join(workDir, 'update', 'build.log') }),
    restart: seams.update?.restart ?? (() => restartApp()),
    // Only the merge of a pull request whose checks passed (issue #652), asked of github.com's API with the oldest
    // user's GitHub connection there (issue #822): never with no token.
    release: seams.update?.release ?? createReleaseCheck({ clock, github: () => releaseAccount(instance.users.list().flatMap((u) => runtimes.get(u.id)?.connectedAccounts ?? [])) }),
    // A restart would lose the running jobs of every user.
    restartBlockers: () => runtimes.all().reduce((n, rt) => n + restartBlockers(rt.store.jobs.list({ status: ['running'] }), (name) => rt.executors.get(name)), 0),
    checkMs: config.updateCheckMs,
  });
  // The sandboxes the hopper starts, one per step (issues #708, #1349): through the container runtime selected once here
  // (Podman whenever it is reachable), beside the hopper, on the compose network or the host network; or, with the
  // Kubernetes runtime (issue #1286), as pods. It burns the boxes an older build launched, and their sandbox records.
  const sandboxRuntime = seams.containerRuntime ?? await selectRuntime({ podmanSocket: config.podmanSocket, dockerSocket: config.dockerSocket, runtime: config.sandboxRuntime, ...(config.kubernetes ? { kubernetes: { ...config.kubernetes, port } } : {}) }), sandboxes = createSandboxes({
    runtime: sandboxRuntime, repo: instance.sandboxes, runs: instance.sandboxRuns, instanceId: instance.settings.instanceId(),
    network: hopperNetwork(config), cluster: inPod, clients: sandboxClientsOf(runtimes), sandboxHost: (userId) => runtimes.get(userId)?.engine.sandboxHost.hosts() ?? [], podmanHosts: (userId, name) => runtimes.get(userId)?.podmanHost(name), users: () => runtimes.all().map((rt) => rt.user.id), // the sandbox host and the user's Podman hosts (issue #2272), read at each sandbox
    // A read-only box's egress (issue #849): on a socket runtime only; a Kubernetes box has its own egress policy.
    ...(config.egress && (sandboxRuntime?.kind === 'podman' || sandboxRuntime?.kind === 'docker') ? { egress: createEgress(config.egress) } : {}),
    clock, logger, checks: usersTemplates(() => runtimes.all()), drivenElsewhere: () => new Set(instance.sagas.heldByOthers(NEED_STEP_SAGA, leases.owner)), // the read-only check (issue #716); the steps another live hopper drives, which the sweep leaves (issue #1954)
  });
  const gitPushes = createGitPushes({ user: (id) => runtimes.get(id)?.githubProxy.git, begin: (key, data, userId) => { sagas.begin(GIT_PUSH_SAGA, key, data, { userId }); } }), sagas = createSagas({ repo: instance.sagas, definitions: [gitPushes.saga, needStepSaga({ steps: (userId) => runtimes.get(userId)?.needSteps }), windowsStepSaga({ steps: (userId) => runtimes.get(userId)?.windowsSteps }), jobMoveSaga({ engine: (userId) => runtimes.get(userId)?.engine }), jobRunSaga({ engine: (userId) => runtimes.get(userId)?.engine }), topologyDiscoverySaga({ discovery: (userId) => runtimes.get(userId)?.topologyDiscovery }), ...remoteAccess.sagas], owner: leases.owner, clock, logger }), topologyDiscoveries = createTopologyDiscoveries({ users: () => runtimes.all().map((rt) => ({ id: rt.user.id, discovery: rt.topologyDiscovery, graph: () => rt.githubProxy.topology.graph() })), sagas, now: () => clock.now(), log: (l) => logger.warn(l) }); // sagas: work across a boundary that goes on after a stop, on any host (issue #1524), a job's push one of them (issue #1806); topology discovery's runs (issue #1781 part 3)
  const playground = createPlayground({ runtime: sandboxRuntime, noRuntime: inPod ? NO_RUNTIME_IN_CLUSTER : NO_RUNTIME, instanceId: instance.settings.instanceId(), network: hopperNetwork(config), limits: config.playground, clock, logger }); // the sandbox playground (issue #1410): many sandboxes at once, on the same runtime, none a machine
  const addUser = async (name: string): Promise<User> => {
    const user = instance.users.add(name);
    return runtimes.ensure(user).then(() => user);
  };
  // Stack resources (issue #947): the containers through the runtime's socket, the sandbox boxes on client targets through
  // their clients, Postgres through the store, OpenFGA and Solr their metrics, with every user's documents waiting to be
  // indexed; the stack recorder keeps them over time.
  const solrMeter = seams.solrMeter ?? (config.solrUrl ? createSolrMeter({ url: config.solrUrl }) : undefined), stack = createStack({ meter: seams.containerMeter ?? meterFor({ config, instanceId: instance.settings.instanceId(), self: ownContainer(config.localMachine) }), remote: seams.remoteBoxMeter ?? createRemoteBoxMeter({ instanceId: instance.settings.instanceId(), records: () => instance.sandboxes.list(), clients: sandboxClientsOf(runtimes), podmanHosts: podmanHostsInUse(runtimes, () => instance.sandboxRuns.open()) }), openfga: seams.openFgaMeter ?? (config.openFgaUrl ? createOpenFgaMeter({ url: openFgaMetricsUrl(config.openFgaUrl) }) : undefined), solr: solrMeter && { meter: solrMeter, pending: () => runtimes.all().reduce((n, r) => n + r.search.status().pending, 0) }, database: store.databaseStats, history: store.stackHistory, clock, logger });
  // The cloud link (issue #467) and its agent, the connection to hopper.io (issue #2039): told of each change the admin makes.
  const cloudLinkParts = createCloudLinkParts({ settings: instance.settings, secrets: secrets.system, events: runtimes.events, now: () => clock.now(), state: { tenants: { list: () => instance.users.list(), user: (id) => runtimes.get(id) }, updater, clock }, ...(seams.cloudLink ? { target: seams.cloudLink } : {}) }), { cloudLink } = cloudLinkParts, server = createServer({
    // The stack against the compose file of this version (issue #697): checked at start, and at each GET /api/update/drift.
    // The shared GitHub rate limiter (issue #436): every GitHub call of this process goes through it, with the saved settings.
    instance, clock, version: VERSION, pluginStore, updater, gitPushes, buildDir: appDir, access, sandboxes, playground, masterKey: masterKeyStatus, rateLimiter: createRateLimiterControl({ settings: store.settings, events: runtimes.events }), stackResources: stack.resources, cluster, stackDrift: startStackDrift({ appDir, env, logger, cluster, channel: () => clusterChannelTag(updater.status()), probe: seams.update?.stackProbe ?? createStackProbe({ vaultUrl: config.vaultUrl, database: databaseHostOf(config.databaseUrl, () => { store.databaseStats.read(); return true; }) }) }),
    tenants: {
      user: (id) => runtimes.get(id),
      list: () => instance.users.list(),
      add: addUser,
      // Sign-in (issue #158): a linked identity's user, else a new user with its runtime.
      async signInAs(who) {
        const { user } = userForIdentity(instance, who);
        await runtimes.ensure(user);
        return user;
      },
      // The API door (issue #255): only a linked identity's user.
      linked(who) {
        const id = instance.identities.userOf(who.realm, who.subject);
        return id === undefined ? undefined : instance.users.get(id);
      },
    },
    port: () => port, signIn, signInEnvironment, events: runtimes.events, held: seams.held === undefined ? watchHeld(config.healthPort === undefined ? {} : { health: { port: config.healthPort, version: VERSION } }) : seams.held ?? undefined, // issue #1383: where a held loop runs, and the health port
    // GitHub deliveries (issue #1079): signed with the GitHub webhook secret of the instance's vault; each makes its repository due at every user's sources.
    lan: { names: config.lanNames, peers: config.lanPeers, publicUrl: config.publicUrl, tunnelUrl: remoteAccess.url, moreNames: allowedHosts.names, tailnet: allowedHosts.tailnet }, remoteAccess, allowedHosts, telemetrySettings, sourceEmailMatch: createSourceEmailMatch({ settings: instance.settings, events: runtimes.events }), infraApplies: createInfraApplies({ settings: instance.settings, events: runtimes.events }), cloudLink, displayName: createDisplayName({ settings: instance.settings, events: runtimes.events }), githubDeliveries: createGitHubDeliveries({ secrets: secrets.system, tenants: { list: () => instance.users.list(), user: (id) => runtimes.get(id) }, clock }), wsl, uiDir: seams.uiDir ?? UI_DIR, caller: tunnelCaller(remoteAccess.watch),
    client: { links, release: clientRelease, installScript: readFileSync(join(APP_DIR, 'scripts', 'client-install.sh'), 'utf8'), poolKey: () => { try { return secret(LANE_POOL_KEY_VARIABLE); } catch { return undefined; } } }, // the lane pool key (issue #1284)
  });

  // Before listening: the boot after an update records update.applied before anything is answered.
  updater.start(); void telemetrySettings.start(); // the telemetry setting (issue #1486): its export, unless the launch's wins
  pluginStore.start();
  access.start();
  await server.listen({ host: config.host, port: config.port });
  port = (server.server.address() as { port: number }).port;
  await runtimes.start();
  runtimes.watch(intervalMs);
  // After the runtimes: a box is kept only when a machine names it, so the machines must be known first.
  sandboxes.start(); sagas.start(); cloudLinkParts.agent.start(); topologyDiscoveries.start(); void playground.start(); stack.recorder.start();
  const stopQueueTelemetry = observeQueueOf(() => runtimes.all().map((rt) => rt.store)); // the queue's state, read only while telemetry is on (issue #1486)

  let stopped: Promise<void> | undefined;
  const app: App = {
    url: `http://127.0.0.1:${port}`,
    config,
    auth: () => signIn.config(),
    answerUrl: (id) => uiUrl(`question-${id}`),
    instance,
    updater,
    access,
    sandboxes, playground,
    masterKey: masterKeyStatus, stackHistory: stack.recorder,
    users: () => instance.users.list(),
    user(id) {
      const rt = runtimes.get(id);
      if (!rt) throw new Error(`no runtime for user ${id}`);
      return rt;
    },
    addUser,
    stop() {
      stopped ??= (async () => {
        updater.stop(); stack.recorder.stop(); stopQueueTelemetry(); await cloudLinkParts.agent.stop();
        await access.stop();
        topologyDiscoveries.stop(); const passes = Promise.all([sandboxes.stop(), playground.stop(), sagas.stop()]);
        // A link is an upgraded socket: the server does not track it, so it would hold the close open.
        links.closeAll(); allowedHosts.stop();
        await Promise.all([server.close(), passes, remoteAccess.stop()]);
        await runtimes.stop();
        leases.stop(); instance.close();
      })();
      return stopped;
    },
  };
  restartApp = createRestarter({ appDir, ...(config.restart ? { forced: config.restart } : {}), stop: () => app.stop(), logger });
  return app;
}

async function main(): Promise<void> {
  // OpenTelemetry (issue #1486, design.md "Telemetry"): before the mask covers the streams, so a log record is the masked line.
  const telemetry = startProcessTelemetry({ env: process.env, version: VERSION, stdout: process.stdout, stderr: process.stderr });
  for (const s of [process.stdout, process.stderr]) logMask.cover(s); // every log line through the secret mask (issue #685)
  // The first boot of a job-hopper install's self-update (issue #112): hand over to the hopper units, or
  // run the previous install until no job holds a pane in the old herdr session.
  const renamed = renameBoot({ env: process.env, appDir: APP_DIR, log: (l) => console.log(l) });
  if (renamed === 'rollback') process.exit(RESTART_EXIT_CODE);
  if (renamed === 'handover') {
    process.once('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 60_000);
    return;
  }
  const app = await startApp(loadConfig(process.env), { telemetry });
  logStartup(app);
  const shutdown = (signal: string): void => {
    console.log(`hopper: ${signal}, shutting down`);
    app.stop().then(() => telemetry.shutdown()).then(() => process.exit(0), (e) => {
      console.error('shutdown failed', e);
      process.exit(1);
    });
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => shutdown(signal));
}

const asksHelp = process.argv.includes('--help') || process.argv.includes('-h');
if (import.meta.main && asksHelp) process.stdout.write(daemonHelp());
else if (import.meta.main) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
