// Composition root: config → store → plugins.yaml (written on the first boot without one) → plugin
// host (every part) → engine → server. Adapters are built by their plugins, here through the
// host (integration tests call startApp, with doubles at the seams).
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Answerer, Assessor, Clock, Executor, JobSource, PluginsView, Restarter, Router, SettableUsageSource, SourceRegistry, Store, UpdateBuilder, Updater } from './domain/ports.ts';
import type { AttachedMachine, Question, SourceStatus } from './domain/types.ts';
import { isRerunnable } from './domain/types.ts';
import { daemonHelp, loadConfig, type Config } from './config.ts';
import { logStartup } from './startup-log.ts';
import { createEngine, type Engine } from './engine/index.ts';
import { createExecutorRegistry } from './executors/index.ts';
import type { HerdrClient } from './executors/herdr/index.ts';
import { clientSocket, type ClientTransport } from './executors/client.ts';
import { dockerHost } from './executors/docker.ts';
import { hopperSshAuth, pinHostKeys } from './executors/ssh.ts';
import { createServer } from './http/index.ts';
import { AUTH, createSignIn, loadAuthDocument, type AuthConfig } from './auth/index.ts';
import { combineMachineSources, createAttachedMachines, createClientReleaseKeeper, probeContainer, probeHerdrOverSsh, type MachineProbe } from './machines/index.ts';
import { readRelease } from './client/release.ts';
import { BUILTIN_PLUGINS } from './plugins/builtin.ts';
import { herdrClaudePlugin } from './plugins/executor/herdr-claude/index.ts';
import { createPluginHost, type BuiltJobSource } from './plugins/index.ts';
import { createPluginStore, installedDirOf } from './plugins/plugin-store.ts';
import type { JobSourceInstance } from './plugins/sdk.ts';
import { unavailableExecutors } from './plugins/executor-slot.ts';
import { githubAppPlugin } from './plugins/job-source/github-app/index.ts';
import { githubGhPlugin } from './plugins/job-source/github-gh/index.ts';
import { grokbotRoutinePlugin } from './plugins/notifier/grokbot-routine/index.ts';
import { ensurePluginsDocument } from './plugins/builtin-instances.ts';
import { createDetectionKit } from './plugins/detect.ts';
import { createQuestionService } from './questions/index.ts';
import { logFailures } from './engine/failure-log.ts';
import { createSourceSync, idleStatus, withFixedStatuses, type GitHubApi, type SourceSync } from './sources/index.ts';
import { runtimeSecrets } from './secrets/runtime.ts';
import { openStore } from './store/index.ts';
import { createInstallScriptBuilder, createRestarter, createUpdater, renameBoot, RESTART_EXIT_CODE, restartBlockers } from './update/index.ts';
import { createWebhookConfigWatcher, type WebhookConfigWatcher } from './webhooks/config.ts';
import { createWebhooksEditor } from './webhooks/edit.ts';
import { createWebhookDispatcher, secretProblem } from './webhooks/index.ts';

export interface App {
  /** Always the loopback URL, whatever the bind address. */
  url: string;
  config: Config;
  /** auth.yaml as loaded at start. */
  auth: AuthConfig;
  /** The UI link to one question, as notifications carry it: the first LAN name, else loopback. */
  answerUrl(questionId: string): string;
  routerMode(): string;
  /** For tests: the store, the engine (setFakeUsage), the sync loop (syncNow). */
  plugins: PluginsView;
  store: Store;
  engine: Engine;
  sources: SourceSync;
  updater: Updater;
  /** Close the server; stop the sync loop, question service, engine (≤ 5 s), dispatcher, notifiers, plugin host; close the store. */
  stop(): Promise<void>;
}

