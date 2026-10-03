// Composition root: config → adapters → store → engine → server. The only place adapters
// are constructed (besides integration tests, which call startApp).
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AnswerRequest, AnswerVerdict, Answerer, Clock, Executor, JevAdvisor, JobSource, SourceRegistry, Store } from './domain/ports.ts';
import type { Question, SourceStatus } from './domain/types.ts';
import { loadConfig, type Config } from './config.ts';
import { createEngine, type Engine } from './engine/index.ts';
import { createExecutorRegistry, createTestExecutor } from './executors/index.ts';
import { createHerdrClaudeExecutor, createHerdrCliClient, type HerdrClient } from './executors/herdr/index.ts';
import { createServer } from './http/index.ts';
import { createFakeAdvisor, createRouterAdvisor } from './jev/index.ts';
import { createLocalMachineSource } from './machines/index.ts';
import { createClaudeCliAnswerer, createFakeAnswerer, createQuestionService } from './questions/index.ts';
import {
  createGhCliApi, createGitHubSource, createSourceSync, idleStatus, loadSourcesFile, withFixedStatuses,
  type GitHubApi, type SourceSync,
} from './sources/index.ts';
import { openStore } from './store/index.ts';
import { createFakeUsageSource } from './usage/index.ts';
import { createWebhookConfigWatcher, type WebhookConfigWatcher } from './webhooks/config.ts';
import { createWebhookDispatcher } from './webhooks/index.ts';

export interface App {
  url: string;
  config: Config;
  advisor: string;
  jevMode(): string;
  /** For tests: the store, the engine (setFakeUsage), the sync loop (syncNow), the webhooks.yaml watcher. */
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
  /** Replaces the `gh` CLI adapter of the GitHub source. */
  github?: GitHubApi;
  /** Run after the configured sources, polled every SEAM_SOURCE_POLL_MS. */
  sources?: JobSource[];
  /** How often webhooks.yaml's mtime is checked; default WEBHOOKS_FILE_CHECK_MS. */
  webhookConfigIntervalMs?: number;
}

const WEBHOOKS_FILE_CHECK_MS = 5000;
const SEAM_SOURCE_POLL_MS = 1000;

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * `JOB_HOPPER_ANSWERER=fake`: deterministic tiers for tests and demos, no model is called.
 * Answer `fake <tier> answer`. Opus is confident unless the question says "hard" or "unsure";
 * fable unless it says "unsure". Both mark a question risky when it says "risky". The risk
 * rules apply on top, as for real tiers (a question about deleting reaches the human).
 */
function fakeVerdict(tier: Answerer['tier'], req: AnswerRequest): AnswerVerdict {
  const text = req.question.text;
  const unsure = tier === 'opus' ? /\b(hard|unsure)\b/i : /\bunsure\b/i;
  const confident = !unsure.test(text);
  const risky = /\brisky\b/i.test(text);
  return { answer: `fake ${tier} answer`, confident, risky, reason: `fake ${tier}: confident=${confident} risky=${risky}` };
}

function answerersFor(config: Config, cwd: string): Answerer[] {
  const tiers = [['opus', config.answerModelA], ['fable', config.answerModelB]] as const;
  return tiers.map(([tier, model]) => (config.answerer === 'fake'
    ? createFakeAnswerer({ tier, script: (req) => fakeVerdict(tier, req) })
    : createClaudeCliAnswerer({ tier, model, bin: config.claudeBin, cwd, timeoutMs: config.answerTimeoutMs })));
}

function executorsFor(config: Config, clock: Clock, seams: AppSeams): Executor[] {
  const built = config.executors.map((name): Executor => (name === 'test' ? createTestExecutor() : createHerdrClaudeExecutor({
    herdr: seams.herdr ?? createHerdrCliClient({ bin: config.herdrBin, session: config.herdrSession }),
    clock, defaultCwd: config.claudeCwd, claudeArgs: config.claudeArgs, trustWorkdir: config.trustWorkdir,
    pollMs: config.herdrPollMs, idleQuestionMs: config.idleQuestionMs,
  })));
  return [...built, ...(seams.executors ?? [])];
}

interface ComposedSources { sources: JobSource[]; fixed: SourceStatus[]; pollMs: Map<string, number>; throttleMs: Map<string, number> }

