// Composition root (design.md "Users: one hopper, separate users"): config → instance store →
// sign-in config → plugin store → one user runtime per user (src/users/: the plugins config, plugin host, engine,
// sources, questions, webhooks, notifiers) → updater → server. Adapters are built by their plugins,
// through each user's host (integration tests call startApp, with doubles at the seams).
import { artifactBase } from './artifacts/links.ts';
import { jobHopperUrl } from './github-proxy/reach.ts';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createMachineLinks } from './machines/links.ts';
import { hopperAddresses } from './machines/hopper-address.ts';
import { createAccess, LIVE_JOB_STATUSES, type Access } from './authz/service.ts';
import { createCredentialMinter } from './vault/minter.ts';
import { createOpenFgaServer } from './authz/openfga.ts';
import { fileURLToPath } from 'node:url';
import type { AuthorizationServer, ContainerRuntime, InstanceStore, ReleaseCheck, Restarter, StackProbe, UpdateBuilder, Updater } from './domain/ports.ts';
import { machineOfLane } from './domain/raised-by.ts';
import type { MachineSnapshot, User } from './domain/types.ts';
import { daemonHelp, loadConfig, type Config } from './config.ts';
import { logStartup } from './startup-log.ts';
import { createRemoteAccess, createServer, tunnelCaller } from './http/index.ts';
import { claimGithubAdmin, createSignIn, prepareSignIn, type AuthConfig } from './auth/index.ts';
import { readRelease } from './client/release.ts';
import { BUILTIN_PLUGINS } from './plugins/builtin.ts';
import { createPluginStore, DEFAULT_PLUGIN_STORE, installedDirOf } from './plugins/plugin-store.ts';
import { logMasterKey, resolveMasterKey, withMasterKey, type MasterKey } from './secrets/master-key.ts';
import { masterKeyRotation } from './users/master-key-rotation.ts';
import { createRateLimiterControl } from './github-limiter/settings.ts';
import { createMasterKeyStatus, type MasterKeyStatus } from './http/master-key.ts';
import { logMask } from './secrets/log-mask.ts';
import { runtimeSecrets } from './secrets/runtime.ts';
import { CLIENT_SECRET_VARIABLE } from './connected-accounts/web-flow.ts';
import { openInstanceStore } from './store/index.ts';
import { createInstallScriptBuilder, createReleaseCheck, createRestarter, releaseAccount, createStackProbe, createUpdater, startStackDrift, renameBoot, RESTART_EXIT_CODE, restartBlockers } from './update/index.ts';
import { userForIdentity } from './users/identities.ts';
import type { UserRuntime, UserSeams } from './users/runtime.ts';
import { createRuntimes } from './users/runtimes.ts';
import { openInstanceSecrets } from './users/instance-secrets.ts';
import { sandboxBoxesFor, sandboxClientsOf } from './users/sandbox-boxes.ts';
import { mintJoinCode } from './machines/join-code.ts';
import { selectRuntime } from './sandbox/runtime.ts'; import { createStackResources, meterFor } from './stack-resources/index.ts';
import { cachedSandboxes, createSandboxes, hopperAddress, hopperNetwork, launchScopes, ownContainer, usersAgentCredentials, usersTemplates, type Sandboxes } from './sandbox/service.ts';
import { foldLeftoverAdmin } from './users/leftover-admin.ts';

export type { UserSeams } from './users/runtime.ts';