/** Doubles at ports.ts seams, for integration tests. Production passes none. */
export interface AppSeams {
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
  /** Replaces the configured answerer; null = no answerer. The report stays the host's. */
  answerer?: Answerer | null;
  /** Replaces the configured assessor. The report stays the host's. */
  assessor?: Assessor;
  /** How often plugins.yaml's version is checked; default PLUGINS_FILE_CHECK_MS. */
  /** The environment the parts read their secrets from (design.md "Secrets"); default process.env. */
  env?: Record<string, string | undefined>;
  pluginsFileIntervalMs?: number;
  /** Replaces the probe of every attached machine: online = its herdr session (ssh) or its container (docker) is running. */
  machineProbe?: (machine: AttachedMachine) => Promise<MachineProbe>;
  /** Replaces resolving a new ssh target when the UI adds a machine (issues #18, #59): its herdr path and pinned host key, or a rejection with the reason. */
  resolveTarget?: (ssh: string) => Promise<{ herdrBin: string; hostKey: string }>;
  /** The built UI bundle; default UI_DIR. */
  uiDir?: string;
  /** Self-update: the install dir (default APP_DIR), the build (default install.sh build-only mode), the restart (default exit or respawn). */
  update?: { appDir?: string; builder?: UpdateBuilder; restart?: Restarter };
}

const PLUGINS_FILE_CHECK_MS = 5000;
const SEAM_SOURCE_POLL_MS = 1000;
const UI_DIR = fileURLToPath(new URL('../ui/dist', import.meta.url));
/** The install (or checkout) this process runs from: install.json and src/ live here. */
const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** The built-in plugins with the seams (tests) in place of the herdr CLI and the GitHub adapters. */
function withSeams(seams: AppSeams) {
  return BUILTIN_PLUGINS.map((p) => {
    if (p.id === 'herdr-claude' && seams.herdr) return herdrClaudePlugin(seams.herdr);
    if (p.id === 'github-gh' && seams.github) return githubGhPlugin(seams.github);
    if (p.id === 'github-app' && seams.githubApp) return githubAppPlugin(seams.githubApp);
    if (p.id === 'grokbot-routine' && seams.grokbotBaseMs) return grokbotRoutinePlugin({ baseMs: seams.grokbotBaseMs });
    return p;
  });
}

/** HOPPER_* variables that are set but read by nothing: one loud line. */
function warnLeftoverEnv(config: Config): void {
  const names = Object.keys(config.leftoverEnv).sort();
  if (names.length === 0) return;
  console.warn(`hopper: WARNING: set but no longer read (plugins.yaml configures every part; remove them from the unit): ${names.join(', ')}`);
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
    machinesConfig: host.machinesConfig, editMachines: host.editMachines,
    routing: host.routing, editRouting: host.editRouting,
  };
}

