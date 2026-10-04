// Starts the real composition root (src/main.ts) on port 0 against a temp SQLite file, with the
// fake router at the Router seam (unless `realRouter`: then the plugin host's router runs), the
// fake usage source and the fake question doubles (fake-questions.ts) at their seams, a fast tick,
// and a temp plugins.yaml (executor `test`, no job or usage sources) and webhooks file (never the user's
// ~/.config). `plugins` sections are written over TEST_PLUGINS on every start; without them a
// plugins.yaml already in the data dir is kept; `plugins: false` writes none, so the daemon
// migrates or writes its defaults. Jobs are PULLED: a
// manual JobSource (manual-source.ts) offers items, run by the "scripted" executor
// (scripted-executor.ts). Every event the app emits is validated against its schema; stop()
// fails the test on any nonconforming event (tracker + a scan of the whole event log).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig } from '../../src/config.ts';
import { startApp, type App, type AppSeams } from '../../src/main.ts';
import type { SourceItem } from '../../src/domain/ports.ts';
import type { DomainEvent, Job, Question } from '../../src/domain/types.ts';
import { validateEvent } from '../../src/events/index.ts';
import { assertAllConform, trackConformance } from './conformance.ts';
import { rawRequest } from './http.ts';
import { createFakeUsageSource } from '../../src/usage/index.ts';
import { fakeQuestionRoles } from './fake-questions.ts';
import { createFakeRouter } from './fake-router.ts';
import { createManualSource, manualItem, type ManualSource } from './manual-source.ts';
import { createScriptedExecutor, type ScriptedExecutor } from './scripted-executor.ts';
import { waitFor } from './wait.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
export interface ApiResponse<T = any> { status: number; body: T }

export interface UiOptions {
  token?: string;
  /** Header overrides; `null` drops a default header. */
  headers?: Record<string, string | null>;
  rawBody?: string;
}

export interface TestApp {
  app: App;
  url: string;
  dbPath: string;
  dataDir: string;
  source: ManualSource;
  scripted: ScriptedExecutor;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
  api<T = any>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>>;
  /** Offer one item through the manual source, sync, and return its job. `script` is the scripted executor's op. */
  pull(script: Record<string, unknown>, item?: Partial<SourceItem>): Promise<Job>;
  /** One sync of every source. */
  sync(): Promise<void>;
  job(id: string): Promise<Job>;
  waitForStatus(id: string, status: string, timeoutMs?: number): Promise<Job>;
  events(query?: string): Promise<DomainEvent[]>;
  questionsOf(jobId: string): Promise<Question[]>;
  waitForQuestion(jobId: string, ok: (q: Question) => boolean, timeoutMs?: number): Promise<Question>;
  /** Set the fake usage reading (through the engine; there is no HTTP route). */
  setUsage(used: number, limit?: number): void;
  /** Log in like open-ui.sh does: read the code file, POST /ui/login. Returns the session token. */
  login(): Promise<string>;
  /** POST a UI mutation with a valid Origin, JSON content type and (if given) the session header. */
  ui<T = unknown>(path: string, body?: unknown, o?: UiOptions): Promise<ApiResponse<T>>;
  stop(): Promise<void>;
}