export interface App {
  /** Always the loopback URL, whatever the bind address. */
  url: string;
  config: Config;
  /** The sign-in config as it applies now (loaded at start, changed from Settings → Sign-in). */
  auth: () => AuthConfig;
  /** The UI link to one question, as notifications carry it: the first LAN name, else loopback. */
  answerUrl(questionId: string): string;
  /** The instance store: users, identity links, sessions, login codes, the sign-in config, instance settings. */
  instance: InstanceStore;
  updater: Updater;
  /** Access (issue #559): the decision the vault asks before every mint, the approvals, the model. */
  access: Access;
  /** The sandbox boxes the hopper starts and removes (issue #603). */
  sandboxes: Sandboxes;
  /** The master key's status (issue #659): its source, the one reveal, a person's word that they saved it. */
  masterKey: MasterKeyStatus;
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
   * the stack's containers (issue #947); default the meter on the sandbox runtime's socket, else none. */
  containerRuntime?: ContainerRuntime; containerMeter?: import('./domain/stack-resources.ts').ContainerMeter;
  /** How long a sandbox launch waits for the box's start check (issue #708); default START_CHECK_MS. */
  startCheckMs?: number;
  /** Self-update: the install dir (default APP_DIR), the build (default install.sh build-only mode), the restart (default exit or respawn). */
  /** `stackProbe`: what the hopper sees of its stack (issue #697); default the compose network's names and the vault container's /health. */
  update?: { appDir?: string; builder?: UpdateBuilder; restart?: Restarter; stackProbe?: StackProbe; release?: ReleaseCheck };
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
  const { env: _env, pluginsConfigIntervalMs: _ms, perUser, uiDir: _ui, update: _up, pluginStoreDefault: _store, authorizationServer: _fga, containerRuntime: _box, containerMeter: _meter, startCheckMs: _check, ...shared } = seams;
  return { ...shared, ...perUser?.(userId) };
}

