// Composition root: config → adapters → store → engine → server. The only place adapters
// are constructed (besides integration tests, which call startApp).
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Clock, JevAdvisor } from './domain/ports.ts';
import { loadConfig, type Config } from './config.ts';
import { createEngine } from './engine/index.ts';
import { createExecutorRegistry, createTestExecutor } from './executors/index.ts';
import { createServer } from './http/index.ts';
import { createFakeAdvisor, createRouterAdvisor } from './jev/index.ts';
import { createLocalMachineSource } from './machines/index.ts';
import { openStore } from './store/index.ts';
import { createFakeUsageSource } from './usage/index.ts';
import { createWebhookDispatcher } from './webhooks/index.ts';

export interface App {
  url: string;
  config: Config;
  advisor: string;
  jevMode(): string;
  /** Close the server, stop the engine (≤ 5 s) and the dispatcher, close the store. */
  stop(): Promise<void>;
}

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export async function startApp(config: Config): Promise<App> {
  const clock: Clock = { now: () => new Date() };
  const store = openStore({ path: config.dbPath, clock });
  const executors = createExecutorRegistry([createTestExecutor()]);
  const fakeUsage = createFakeUsageSource(clock);
  const jevMode = () => store.settings.getJevMode() ?? config.jevMode;
  const advisor: JevAdvisor = config.jevAdvisor === 'fake'
    ? createFakeAdvisor({ clock })
    : createRouterAdvisor({ jevSrc: config.jevSrc, python: config.python, dataDir: dirname(config.dbPath), mode: jevMode, clock });
  const dispatcher = createWebhookDispatcher({ store, clock, baseMs: config.webhookBaseMs });
  const engine = createEngine({
    store, clock, executors, advisor, fakeUsage,
    machines: createLocalMachineSource({ maxLanes: config.localLanes, executors: executors.names() }),
    usage: [fakeUsage],
    policy: {
      softLimit: config.softLimit, hardLimit: config.hardLimit,
      jevCheapBoost: config.jevCheapBoost, laneIdleGraceMs: config.laneIdleGraceMs, resumeBoost: 20,
    },
    tickMs: config.tickMs,
    initialJevMode: config.jevMode,
  });
  const server = createServer({ engine, store, dispatcher, clock, version: VERSION });

  dispatcher.start();
  engine.start();
  await server.listen({ host: config.host, port: config.port });
  const { port } = server.server.address() as { port: number };

  let stopped: Promise<void> | undefined;
  return {
    url: `http://${config.host}:${port}`,
    config,
    advisor: advisor.name,
    jevMode,
    stop() {
      stopped ??= (async () => {
        await server.close();
        await engine.stop();
        await dispatcher.stop();
        store.close();
      })();
      return stopped;
    },
  };
}

async function main(): Promise<void> {
  const app = await startApp(loadConfig(process.env));
  console.log(`job-hopper listening on ${app.url} (jev ${app.jevMode()}, advisor ${app.advisor})`);
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