/** sources.yaml → the sources that run, plus fixed statuses for the ones that do not. */
function sourcesFor(config: Config, clock: Clock, store: Store, seams: AppSeams): ComposedSources {
  const out: ComposedSources = { sources: [], fixed: [], pollMs: new Map(), throttleMs: new Map() };
  const file = loadSourcesFile(config.sourcesFile);
  if ('error' in file) {
    console.error(`job-hopper: ${file.error} — no source runs from it`);
    out.fixed.push(idleStatus('github', 'github', 'error', { error: file.error, detail: { path: config.sourcesFile } }));
  } else if (!file.github?.enabled) {
    out.fixed.push(idleStatus('github', 'github', 'disabled', { detail: { path: config.sourcesFile, ...(file.note ? { note: file.note } : {}) } }));
  } else {
    const gh = file.github;
    out.sources.push(createGitHubSource({
      name: 'github', config: gh, clock,
      api: seams.github ?? createGhCliApi({ bin: config.ghBin }),
      knownKeys: (keys) => new Set(keys.filter((k) => store.jobs.getBySourceKey(k))),
    }));
    out.pollMs.set('github', gh.pollSeconds * 1000);
    out.throttleMs.set('github', gh.progressCommentSeconds * 1000);
  }
  out.sources.push(...(seams.sources ?? []));
  return out;
}

export async function startApp(config: Config, seams: AppSeams = {}): Promise<App> {
  const clock: Clock = { now: () => new Date() };
  const store = openStore({ path: config.dbPath, clock });
  const dataDir = dirname(config.dbPath);
  const executors = createExecutorRegistry(executorsFor(config, clock, seams));
  const fakeUsage = createFakeUsageSource(clock);
  const jevMode = () => store.settings.getJevMode() ?? config.jevMode;
  const advisor: JevAdvisor = config.jevAdvisor === 'fake'
    ? createFakeAdvisor({ clock })
    : createRouterAdvisor({ jevSrc: config.jevSrc, python: config.python, dataDir, mode: jevMode, clock });
  const dispatcher = createWebhookDispatcher({ store, clock, baseMs: config.webhookBaseMs });
  // The service calls the engine and the engine calls the service: the engine's handlers are
  // reached through closures that run only after `engine` exists (design.md "Construction
  // contract added").
  let port = config.port;
  const questions = createQuestionService({
    store, clock, answerers: answerersFor(config, dataDir), rulesFile: config.rulesFile,
    renotifyMs: config.humanRenotifyMs, humanTimeoutMs: config.humanTimeoutMs,
    answerUrl: (id) => `http://${config.host}:${port}/#question-${id}`,
    onAnswered: (q: Question) => engine.onAnswered(q),
    onExpired: (q: Question) => engine.onExpired(q),
  });
  const engine: Engine = createEngine({
    store, clock, executors, advisor, fakeUsage, questions,
    machines: createLocalMachineSource({ maxLanes: config.localLanes, executors: executors.names() }),
    usage: [fakeUsage],
    policy: {
      softLimit: config.softLimit, hardLimit: config.hardLimit, jevCheapBoost: config.jevCheapBoost,
      laneIdleGraceMs: config.laneIdleGraceMs, resumeBoost: config.resumeBoost,
    },
    tickMs: config.tickMs,
    initialJevMode: config.jevMode,
    maxQuestions: config.maxQuestions,
    keepPanes: config.keepPanes,
  });
  const composed = sourcesFor(config, clock, store, seams);
  const sync = createSourceSync({
    sources: composed.sources, host: engine.sourceHost, clock,
    pollMs: (name) => composed.pollMs.get(name) ?? SEAM_SOURCE_POLL_MS,
    progressThrottleMs: (name) => composed.throttleMs.get(name) ?? 0,
  });
  const registry: SourceRegistry = withFixedStatuses(sync, composed.fixed);
  const webhookConfig = createWebhookConfigWatcher({
    path: config.webhooksFile, store, clock, intervalMs: seams.webhookConfigIntervalMs ?? WEBHOOKS_FILE_CHECK_MS,
  });
  const server = createServer({
    engine, store, dispatcher, questions, clock, version: VERSION, sources: registry, webhookConfig,
    port: () => port, dataDir, sessionHours: config.uiSessionHours,
  });

  webhookConfig.start();
  dispatcher.start();
  await server.listen({ host: config.host, port: config.port });
  port = (server.server.address() as { port: number }).port;
  engine.start();
  sync.start();

  let stopped: Promise<void> | undefined;
  return {
    url: `http://${config.host}:${port}`,
    config,
    advisor: advisor.name,
    jevMode,
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
        webhookConfig.stop();
        store.close();
      })();
      return stopped;
    },
  };
}

async function main(): Promise<void> {
  const app = await startApp(loadConfig(process.env));
  console.log(`job-hopper listening on ${app.url} (jev ${app.jevMode()}, advisor ${app.advisor}, executors ${app.config.executors.join(',')}, answerer ${app.config.answerer})`);
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
