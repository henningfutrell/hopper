// Composition root: config → store → plugins.yaml (written on the first boot without one) → plugin
// host (every part) → engine → server. Adapters are built by their plugins, here through the
// host (integration tests call startApp, with doubles at the seams).
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Answerer, Assessor, Clock, Executor, JobSource, PluginsView, Restarter, Router, SettableUsageSource, SourceRegistry, Store, UpdateBuilder, Updater } from './domain/ports.ts';
import type { AttachedMachine, Question, SourceStatus } from './domain/types.ts';
import { isRerunnable } from './domain/types.ts';
import { loadConfig, type Config } from './config.ts';
import { createEngine, type Engine } from './engine/index.ts';
import { createExecutorRegistry } from './executors/index.ts';
import type { HerdrClient } from './executors/herdr/index.ts';
import { createServer } from './http/index.ts';
import { AUTH, createSignIn, loadAuthDocument, type AuthConfig } from './auth/index.ts';
import { combineMachineSources, createAttachedMachines, probeHerdrOverSsh } from './machines/index.ts';
import { BUILTIN_PLUGINS } from './plugins/builtin.ts';
import { herdrClaudePlugin } from './plugins/executor/herdr-claude/index.ts';
import { createPluginHost, type BuiltJobSource } from './plugins/index.ts';
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
import { createSecretBox } from './secrets/box.ts';
import { openStore } from './store/index.ts';
import { createInstallScriptBuilder, createRestarter, createUpdater, restartBlockers } from './update/index.ts';
import { createWebhookConfigWatcher, type WebhookConfigWatcher } from './webhooks/config.ts';
import { createWebhooksEditor } from './webhooks/edit.ts';
import { createWebhookDispatcher } from './webhooks/index.ts';

export interface App {
  /** Always the loopback URL, whatever the bind address. */
  url: string;
  config: Config;
  /** auth.yaml as loaded at start. */
  auth: AuthConfig;
  /** The UI link to one question, as notifications carry it: the first LAN name, else loopback. */
  answerUrl(questionId: string): string;
  routerMode(): string;
  /** For tests: the store, the engine (setFakeUsage), the sync loop (syncNow), the webhooks.yaml watcher. */
  plugins: PluginsView;
  store: Store;
  engine: Engine;
  sources: SourceSync;
  webhookConfig: WebhookConfigWatcher;
  updater: Updater;
  /** Close the server; stop the sync loop, question service, engine (≤ 5 s), dispatcher, watcher; close the store. */
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
  /** How often webhooks.yaml's version is checked; default WEBHOOKS_FILE_CHECK_MS. */
  webhookConfigIntervalMs?: number;
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
  /** Replaces the ssh probe of every attached machine: true = its herdr session is running. */
  machineProbe?: (machine: AttachedMachine) => Promise<boolean>;
  /** Replaces resolving herdr's path over ssh when the UI adds a machine (issue #18): the path, or a rejection with the reason. */
  resolveHerdrBin?: (ssh: string) => Promise<string>;
  /** The built UI bundle; default UI_DIR. */
  uiDir?: string;
  /** Self-update: the install dir (default APP_DIR), the build (default install.sh build-only mode), the restart (default exit or respawn). */
  update?: { appDir?: string; builder?: UpdateBuilder; restart?: Restarter };
}

const WEBHOOKS_FILE_CHECK_MS = 5000;
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

