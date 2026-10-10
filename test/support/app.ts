// Starts the real composition root (src/main.ts) on port 0 against a temp database (support/database.ts:
// a Postgres schema named after `dbPath`), with the fake router at the Router seam (unless
// `realRouter`: then the plugin host's router runs), the fake usage source and the fake question
// doubles (fake-questions.ts) at their seams, a fast tick, and plugins.yaml (executor `test`, no job
// or usage sources) in the database. `plugins` sections are written over TEST_PLUGINS on every start;
// without them a plugins.yaml already in the database is kept; `plugins: false` writes none, so the
// daemon writes its built-in instances. `secrets` is the environment the parts read secrets from
// (seams.env): the same object, so a test may set or unset a variable while the app runs. Jobs are PULLED: a
// manual JobSource (manual-source.ts) offers items, run by the "scripted" executor
// (scripted-executor.ts). Every user (issue #158) has a manual source of its own (`sourceOf(id)`;
// `source` is admin's); `api` reads without a session (loopback: the one user's work, while there is one
// user) unless its headers carry one; the helpers that read a user's work (`job`, `pull`, …) carry a
// session of that user once the hopper has several (issue #221).
// Every event the app emits is validated against its schema; stop() fails the test on any
// nonconforming event (tracker + a scan of every user's whole event log).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { startApp, type App, type AppSeams } from '../../src/main.ts';
import type { SourceItem } from '../../src/domain/ports.ts';
import type { DomainEvent, Job, Question, User } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { validateEvent } from '../../src/events/index.ts';
import { assertAllConform, trackConformance } from './conformance.ts';
import { rawRequest } from './http.ts';
import { createFakeUsageSource } from '../../src/usage/index.ts';
import { databaseUrlFor, isNewHopper } from './database.ts';
import { mintLoginCode } from '../../src/http/ui/login-code.ts';
import { readConfig, writeConfig } from './files.ts';
import { fakeLevels } from './fake-questions.ts';
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
  /** Owner's manual source. */
  source: ManualSource;
  /** A user's manual source. */
  sourceOf(userId: string): ManualSource;
  scripted: ScriptedExecutor;
  /** A user's running parts (store, engine, sources, plugins); default admin. */
  user(id?: string): ReturnType<App['user']>;
  /** A new user, its runtime started (as POST /ui/api/users does). */
  addUser(name: string): Promise<User>;
  /** Add this machine (`local`) to a user's machines (default admin), as the UI's plugin edit does: a user starts with none (issue #259). */
  addThisMachine(userId?: string): Promise<void>;
  /** A request without a session (loopback: the one user's work; nothing of a user's with several), with `headers` (`x-hopper-session`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
  api<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  /** Offer one item through the user's manual source (default admin), sync, and return its job. `script` is the scripted executor's op. */
  pull(script: Record<string, unknown>, item?: Partial<SourceItem>, userId?: string): Promise<Job>;
  /** One sync of every source of admin. */
  sync(): Promise<void>;
  job(id: string): Promise<Job>;
  waitForStatus(id: string, status: string, timeoutMs?: number): Promise<Job>;
  /** A user's job reaching `status`. */
  waitForStatusOf(id: string, status: string, userId: string, timeoutMs?: number): Promise<Job>;
  events(query?: string): Promise<DomainEvent[]>;
  questionsOf(jobId: string): Promise<Question[]>;
  waitForQuestion(jobId: string, ok: (q: Question) => boolean, timeoutMs?: number): Promise<Question>;
  /** Set the fake usage reading (through the engine; there is no HTTP route). */
  setUsage(used: number, limit?: number): void;
  /** Log in with a login code minted for the user (default admin), as a device link does: POST /ui/login. Returns the session token. */
  login(userId?: string): Promise<string>;
  /** POST /ui/login with this code. Returns the session token. */
  loginWith(code: string): Promise<string>;
  /** POST a UI mutation with a valid Origin, JSON content type and (if given) the session header. */
  ui<T = unknown>(path: string, body?: unknown, o?: UiOptions): Promise<ApiResponse<T>>;
  stop(): Promise<void>;
}