export async function startApp(config: Config, seams: AppSeams = {}): Promise<App> {
  const clock = { now: () => new Date() };
  const logger = { info: (l: string) => console.log(l), warn: (l: string) => console.warn(l) };
  warnLeftoverEnv(config);
  const store = openInstanceStore({ url: config.databaseUrl, clock });
  // Held while the daemon runs: the operator CLI refuses `user transfer` against a running daemon (issue #212).
  if (!store.holdDaemonLock()) logger.warn('hopper: another process holds this database\'s daemon lock (a second daemon?)');
  const env = seams.env ?? process.env;
  // The master key (issue #659): from the launch, checked against the database's fingerprint before anything opens a
  // secret; a wrong key stops the start. The parts read it through `keyed`, never from a file or the old token key.
  let masterKey: MasterKey;
  try {
    const { settings } = store;
    masterKey = resolveMasterKey({ env, kept: () => store.keptSecrets(), record: { fingerprint: () => settings.masterKeyFingerprint(), setFingerprint: (fp) => settings.setMasterKeyFingerprint(fp), rotation: () => settings.masterKeyRotation() } });
  } catch (e) {
    store.close();
    throw e;
  }
  const { env: keyed, use: useKey } = withMasterKey(env, masterKey.source === 'missing' ? undefined : masterKey);
  // A rotation (issue #659): every secret sealed again, then the running hopper on the new key (src/users/master-key-rotation.ts).
  const masterKeyStatus = createMasterKeyStatus(masterKey, store.settings, masterKeyRotation({ store, keyed: { use: useKey }, mask: logMask, vaultUrl: config.vaultUrl, logger, append: (e) => runtimes.events.append(e) }));
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
  let port = config.port;
  const uiUrl = (hash: string): string => `http://${config.lanNames[0] ?? '127.0.0.1'}:${port}/#${hash}`;
  // Where a notification's artifact link points (issue #673): the user's link base, else the hopper's own default.
  const artifactLinkBase = (linkBase: string): string => artifactBase({ linkBase, publicUrl: config.publicUrl, lanNames: config.lanNames, port });
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
  // Access (issue #559): the instance's. Who is live (issue #581): each user's live jobs, each on the machine it runs on,
  // and each box with its template; a template is rated from every user's vault templates of its name (issue #584).
  // Made before the runtimes: each user's vault approves profiles in it.
  const fgaKey = runtimeSecrets(env);
  const access = createAccess({
    repo: instance.access, clock, logger,
    server: seams.authorizationServer ?? (config.openFgaUrl ? createOpenFgaServer({ url: config.openFgaUrl, key: () => fgaKey('HOPPER_OPENFGA_KEY') }) : undefined),
    jobStatus: (userId, jobId) => runtimes.get(userId)?.store.jobs.get(jobId)?.status,
    requesters: () => runtimes.all().map((rt) => ({
      userId: rt.user.id,
      jobs: rt.store.jobs.list({ status: [...LIVE_JOB_STATUSES] }).map((j) => {
        const machine = machineOfLane(j.laneId) ?? j.resumeOn;
        return { jobId: j.id, ...(machine === undefined ? {} : { machine }) };
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
  });
  // The vault mints through STS and the Kubernetes API (issue #580), only after access allows it. It reads each box's launch
  // scope from the sandbox records, kept in memory (issue #708): from callbacks too, which can outlive the database. The
  // tunnel watch (issue #795, remoteAccess below): whether the remote access URL is up, so each user's Grok Bot routine is
  // told where the hopper is.
  const minter = createCredentialMinter(), sandboxRecords = cachedSandboxes(instance.sandboxes);
  // The shared secrets (issue #718): the instance's, every user's vault lists them and delivers them after Access allows it.
  const runtimes = createRuntimes({
    instance, logger,
    options: (user) => ({
      config, seams: seamsOf(seams, user.id), env: keyed, clock, logger, clientRelease, links, proxyUrl, hopperUrls: () => hopperAddresses({ publicUrl: config.publicUrl, lanNames: config.lanNames, port }), network: hopperNetwork(config), access, minter, instanceSecrets: secrets.system, sharedSecrets: secrets.shared(access), launchScopes: (userId) => launchScopes(sandboxRecords.list(), userId),
      installedDir: installedDirOf(workDir), pluginsConfigIntervalMs: intervalMs, uiUrl, artifactLinkBase, reach: () => remoteAccess.watch.url(),
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
  // Remote access (issue #880): the tunnel's settings, set in the UI, its authtoken in the instance's vault (an install's
  // NGROK_AUTHTOKEN and HOPPER_PUBLIC_URL from before moved there once), and its watch.
  const remoteAccess = createRemoteAccess({ settings: store.settings, secrets: secrets.system, events: runtimes.events, tunnelApi: config.tunnelApi, env, publicUrl: config.publicUrl, now: () => clock.now(), logger });
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
    claimGithubAdmin: (who) => claimGithubAdmin(instance, who),
    githubClientSecret: () => { try { return secret(CLIENT_SECRET_VARIABLE); } catch { return undefined; } },
  });
  // Self-update (issue #44): the restart reaches app.stop() through `restartApp`, set below.
  let restartApp: Restarter = async () => {};
  const appDir = seams.update?.appDir ?? APP_DIR;
  const updater = createUpdater({
    appDir, dataDir: workDir, settings: instance.settings, events: runtimes.events, clock, logger,
    builder: seams.update?.builder ?? createInstallScriptBuilder({ logFile: join(workDir, 'update', 'build.log') }),
    restart: seams.update?.restart ?? (() => restartApp()),
    // Only the merge of a pull request whose checks passed (issue #652), asked of github.com's API with the oldest
    // user's GitHub connection there (issue #822): never with no token.
    release: seams.update?.release ?? createReleaseCheck({ clock, github: () => releaseAccount(instance.users.list().flatMap((u) => runtimes.get(u.id)?.connectedAccounts ?? [])) }),
    // A restart would lose the running jobs of every user.
    restartBlockers: () => runtimes.all().reduce((n, rt) => n + restartBlockers(rt.store.jobs.list({ status: ['running'] }), (name) => rt.executors.get(name)), 0),
    checkMs: config.updateCheckMs,
  });
  // The sandbox boxes the hopper starts (issues #603, #708): through the container runtime selected once here (Podman
  // whenever it is reachable), beside the hopper — on the compose network, reaching it by its LAN name, or on the host
  // network, reaching it on loopback.
  const sandboxes = createSandboxes({
    runtime: seams.containerRuntime ?? await selectRuntime({ podmanSocket: config.podmanSocket, dockerSocket: config.dockerSocket, runtime: config.sandboxRuntime }),
    repo: sandboxRecords, instanceId: instance.settings.instanceId(),
    network: hopperNetwork(config),
    joinUrl: () => (config.localMachine ? `http://127.0.0.1:${port}` : `http://${config.lanNames[0] ?? 'hopper'}:${port}`),
    address: (runtime) => hopperAddress({ runtime, network: hopperNetwork(config), self: ownContainer(config.localMachine), lanNames: config.lanNames, port }),
    ...(seams.startCheckMs !== undefined ? { startCheckMs: seams.startCheckMs } : {}),
    clients: sandboxClientsOf(runtimes),
    mint: (userId, container, template) => mintJoinCode(instance, clock, userId, { container, ...(template ? { template } : {}) }).code,
    boxesOf: sandboxBoxesFor(instance, runtimes),
    waiting: (now) => new Set(instance.joinCodes.waiting(now.toISOString())),
    clock, logger, checks: usersTemplates(() => runtimes.all()), agentCredentials: usersAgentCredentials(() => runtimes.all()), // the read-only check (issue #716), the agent credential (#708)
  });
  const addUser = async (name: string): Promise<User> => {
    const user = instance.users.add(name);
    return runtimes.ensure(user).then(() => user);
  };
  const server = createServer({
    // The stack against the compose file of this version (issue #697): checked at start, and at each GET /api/update/drift.
    // The shared GitHub rate limiter (issue #436): every GitHub call of this process goes through it, with the saved settings.
    // Stack resources (issue #947): the containers through the sandbox runtime's socket, Postgres through the store.
    instance, clock, version: VERSION, pluginStore, updater, buildDir: appDir, access, sandboxes, masterKey: masterKeyStatus, rateLimiter: createRateLimiterControl({ settings: store.settings, events: runtimes.events }), stackResources: createStackResources({ meter: seams.containerMeter ?? meterFor({ config, instanceId: instance.settings.instanceId(), self: ownContainer(config.localMachine) }), database: store.databaseStats, clock }), stackDrift: startStackDrift({ appDir, env, logger, probe: seams.update?.stackProbe ?? createStackProbe({ vaultUrl: config.vaultUrl }) }),
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
    port: () => port, signIn, signInEnvironment,
    lan: { names: config.lanNames, peers: config.lanPeers, publicUrl: config.publicUrl, tunnelUrl: remoteAccess.url }, remoteAccess, uiDir: seams.uiDir ?? UI_DIR, caller: tunnelCaller(remoteAccess.watch),
    client: { links, release: clientRelease, installScript: readFileSync(join(APP_DIR, 'scripts', 'client-install.sh'), 'utf8') },
  });

  // Before listening: the boot after an update records update.applied before anything is answered.
  updater.start();
  pluginStore.start();
  access.start();
  await server.listen({ host: config.host, port: config.port });
  port = (server.server.address() as { port: number }).port;
  await runtimes.start();
  runtimes.watch(intervalMs);
  // After the runtimes: a box is kept only when a machine names it, so the machines must be known first.
  sandboxes.start();

  let stopped: Promise<void> | undefined;
  const app: App = {
    url: `http://127.0.0.1:${port}`,
    config,
    auth: () => signIn.config(),
    answerUrl: (id) => uiUrl(`question-${id}`),
    instance,
    updater,
    access,
    sandboxes,
    masterKey: masterKeyStatus,
    users: () => instance.users.list(),
    user(id) {
      const rt = runtimes.get(id);
      if (!rt) throw new Error(`no runtime for user ${id}`);
      return rt;
    },
    addUser,
    stop() {
      stopped ??= (async () => {
        updater.stop();
        await access.stop();
        const passes = sandboxes.stop();
        // A link is an upgraded socket: the server does not track it, so it would hold the close open.
        links.closeAll();
        await Promise.all([server.close(), passes, remoteAccess.stop()]);
        await runtimes.stop();
        instance.close();
      })();
      return stopped;
    },
  };
  restartApp = createRestarter({ appDir, ...(config.restart ? { forced: config.restart } : {}), stop: () => app.stop(), logger });
  return app;
}

async function main(): Promise<void> {
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
  const app = await startApp(loadConfig(process.env));
  logStartup(app);
  const shutdown = (signal: string): void => {
    console.log(`hopper: ${signal}, shutting down`);
    app.stop().then(() => process.exit(0), (e) => {
      console.error('shutdown failed', e);
      process.exit(1);
    });
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => shutdown(signal));
}

const asksHelp = process.argv.includes('--help') || process.argv.includes('-h');
if (import.meta.main && asksHelp) process.stdout.write(daemonHelp());
else if (import.meta.main) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
