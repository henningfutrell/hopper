// Composition root: config → adapters → store → engine → server. The only place adapters
// are constructed (besides integration tests, which call startApp).
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Answerer, Assessor, Clock, Executor, JobSource, PluginsView, Router, SourceRegistry, Store } from './domain/ports.ts';
import type { InstanceSpec, Question } from './domain/types.ts';
import { isRerunnable } from './domain/types.ts';
import { loadConfig, type Config } from './config.ts';
import { createEngine, type Engine } from './engine/index.ts';
import { createExecutorRegistry, createTestExecutor } from './executors/index.ts';
import { createHerdrClaudeExecutor, createHerdrCliClient, type HerdrClient } from './executors/herdr/index.ts';
import { createGrokBotNotifier } from './grokbot/index.ts';
import { createServer } from './http/index.ts';
import { createLocalMachineSource } from './machines/index.ts';
import { createPluginHost } from './plugins/index.ts';
import { createFakeAnswerer, createFakeAssessor, createQuestionService } from './questions/index.ts';
import { logFailures } from './engine/failure-log.ts';
import { createSourceSync, withFixedStatuses, type GitHubApi, type SourceSync } from './sources/index.ts';
import { composeSources } from './sources/compose.ts';
import { openStore } from './store/index.ts';
import { createFakeUsageSource } from './usage/index.ts';
import { createWebhookConfigWatcher, type WebhookConfigWatcher } from './webhooks/config.ts';
import { createWebhookDispatcher } from './webhooks/index.ts';

export interface App {
  url: string;
  config: Config;
  routerMode(): string;
  /** For tests: the store, the engine (setFakeUsage), the sync loop (syncNow), the webhooks.yaml watcher. */
  plugins: PluginsView;
  store: Store;
  engine: Engine;
  sources: SourceSync;
  webhookConfig: WebhookConfigWatcher;
  /** Close the server; stop the sync loop, question service, engine (≤ 5 s), dispatcher, watcher; close the store. */
  stop(): Promise<void>;
}

/** Doubles at ports.ts seams, for integration tests. Production passes none. */
export interface AppSeams {
  /** Replaces the herdr CLI client of the herdr-claude executor. */
  herdr?: HerdrClient;
  /** Registered after the configured executors. */
  executors?: Executor[];
  /** Replaces the `gh` CLI adapter of the `github` source. */
  github?: GitHubApi;
  /** Replaces the GitHub App adapter of the `github-app` source (its paused() still follows the app file). */
  githubApp?: GitHubApi;
  /** Run after the configured sources, polled every SEAM_SOURCE_POLL_MS. */
  sources?: JobSource[];
  /** How often webhooks.yaml's mtime is checked; default WEBHOOKS_FILE_CHECK_MS. */
  webhookConfigIntervalMs?: number;
  /** First retry delay of the Grok Bot routine webhook; default 1000. */
  grokbotBaseMs?: number;
  /** Replaces the configured router (the plugin host still loads, for /api/plugins). */
  router?: Router;
  /** Replaces the configured answerer; null = no answerer. The report stays the host's. */
  answerer?: Answerer | null;
  /** Replaces the configured assessor. The report stays the host's. */
  assessor?: Assessor;
  /** How often plugins.yaml's mtime is checked; default PLUGINS_FILE_CHECK_MS. */
  pluginsFileIntervalMs?: number;
}

const WEBHOOKS_FILE_CHECK_MS = 5000;
const PLUGINS_FILE_CHECK_MS = 5000;
const SEAM_SOURCE_POLL_MS = 1000;

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * `JOB_HOPPER_ANSWERER=fake`: doubles at the Answerer and Assessor seams for tests and demos; no
 * model is called and nothing in plugins.yaml selects them. The answerer `opus` drafts
 * `fake opus answer`, confident unless the question says "unsure". The assessor `fable` escalates
 * when the question says "risky" or "hard". The risk rules apply on top, as for real plugins (a
 * question about deleting reaches the human).
 */