/** A temp dir (the app's work dir) and `dbPath` in it: the key of the app's database (support/database.ts databaseUrlFor). */
export function tempDbPath(): { dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'hopper-it-'));
  return { dbPath: join(dir, 'db.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The plugins config's `machines`: only the local machine, with this many lanes. */
export const lanes = (n: number) => [{ name: 'local', plugin: 'local', options: { lanes: n } }];

/** The plugins config a test app gets unless it brings its own: executor `test`, no job or usage sources. */
export const TEST_PLUGINS = { version: 1, executors: [{ name: 'test', plugin: 'test' }], jobSources: [], usageSources: [] };

/** Replace the plugins config in the database of `dbPath`. */
export function writePlugins(dbPath: string, value: unknown): void {
  writeConfig(dbPath, 'plugins', value);
}

export const TOKEN_RE = /localStorage\.setItem\(\s*['"]jh_session['"]\s*,\s*['"]([0-9a-f]{64})['"]\s*\)/;

export async function startTestApp(o: {
  dbPath: string; env?: Record<string, string>; seams?: AppSeams; source?: ManualSource;
  /** Run the configured router (the plugins config through the plugin host) instead of the fake. */
  realRouter?: boolean;
  /** Sections over TEST_PLUGINS, written on this start; absent: TEST_PLUGINS unless the database has a plugins config; false: none. */
  plugins?: Record<string, unknown> | false;
  /** Run the plugin host's escalation levels instead of the fake doubles. */
  realLevels?: boolean;
  /** Secrets the parts read (GITHUB_APP_PRIVATE_KEY, GROKBOT_WEBHOOK_URL, …), over PATH; mutable while the app runs. */
  secrets?: Record<string, string | undefined>;
}): Promise<TestApp> {
  const dataDir = dirname(o.dbPath);
  // A new hopper (issue #238) has no user whose plugins config to write: its users start with the defaults.
  if (o.plugins) writePlugins(o.dbPath, { ...TEST_PLUGINS, ...o.plugins });
  else if (o.plugins === undefined && !isNewHopper(o.dbPath) && readConfig(o.dbPath, 'plugins') === undefined) writePlugins(o.dbPath, TEST_PLUGINS);
  const secrets = o.secrets ?? {};
  if (secrets.PATH === undefined) secrets.PATH = process.env.PATH;
  const config = loadConfig({
    HOPPER_PORT: '0',
    HOPPER_DATABASE_URL: databaseUrlFor(o.dbPath),
    HOPPER_WORK_DIR: dataDir,
    HOPPER_TICK_MS: '50',
    HOPPER_WEBHOOK_BASE_MS: '20',
    HOPPER_LANE_IDLE_GRACE_MS: '200',
    HOPPER_PLUGIN_DIR: join(dataDir, 'plugins'),
    HOPPER_UPDATE_CHECK_MS: '0',
    HOPPER_DONE_RECHECK_MS: '0',
    ...o.env,
  });
  const source = o.source ?? createManualSource();
  const sources = new Map<string, ManualSource>([[ADMIN_ID, source]]);
  const sourceOf = (id: string): ManualSource => {
    let s = sources.get(id);
    if (!s) sources.set(id, (s = createManualSource()));
    return s;
  };
  const scripted = createScriptedExecutor();
  const app = await startApp(config, {
    pluginsConfigIntervalMs: 50,
    env: secrets,
    // No default plugin store: a test never fetches the published one; a test that wants one names it.
    pluginStoreDefault: null,
    ...(o.realRouter ? {} : { router: createFakeRouter({ clock: { now: () => new Date() } }) }),
    ...(o.realLevels ? {} : fakeLevels()),
    // No model in tests (issue #569): a long card has no TL;DR unless a test puts a double here.
    tldrWriter: async () => ({ error: 'no TL;DR model in tests' }),
    ...o.seams,
    executors: [scripted, ...(o.seams?.executors ?? [])],
    // Each user's own manual source and fake usage; the seams' sources run for admin only.
    perUser: (id) => ({
      fakeUsage: createFakeUsageSource({ now: () => new Date() }),
      sources: [sourceOf(id), ...(id === ADMIN_ID ? o.seams?.sources ?? [] : [])],
      ...o.seams?.perUser?.(id),
    }),
  });
  // A new hopper (issue #238) has no admin to track; the scan of every user's log at stop still runs.
  const tracker = app.users().some((u) => u.id === ADMIN_ID) ? trackConformance(app.user(ADMIN_ID).store) : undefined;
  const api = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> => {
    const res = await fetch(app.url + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined } as ApiResponse<T>;
  };
  const loginWith = async (code: string): Promise<string> => {
    const res = await rawRequest(app.url, {
      method: 'POST', path: '/ui/login', body: `code=${code}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
    });
    const m = TOKEN_RE.exec(res.text);
    if (res.status !== 200 || !m) throw new Error(`login failed ${res.status}: ${res.text}`);
    return m[1]!;
  };
  /** Headers that read `userId`'s work: none while the hopper has one user, else a session of that user (minted once). */
  const tokens = new Map<string, string>();
  const as = async (userId: string): Promise<Record<string, string>> => {
    if (app.users().length === 1) return {};
    let token = tokens.get(userId);
    if (token === undefined) {
      token = await loginWith(mintLoginCode(app.instance, { now: () => new Date() }, userId));
      tokens.set(userId, token);
    }
    return { 'x-hopper-session': token };
  };
  const job = async (id: string): Promise<Job> => (await api<Job>('GET', `/api/jobs/${id}`, undefined, await as(ADMIN_ID))).body;
  const questionsOf = async (jobId: string): Promise<Question[]> => (await api<{ questions: Question[] }>(
    'GET', '/api/questions?status=all&limit=1000', undefined, await as(ADMIN_ID))).body.questions.filter((q) => q.jobId === jobId);
  const sync = () => app.user(ADMIN_ID).sources.syncNow();
  let stopped = false;
  return {
    app, url: app.url, dbPath: o.dbPath, dataDir, source, sourceOf, scripted, api, sync, job, questionsOf, loginWith,
    user: (id = ADMIN_ID) => app.user(id),
    addUser: (name) => app.addUser(name),
    async addThisMachine(userId = ADMIN_ID) {
      const { plugins } = app.user(userId);
      const r = await plugins.edit({ action: 'add', role: 'machine-source', plugin: 'local', name: 'local', version: plugins.report().config.version });
      if (!r.ok) throw new Error(`this machine was not added: ${r.error}`);
    },
    async pull(op, over = {}, userId = ADMIN_ID) {
      const item = manualItem({ prompt: JSON.stringify(op), ...over });
      const s = sourceOf(userId);
      s.add(item);
      await app.user(userId).sources.syncNow(s.name);
      const jobs = (await api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000', undefined, await as(userId))).body.jobs;
      const found = jobs.find((j) => j.source?.key === item.key);
      if (!found) throw new Error(`no job was pulled for ${item.key}`);
      return found;
    },
    waitForStatus: (id, status, timeoutMs) => waitFor(async () => {
      const j = await job(id);
      return j.status === status ? j : undefined;
    }, { timeoutMs, what: `job ${id} to be ${status}` }),
    waitForStatusOf: (id, status, userId, timeoutMs) => waitFor(async () => {
      const j = (await api<Job>('GET', `/api/jobs/${id}`, undefined, await as(userId))).body;
      return j.status === status ? j : undefined;
    }, { timeoutMs, what: `job ${id} of ${userId} to be ${status}` }),
    events: async (query = 'limit=1000') => (await api<{ events: DomainEvent[] }>('GET', `/api/events?${query}`, undefined, await as(ADMIN_ID))).body.events,
    waitForQuestion: (jobId, ok, timeoutMs) => waitFor(async () => {
      const q = (await questionsOf(jobId))[0];
      return q && ok(q) ? q : undefined;
    }, { timeoutMs, what: `a matching question on job ${jobId}` }),
    setUsage(used, limit = 100) { app.user(ADMIN_ID).engine.setFakeUsage({ used, limit, unit: '%' }); },
    login: (userId = ADMIN_ID) => loginWith(mintLoginCode(app.instance, { now: () => new Date() }, userId)),
    async ui<T>(path: string, body: unknown = {}, u: UiOptions = {}) {
      const defaults: Record<string, string | null> = {
        'content-type': 'application/json', origin: app.url, ...(u.token ? { 'x-hopper-session': u.token } : {}),
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
      for (const u of app.users()) {
        const events = app.user(u.id).store.events;
        const mine: DomainEvent[] = [];
        for (let page = events.since(0, 1000); page.length > 0; page = events.since(mine.at(-1)!.seq, 1000)) {
          mine.push(...page);
          if (page.length < 1000) break;
        }
        all.push(...mine);
      }
      await app.stop();
      if (tracker) {
        tracker.stop();
        assertAllConform(tracker);
      }
      const bad = all.map((e) => ({ e, r: validateEvent(e) })).filter((x) => !x.r.ok);
      if (bad.length) {
        throw new Error(`${bad.length} stored event(s) violate their schema:\n${bad
          .map((b) => `  #${b.e.seq} ${b.e.type}: ${b.r.ok ? '' : b.r.issues.join('; ')}`).join('\n')}`);
      }
    },
  };
}