export async function startApp(config: Config, seams: AppSeams = {}): Promise<App> {
  const clock: Clock = { now: () => new Date() };
  const logger = { info: (l: string) => console.log(l), warn: (l: string) => console.warn(l) };
  warnLeftoverEnv(config);
  const store = openStore({ url: config.databaseUrl, clock });
  // plugins.yaml is the one truth: the built-in instances are written on the boot that finds none.
  ensurePluginsDocument({ documents: store.documents, answerTimeoutMs: config.answerTimeoutMs, logger });
  const env = seams.env ?? process.env;
  // Every secret comes from the runtime: a variable, or the mounted file <name>_FILE names (issue #56).
  const secret = runtimeSecrets(env);
  // Before anything starts: an invalid auth.yaml stops the daemon (sign-in fails closed).
  let auth: AuthConfig;
  try {
    auth = loadAuthDocument(store.documents.read(AUTH), secret);
  } catch (e) {
    store.close();
    throw e;
  }
  const dataDir = config.workDir;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // How the hopper proves itself to an ssh target, asked at every connection (design.md "Target authentication").
  const sshAuth = () => hopperSshAuth({ env: secret, dataDir });
  // Where client targets' reverse tunnels open their sockets: this user's alone (design.md "Client targets").
  mkdirSync(join(dataDir, 'clients'), { recursive: true, mode: 0o700 });
  const clientTransport = (machine: string, tokenEnv: string): ClientTransport => ({
    machine, socket: clientSocket(dataDir, machine), token: () => secret(tokenEnv) ?? '',
  });
  // The client release this hopper loads onto its client targets: the client files of the install it runs from (issue #70).
  const keepClient = createClientReleaseKeeper({ release: readRelease(join(APP_DIR, 'src', 'client')), logger });
  const routerMode = () => store.settings.getRouterMode() ?? config.routerMode;
  let executorNames = (): string[] => [];
  let jobsOnMachine = (_name: string): string[] => [];
  const host = createPluginHost({
    ...(config.pluginDir ? { pluginDir: config.pluginDir } : {}), installedDir: installedDirOf(dataDir),
    documents: store.documents, dataDir, clock, routerMode, logger,
    kit: createDetectionKit({ env, secret }),
    builtins: withSeams(seams),
    jobSourceContext: {
      knownKeys: (keys) => new Set(keys.filter((k) => store.jobs.getBySourceKey(k))),
      rerunnable: (keys) => new Set(keys.filter((k) => { const j = store.jobs.getBySourceKey(k); return j !== undefined && isRerunnable(j); })),
    },
    machineContext: { executors: () => executorNames() },
    intervalMs: seams.pluginsFileIntervalMs ?? PLUGINS_FILE_CHECK_MS,
    attached: { inUse: (name) => jobsOnMachine(name), sshAuth, ...(seams.resolveTarget ? { resolveTarget: seams.resolveTarget } : {}) },
  });
  // The plugin store (issue #75): its installs are kept in the database (issue #93) and unpacked into
  // the work dir, scratch, so they are restored before the host loads plugins; the host rescans after an edit.
  const pluginStore = createPluginStore({
    ...(config.pluginStore ? { repo: config.pluginStore } : {}), ...(config.pluginDir ? { pluginDir: config.pluginDir } : {}),
    workDir: dataDir, installs: store.settings, builtinIds: new Set(BUILTIN_PLUGINS.map((p) => p.id)), plugins: host, events: store.events, clock, logger,
  });
  await pluginStore.restore();
  await host.start();
  // The pinned host keys follow plugins.yaml: rewritten when it changes, each problem logged once.
  const pinProblems = new Set<string>();
  const pinned = (machines: AttachedMachine[]): AttachedMachine[] => {
    for (const p of pinHostKeys(dataDir, machines)) if (!pinProblems.has(p)) { pinProblems.add(p); logger.warn(`hopper: ${p}`); }
    return machines;
  };
  pinned(host.attachedMachines());
  const built = host.executors();
  const executors = createExecutorRegistry(
    [...built.flatMap((b): Executor[] => (b.executor ? [b.executor] : [])), ...(seams.executors ?? [])],
    unavailableExecutors(built),
  );
  executorNames = () => executors.names();
  const plugins: PluginsView = seams.router ? seamPlugins(seams.router, host) : host;
  const router = seams.router ?? host.router;
  // Seam doubles win over the host's live instances (looked up per question).
  const answerer = (): Answerer | undefined => (seams.answerer !== undefined ? (seams.answerer ?? undefined) : host.answerer());
  const assessor = (): Assessor => seams.assessor ?? host.assessor();
  const dispatcher = createWebhookDispatcher({ store, clock, secret, baseMs: config.webhookBaseMs });
  // The service calls the engine and the engine calls the service: the engine's handlers are
  // reached through closures that run only after `engine` exists (design.md "Construction
  // contract added").
  let port = config.port;
  const answerUrl = (id: string): string => `http://${config.lanNames[0] ?? '127.0.0.1'}:${port}/#question-${id}`;
  const questions = createQuestionService({
    store, clock, answerer, assessor, stageTimeoutMs: config.answerTimeoutMs, documents: store.documents,
    renotifyMs: config.humanRenotifyMs, humanTimeoutMs: config.humanTimeoutMs,
    answerUrl,
    onAnswered: (q: Question) => engine.onAnswered(q),
    onExpired: (q: Question) => engine.onExpired(q),
    onDismissed: (q: Question) => engine.onDismissed(q),
  });
  const engine: Engine = createEngine({
    store, clock, executors, router, questions, queueSorter: host.queueSorter,
    routing: { rules: () => host.routingRules(), machines: () => host.machineIds() },
    ...(seams.fakeUsage ? { fakeUsage: seams.fakeUsage } : {}),
    // Both follow plugins.yaml without a restart (issue #18).
    machines: combineMachineSources([
      host.machines(),
      createAttachedMachines({
        machines: () => pinned(host.attachedMachines()), clock, logger,
        probe: seams.machineProbe
          ?? ((m) => ('client' in m
            ? keepClient(clientTransport(m.name, m.client.tokenEnv), () => jobsOnMachine(m.name).length > 0)
            : ('docker' in m
              ? probeContainer({ container: m.docker, dockerHost: () => dockerHost(secret) })
              : probeHerdrOverSsh({ target: m.ssh, herdrBin: m.herdrBin, session: m.session, controlDir: join(dataDir, 'ssh'), auth: sshAuth })
            ).then((online) => ({ online })))),
      }),
    ]),
    usage: [...host.usageSources(), ...(seams.fakeUsage ? [seams.fakeUsage] : [])],
    policy: {
      softLimit: config.softLimit, hardLimit: config.hardLimit, routerCheapBoost: config.routerCheapBoost,
      laneIdleGraceMs: config.laneIdleGraceMs, resumeBoost: config.resumeBoost,
    },
    tickMs: config.tickMs,
    initialRouterMode: config.routerMode,
    maxQuestions: config.maxQuestions,
    keepPanes: config.keepPanes,
  });
  jobsOnMachine = (name) => engine.jobsOnMachine(name);
  const { running, fixed } = splitSources(host.jobSources());
  const stopFailureLog = logFailures(store);
  const sync = createSourceSync({
    sources: [...running.map((r) => r.source), ...(seams.sources ?? [])], host: engine.sourceHost, clock,
    pollMs: (name) => running.find((r) => r.source.name === name)?.pollMs ?? SEAM_SOURCE_POLL_MS,
  });
  const registry: SourceRegistry = withFixedStatuses(sync, fixed);
  const signIn = createSignIn({ config: auth, clock, origin: () => config.publicUrl ?? `http://localhost:${port}` });
  // Self-update (issue #44): the restart reaches app.stop() through `restartApp`, set below.
  let restartApp: Restarter = async () => {};
  const appDir = seams.update?.appDir ?? APP_DIR;
  const updater = createUpdater({
    appDir, dataDir, store, clock, logger,
    builder: seams.update?.builder ?? createInstallScriptBuilder({ logFile: join(dataDir, 'update', 'build.log') }),
    restart: seams.update?.restart ?? (() => restartApp()),
    restartBlockers: () => restartBlockers(store.jobs.list({ status: ['running'] }), (name) => executors.get(name)),
    checkMs: config.updateCheckMs,
  });
  const server = createServer({
    engine, store, dispatcher, questions, clock, version: VERSION, sources: registry, webhookConfig, plugins, pluginStore, updater,
    webhooksEditor: createWebhooksEditor({ documents: store.documents, reload: webhookConfig.reload }),
    port: () => port, sessionHours: config.uiSessionHours, signIn,
    lan: { names: config.lanNames, peers: config.lanPeers, publicUrl: config.publicUrl }, uiDir: seams.uiDir ?? UI_DIR,
  });

  dispatcher.start();
  host.startNotifiers({ subscribe: (l) => store.events.subscribe(l), job: (id) => store.jobs.get(id) });
  // Before listening: the boot after an update records update.applied before anything is answered.
  updater.start();
  pluginStore.start();
  await server.listen({ host: config.host, port: config.port });
  port = (server.server.address() as { port: number }).port;
  await engine.start();
  sync.start();

  let stopped: Promise<void> | undefined;
  const app: App = {
    url: `http://127.0.0.1:${port}`,
    config,
    auth,
    answerUrl,
    routerMode,
    plugins,
    store,
    engine,
    sources: sync,
    updater,
    stop() {
      stopped ??= (async () => {
        updater.stop();
        await server.close();
        await sync.stop();
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