function fakeQuestionRoles(): { answerer: Answerer; assessor: Assessor } {
  return {
    answerer: createFakeAnswerer({
      name: 'opus',
      script: (req) => {
        const confident = !/\bunsure\b/i.test(req.question.text);
        return { answer: 'fake opus answer', confident, reason: `fake opus: confident=${confident}` };
      },
    }),
    assessor: createFakeAssessor({
      name: 'fable',
      script: (req) => {
        const escalate = /\b(risky|hard)\b/i.test(req.question.text);
        return { escalate, reason: `fake fable: escalate=${escalate}` };
      },
    }),
  };
}

/** The question instances plugins.yaml falls back to: what the env described before plugins existed. */
function questionDefaults(config: Config): { answerer: InstanceSpec; assessor: InstanceSpec } {
  const common = { bin: config.claudeBin, timeoutMs: config.answerTimeoutMs };
  return {
    answerer: { name: 'opus', plugin: 'claude-cli', options: { ...common, model: config.answerModelA } },
    assessor: { name: 'fable', plugin: 'claude-cli-assessor', options: { ...common, model: config.answerModelB } },
  };
}

function executorsFor(config: Config, clock: Clock, seams: AppSeams): Executor[] {
  const built = config.executors.map((name): Executor => (name === 'test' ? createTestExecutor() : createHerdrClaudeExecutor({
    herdr: seams.herdr ?? createHerdrCliClient({ bin: config.herdrBin, session: config.herdrSession }),
    clock, defaultCwd: config.claudeCwd, claudeArgs: config.claudeArgs, trustWorkdir: config.trustWorkdir,
    pollMs: config.herdrPollMs, idleQuestionMs: config.idleQuestionMs,
  })));
  return [...built, ...(seams.executors ?? [])];
}

/** A seam router (tests) answers as itself; the report stays the host's. */
function seamPlugins(router: Router, report: PluginsView['report']): PluginsView {
  return { routerStatus: () => ({ name: router.name, plugin: router.name, fallback: false }), report };
}

