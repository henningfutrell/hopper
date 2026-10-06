// Composition root (design.md "Users: one hopper, separate users"): config → instance store →
// sign-in config → plugin store → one user runtime per user (src/users/: the plugins config, plugin host, engine,
// sources, questions, webhooks, notifiers) → updater → server. Adapters are built by their plugins,
// through each user's host (integration tests call startApp, with doubles at the seams).
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InstanceStore, Restarter, UpdateBuilder, Updater } from './domain/ports.ts';
import type { User } from './domain/types.ts';
import { daemonHelp, loadConfig, type Config } from './config.ts';
import { logStartup } from './startup-log.ts';
import { createServer } from './http/index.ts';
import { createSignIn, loadSignInConfig, type AuthConfig } from './auth/index.ts';
import { readRelease } from './client/release.ts';
import { BUILTIN_PLUGINS } from './plugins/builtin.ts';
import { createPluginStore, installedDirOf } from './plugins/plugin-store.ts';
import { runtimeSecrets } from './secrets/runtime.ts';
import { openInstanceStore } from './store/index.ts';
import { createInstallScriptBuilder, createRestarter, createUpdater, renameBoot, RESTART_EXIT_CODE, restartBlockers } from './update/index.ts';
import { userForIdentity } from './users/identities.ts';
import type { UserRuntime, UserSeams } from './users/runtime.ts';
import { createRuntimes } from './users/runtimes.ts';

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
  /** The built UI bundle; default UI_DIR. */
  uiDir?: string;
  /** Self-update: the install dir (default APP_DIR), the build (default install.sh build-only mode), the restart (default exit or respawn). */
  update?: { appDir?: string; builder?: UpdateBuilder; restart?: Restarter };
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
  const { env: _env, pluginsConfigIntervalMs: _ms, perUser, uiDir: _ui, update: _up, ...shared } = seams;
  return { ...shared, ...perUser?.(userId) };
}

export async function startApp(config: Config, seams: AppSeams = {}): Promise<App> {
  const clock = { now: () => new Date() };
  const logger = { info: (l: string) => console.log(l), warn: (l: string) => console.warn(l) };
  warnLeftoverEnv(config);
  const instance = openInstanceStore({ url: config.databaseUrl, clock });
  const env = seams.env ?? process.env;
  // The instance's own secrets (the sign-in config's clientSecretEnv) keep their names: no user prefix.
  const secret = runtimeSecrets(env);
  // Before anything starts: an invalid sign-in config stops the daemon (sign-in fails closed).
  let auth: AuthConfig;
  try {
    auth = loadSignInConfig(instance.signInConfig.read(), secret);
  } catch (e) {
    instance.close();
    throw e;
  }
  const workDir = config.workDir;
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  let port = config.port;
  const answerUrl = (id: string): string => `http://${config.lanNames[0] ?? '127.0.0.1'}:${port}/#question-${id}`;
  const intervalMs = seams.pluginsConfigIntervalMs ?? PLUGINS_CONFIG_CHECK_MS;
  // The client release this hopper loads onto its client targets: the client files of the install it runs from (issue #70).
  const clientRelease = readRelease(join(APP_DIR, 'src', 'client'));
  const runtimes = createRuntimes({
    instance, logger,
    options: (user) => ({
      config, seams: seamsOf(seams, user.id), env, clock, logger, clientRelease,
      installedDir: installedDirOf(workDir), pluginsConfigIntervalMs: intervalMs, answerUrl,
    }),
  });
  // The plugin store (issue #75): the instance's. Its installs are kept in the database (issue #93) and
  // unpacked into the work dir, scratch, so they are restored before any user's host loads plugins;
  // every user's host rescans after an install or removal.
  const pluginStore = createPluginStore({
    ...(config.pluginStore ? { repo: config.pluginStore } : {}), ...(config.pluginDir ? { pluginDir: config.pluginDir } : {}),
    workDir, installs: instance.settings, builtinIds: new Set(BUILTIN_PLUGINS.map((p) => p.id)), plugins: runtimes.plugins,
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
  const signIn = createSignIn({ config: auth, clock, origin: () => config.publicUrl ?? `http://localhost:${port}` });
  // Self-update (issue #44): the restart reaches app.stop() through `restartApp`, set below.
  let restartApp: Restarter = async () => {};
  const appDir = seams.update?.appDir ?? APP_DIR;
  const updater = createUpdater({
    appDir, dataDir: workDir, settings: instance.settings, events: runtimes.events, clock, logger,
    builder: seams.update?.builder ?? createInstallScriptBuilder({ logFile: join(workDir, 'update', 'build.log') }),
    restart: seams.update?.restart ?? (() => restartApp()),
    // A restart would lose the running jobs of every user.
    restartBlockers: () => runtimes.all().flatMap((rt) => restartBlockers(rt.store.jobs.list({ status: ['running'] }), (name) => rt.executors.get(name))),
    checkMs: config.updateCheckMs,
  });
  const addUser = async (name: string): Promise<User> => {
    const user = instance.users.add(name);
    await runtimes.ensure(user);
    return user;
  };
  const server = createServer({
    instance, clock, version: VERSION, pluginStore, updater,
    tenants: {
      user: (id) => runtimes.get(id),
      ownerId: () => instance.users.owner().id,
      list: () => instance.users.list(),
      add: addUser,
      // Sign-in (issue #158): a linked identity's user, owner for no sign-in, else a new user with its runtime.
      async signInAs(who) {
        const { user } = userForIdentity(instance, who);
        await runtimes.ensure(user);
        return user;
      },
    },
    port: () => port, sessionHours: config.uiSessionHours, signIn, secret,
    lan: { names: config.lanNames, peers: config.lanPeers, publicUrl: config.publicUrl }, uiDir: seams.uiDir ?? UI_DIR,
  });

  // Before listening: the boot after an update records update.applied before anything is answered.
  updater.start();
  pluginStore.start();
  await server.listen({ host: config.host, port: config.port });
  port = (server.server.address() as { port: number }).port;
  await runtimes.start();
  runtimes.watch(intervalMs);

  let stopped: Promise<void> | undefined;
  const app: App = {
    url: `http://127.0.0.1:${port}`,
    config,
    auth: () => signIn.config(),
    answerUrl,
    instance,
    updater,
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
        await server.close();
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
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

const asksHelp = process.argv.includes('--help') || process.argv.includes('-h');
if (import.meta.main && asksHelp) process.stdout.write(daemonHelp());
else if (import.meta.main) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