export function tempDbPath(): { dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'job-hopper-it-'));
  return { dbPath: join(dir, 'db.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** plugins.yaml `machines:` with this many lanes on the local machine. */
export const lanes = (n: number) => ({ name: 'local', plugin: 'local', options: { lanes: n } });

/** The plugins.yaml a test app gets unless it brings its own: executor `test`, no job or usage sources. */
export const TEST_PLUGINS = { version: 1, executors: [{ name: 'test', plugin: 'test' }], jobSources: [], usageSources: [] };

export function writePluginsYaml(dataDir: string, doc: unknown): string {
  const path = join(dataDir, 'plugins.yaml');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, typeof doc === 'string' ? doc : stringify(doc), { mode: 0o600 });
  return path;
}

export const TOKEN_RE = /localStorage\.setItem\(\s*['"]jh_session['"]\s*,\s*['"]([0-9a-f]{64})['"]\s*\)/;

export async function startTestApp(o: {
  dbPath: string; env?: Record<string, string>; seams?: AppSeams; source?: ManualSource;
  /** Run the configured router (plugins.yaml through the plugin host) instead of the fake. */
  realRouter?: boolean;
  /** Sections over TEST_PLUGINS, written on this start; absent: TEST_PLUGINS unless the data dir has a plugins.yaml; false: none. */
  plugins?: Record<string, unknown> | false;
  /** Run the plugin host's answerer and assessor instead of the fake doubles. */
  realQuestionRoles?: boolean;
}): Promise<TestApp> {
  const dataDir = dirname(o.dbPath);
  if (o.plugins) writePluginsYaml(dataDir, { ...TEST_PLUGINS, ...o.plugins });
  else if (o.plugins === undefined && !existsSync(join(dataDir, 'plugins.yaml'))) writePluginsYaml(dataDir, TEST_PLUGINS);
  const config = loadConfig({
    JOB_HOPPER_PORT: '0',
    JOB_HOPPER_DB: o.dbPath,
    JOB_HOPPER_TICK_MS: '50',
    JOB_HOPPER_WEBHOOK_BASE_MS: '20',
    JOB_HOPPER_LANE_IDLE_GRACE_MS: '200',
    JOB_HOPPER_RULES_FILE: '/nonexistent/job-hopper-rules.md',
    JOB_HOPPER_WEBHOOKS_FILE: join(dataDir, 'webhooks.yaml'),
    JOB_HOPPER_PLUGIN_DIR: join(dataDir, 'plugins'),
    JOB_HOPPER_PLUGINS_FILE: join(dataDir, 'plugins.yaml'),
    JOB_HOPPER_UPDATE_CHECK_MS: '0',
    ...o.env,
  });
  const source = o.source ?? createManualSource();
  const scripted = createScriptedExecutor();
  const app = await startApp(config, {
    pluginsFileIntervalMs: 50,
    ...(o.realRouter ? {} : { router: createFakeRouter({ clock: { now: () => new Date() } }) }),
    ...(o.realQuestionRoles ? {} : fakeQuestionRoles()),
    fakeUsage: createFakeUsageSource({ now: () => new Date() }),
    ...o.seams,
    executors: [scripted, ...(o.seams?.executors ?? [])],
    sources: [source, ...(o.seams?.sources ?? [])],
  });
  const tracker = trackConformance(app.store);
  const api = async <T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> => {
    const res = await fetch(app.url + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined } as ApiResponse<T>;
  };
  const job = async (id: string): Promise<Job> => (await api<Job>('GET', `/api/jobs/${id}`)).body;
  const questionsOf = async (jobId: string): Promise<Question[]> => (await api<{ questions: Question[] }>(
    'GET', '/api/questions?status=all&limit=1000')).body.questions.filter((q) => q.jobId === jobId);
  const sync = () => app.sources.syncNow();
  let stopped = false;
  return {
    app, url: app.url, dbPath: o.dbPath, dataDir, source, scripted, api, sync, job, questionsOf,
    async pull(op, over = {}) {
      const item = manualItem({ prompt: JSON.stringify(op), ...over });
      source.add(item);
      await app.sources.syncNow(source.name);
      const jobs = (await api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
      const found = jobs.find((j) => j.source?.key === item.key);
      if (!found) throw new Error(`no job was pulled for ${item.key}`);
      return found;
    },
    waitForStatus: (id, status, timeoutMs) => waitFor(async () => {
      const j = await job(id);
      return j.status === status ? j : undefined;
    }, { timeoutMs, what: `job ${id} to be ${status}` }),
    events: async (query = 'limit=1000') => (await api<{ events: DomainEvent[] }>('GET', `/api/events?${query}`)).body.events,
    waitForQuestion: (jobId, ok, timeoutMs) => waitFor(async () => {
      const q = (await questionsOf(jobId))[0];
      return q && ok(q) ? q : undefined;
    }, { timeoutMs, what: `a matching question on job ${jobId}` }),
    setUsage(used, limit = 100) { app.engine.setFakeUsage({ used, limit, unit: '%' }); },
    async login() {
      const code = readFileSync(join(dataDir, 'ui-login-code'), 'utf8').trim();
      const res = await rawRequest(app.url, {
        method: 'POST', path: '/ui/login', body: `code=${code}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      });
      const m = TOKEN_RE.exec(res.text);
      if (res.status !== 200 || !m) throw new Error(`login failed ${res.status}: ${res.text}`);
      return m[1]!;
    },
    async ui<T>(path: string, body: unknown = {}, u: UiOptions = {}) {
      const defaults: Record<string, string | null> = {
        'content-type': 'application/json', origin: app.url, ...(u.token ? { 'x-jobhopper-session': u.token } : {}),
      };
      const merged = { ...defaults, ...u.headers };
      const headers = Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== null));
      const res = await rawRequest(app.url, { method: 'POST', path, headers, body: u.rawBody ?? JSON.stringify(body) });
      return { status: res.status, body: res.text ? JSON.parse(res.text) as T : undefined as T };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const all: DomainEvent[] = [];
      for (let page = app.store.events.since(0, 1000); page.length > 0; page = app.store.events.since(all.at(-1)!.seq, 1000)) {
        all.push(...page);
        if (page.length < 1000) break;
      }
      await app.stop();
      tracker.stop();
      assertAllConform(tracker);
      const bad = all.map((e) => ({ e, r: validateEvent(e) })).filter((x) => !x.r.ok);
      if (bad.length) {
        throw new Error(`${bad.length} stored event(s) violate their schema:\n${bad
          .map((b) => `  #${b.e.seq} ${b.e.type}: ${b.r.ok ? '' : b.r.issues.join('; ')}`).join('\n')}`);
      }
    },
  };
}