/** JOB_HOPPER_* variables that are set but read by nothing: one loud line. */
function warnLeftoverEnv(config: Config): void {
  const names = Object.keys(config.leftoverEnv).sort();
  if (names.length === 0) return;
  console.warn(`job-hopper: WARNING: set but no longer read (plugins.yaml configures every part; remove them from the unit): ${names.join(', ')}`);
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
  // Before the store: a key that cannot seal stops the daemon before it touches anything.
  const box = createSecretBox(config.secretKey);
  const store = openStore({ url: config.databaseUrl, clock });
  // plugins.yaml is the one truth: the built-in instances are written on the boot that finds none.
  ensurePluginsDocument({ documents: store.documents, answerTimeoutMs: config.answerTimeoutMs, logger });
  const env = seams.env ?? process.env;
  // Before anything starts: an invalid auth.yaml stops the daemon (sign-in fails closed).
  let auth: AuthConfig;
  try {
    auth = loadAuthDocument(store.documents.read(AUTH), (name) => env[name]);
  } catch (e) {
    store.close();
    throw e;
  }
  const dataDir = config.workDir;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const routerMode = () => store.settings.getRouterMode() ?? config.routerMode;
  let executorNames = (): string[] => [];
  let jobsOnMachine = (_name: string): string[] => [];
  const host = createPluginHost({
    ...(config.pluginDir ? { pluginDir: config.pluginDir } : {}), documents: store.documents, dataDir, clock, routerMode, logger,
    kit: createDetectionKit({ env }),
    builtins: withSeams(seams),
    jobSourceContext: {
      knownKeys: (keys) => new Set(keys.filter((k) => store.jobs.getBySourceKey(k))),
      rerunnable: (keys) => new Set(keys.filter((k) => { const j = store.jobs.getBySourceKey(k); return j !== undefined && isRerunnable(j); })),
    },
    machineContext: { executors: () => executorNames() },
    intervalMs: seams.pluginsFileIntervalMs ?? PLUGINS_FILE_CHECK_MS,
    attached: { inUse: (name) => jobsOnMachine(name), ...(seams.resolveHerdrBin ? { resolveHerdrBin: seams.resolveHerdrBin } : {}) },
  });
  await host.start();
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
  const dispatcher = createWebhookDispatcher({ store, clock, box, baseMs: config.webhookBaseMs });
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
        machines: () => host.attachedMachines(), clock, logger,
        probe: seams.machineProbe
          ?? ((m) => probeHerdrOverSsh({ target: m.ssh, herdrBin: m.herdrBin, session: m.session, controlDir: join(dataDir, 'ssh') })),
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
  const webhookConfig = createWebhookConfigWatcher({
    documents: store.documents, store, clock, box, intervalMs: seams.webhookConfigIntervalMs ?? WEBHOOKS_FILE_CHECK_MS, env: (name) => env[name],
  });
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
    engine, store, dispatcher, questions, clock, version: VERSION, sources: registry, webhookConfig, plugins, updater,
    webhooksEditor: createWebhooksEditor({ documents: store.documents, box, reload: webhookConfig.reload }),
    port: () => port, sessionHours: config.uiSessionHours, signIn,
    lan: { names: config.lanNames, peers: config.lanPeers, publicUrl: config.publicUrl }, uiDir: seams.uiDir ?? UI_DIR,
  });

  webhookConfig.start();
  dispatcher.start();
  host.startNotifiers({ subscribe: (l) => store.events.subscribe(l), job: (id) => store.jobs.get(id) });
  // Before listening: the boot after an update records update.applied before anything is answered.
  updater.start();
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
    webhookConfig,
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
        webhookConfig.stop();
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

function unavailableNote(plugins: PluginsView): string {
  const down = plugins.report().executors.instances.filter((i) => i.active === null).map((i) => i.instance.name);
  return down.length ? ` (unavailable, jobs held: ${down.join(',')})` : '';
}

async function main(): Promise<void> {
  const app = await startApp(loadConfig(process.env));
  const r = app.plugins.routerStatus();
  const { answerer, assessor } = app.plugins.report();
  const q = `answerer ${answerer.instance ? `${answerer.instance.name} [${answerer.active ?? 'unavailable'}]` : 'none'}, assessor ${assessor.instance?.name} [${assessor.active}${assessor.fallback ? ', fallback' : ''}]`;
  const lan = app.config.lanNames.length ? ` and ${app.config.lanNames.map((n) => `http://${n}:${new URL(app.url).port}`).join(', ')} (LAN peers ${app.config.lanPeers.join(', ')})` : '';
  console.log(`job-hopper listening on ${app.url}${lan} (router ${r.name} [${r.plugin}${r.fallback ? ', fallback' : ''}] ${app.routerMode()}, executors ${app.engine.executorNames.join(',') || 'none'}${unavailableNote(app.plugins)}, ${q})`);
  for (const s of app.sources.statuses()) console.log(`job-hopper: source ${s.name} (${s.kind}) ${s.state}`);
  const { auth } = app;
  if (app.config.publicUrl) console.log(`job-hopper: public URL ${app.config.publicUrl} (sign-in origin)`);
  if (auth.providers.length) console.log(`job-hopper: sign-in with ${auth.providers.map((p) => `${p.name} (${p.type})`).join(', ')}`);
  if (auth.local.enabled) console.log('job-hopper: local sign-in on; a login code: job-hopper login-code');
  else console.log('job-hopper: local sign-in is off (auth.yaml)');
  const shutdown = (signal: string): void => {
    console.log(`job-hopper: ${signal}, shutting down`);
    app.stop().then(() => process.exit(0), (e) => {
      console.error('shutdown failed', e);
      process.exit(1);
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