export async function startApp(config: Config, seams: AppSeams = {}): Promise<App> {
  const clock: Clock = { now: () => new Date() };
  const store = openStore({ path: config.dbPath, clock });
  const dataDir = dirname(config.dbPath);
  const executors = createExecutorRegistry(executorsFor(config, clock, seams));
  const fakeUsage = createFakeUsageSource(clock);
  const routerMode = () => store.settings.getRouterMode() ?? config.routerMode;
  const host = createPluginHost({
    pluginDir: config.pluginDir, pluginsFile: config.pluginsFile, dataDir, clock, routerMode,
    logger: { info: (l) => console.log(l), warn: (l) => console.warn(l) },
    // Without a router in plugins.yaml: the jev-router the env described before plugins existed.
    defaultRouter: { name: 'jev', plugin: 'jev-router', options: { jevSrc: config.jevSrc, python: config.python } },
    defaultAnswerer: questionDefaults(config).answerer,
    defaultAssessor: questionDefaults(config).assessor,
    intervalMs: seams.pluginsFileIntervalMs ?? PLUGINS_FILE_CHECK_MS,
  });
  await host.start();
  const plugins: PluginsView = seams.router ? seamPlugins(seams.router, host.report) : host;
  const router = seams.router ?? host.router;
  // Seam doubles win, then the env's fake doubles, then the host's live instances (looked up per question).
  const fake = config.answerer === 'fake' ? fakeQuestionRoles() : undefined;
  const answerer = (): Answerer | undefined =>
    (seams.answerer !== undefined ? (seams.answerer ?? undefined) : (fake?.answerer ?? host.answerer()));
  const assessor = (): Assessor => seams.assessor ?? fake?.assessor ?? host.assessor();
  const dispatcher = createWebhookDispatcher({ store, clock, baseMs: config.webhookBaseMs });
  const grokbot = createGrokBotNotifier({ store, path: config.grokbotWebhookFile, info: (l) => console.log(l), ...(seams.grokbotBaseMs ? { baseMs: seams.grokbotBaseMs } : {}) });
  // The service calls the engine and the engine calls the service: the engine's handlers are
  // reached through closures that run only after `engine` exists (design.md "Construction
  // contract added").
  let port = config.port;
  const questions = createQuestionService({
    store, clock, answerer, assessor, stageTimeoutMs: config.answerTimeoutMs, rulesFile: config.rulesFile,
    renotifyMs: config.humanRenotifyMs, humanTimeoutMs: config.humanTimeoutMs,
    answerUrl: (id) => `http://${config.host}:${port}/#question-${id}`,
    onAnswered: (q: Question) => engine.onAnswered(q),
    onExpired: (q: Question) => engine.onExpired(q),
  });
  const engine: Engine = createEngine({
    store, clock, executors, router, fakeUsage, questions,
    machines: createLocalMachineSource({ maxLanes: config.localLanes, executors: executors.names() }),
    usage: [fakeUsage],
    policy: {
      softLimit: config.softLimit, hardLimit: config.hardLimit, routerCheapBoost: config.routerCheapBoost,
      laneIdleGraceMs: config.laneIdleGraceMs, resumeBoost: config.resumeBoost,
    },
    tickMs: config.tickMs,
    initialRouterMode: config.routerMode,
    maxQuestions: config.maxQuestions,
    keepPanes: config.keepPanes,
  });
  const composed = composeSources({
    sourcesFile: config.sourcesFile, ghBin: config.ghBin, clock,
    ...(config.githubApiUrl ? { githubApiUrl: config.githubApiUrl } : {}),
    knownKeys: (keys) => new Set(keys.filter((k) => store.jobs.getBySourceKey(k))),
    rerunnable: (keys) => new Set(keys.filter((k) => { const j = store.jobs.getBySourceKey(k); return j !== undefined && isRerunnable(j); })),
    ...(seams.github ? { github: seams.github } : {}),
    ...(seams.githubApp ? { githubApp: seams.githubApp } : {}),
  });
  composed.sources.push(...(seams.sources ?? []));
  const stopFailureLog = logFailures(store);
  const sync = createSourceSync({
    sources: composed.sources, host: engine.sourceHost, clock,
    pollMs: (name) => composed.pollMs.get(name) ?? SEAM_SOURCE_POLL_MS,
  });
  const registry: SourceRegistry = withFixedStatuses(sync, composed.fixed);
  const webhookConfig = createWebhookConfigWatcher({
    path: config.webhooksFile, store, clock, intervalMs: seams.webhookConfigIntervalMs ?? WEBHOOKS_FILE_CHECK_MS,
  });
  const server = createServer({
    engine, store, dispatcher, questions, clock, version: VERSION, sources: registry, webhookConfig, plugins,
    port: () => port, dataDir, sessionHours: config.uiSessionHours,
  });

  webhookConfig.start();
  dispatcher.start();
  grokbot.start();
  await server.listen({ host: config.host, port: config.port });
  port = (server.server.address() as { port: number }).port;
  await engine.start();
  sync.start();

  let stopped: Promise<void> | undefined;
  return {
    url: `http://${config.host}:${port}`,
    config,
    routerMode,
    plugins,
    store,
    engine,
    sources: sync,
    webhookConfig,
    stop() {
      stopped ??= (async () => {
        await server.close();
        await sync.stop();
        await questions.stop();
        await engine.stop();
        await dispatcher.stop();
        await grokbot.stop();
        webhookConfig.stop();
        stopFailureLog();
        host.stop();
        store.close();
      })();
      return stopped;
    },
  };
}

async function main(): Promise<void> {
  const app = await startApp(loadConfig(process.env));
  const r = app.plugins.routerStatus();
  const { answerer, assessor } = app.plugins.report();
  const q = `answerer ${answerer.instance ? `${answerer.instance.name} [${answerer.active ?? 'unavailable'}]` : 'none'}, assessor ${assessor.instance?.name} [${assessor.active}${assessor.fallback ? ', fallback' : ''}]`;
  console.log(`job-hopper listening on ${app.url} (router ${r.name} [${r.plugin}${r.fallback ? ', fallback' : ''}] ${app.routerMode()}, executors ${app.config.executors.join(',')}, ${q}${app.config.answerer === 'fake' ? ' (fake doubles answer)' : ''})`);
  for (const s of app.sources.statuses()) console.log(`job-hopper: source ${s.name} (${s.kind}) ${s.state}`);
  console.log('job-hopper: UI login code written; open the UI with: bash ~/.local/lib/job-hopper/scripts/open-ui.sh');
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
