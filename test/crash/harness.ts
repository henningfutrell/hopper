// The crash harness (issue #1954, design.md "The crash harness"): hoppers as processes of their own over one test
// database (host.ts), each ended with SIGKILL at a kill point the test names (src/sagas/kill-points.ts), and the
// seeded pick of a kill point for the randomised runs. A host killed holds its leases until they end; the test ends
// them at once (`endLeases`), as the time a lease lasts would.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.ts';
import { rawRequest } from '../support/http.ts';

const HOST = new URL('./host.ts', import.meta.url).pathname;
/** What a host prints once it serves, before its `{ url, token }`. */
const READY = 'crash-host-ready ';
/** The most a host takes to serve. */
const START_MS = 60_000;

export interface Exit { code: number | null; signal: NodeJS.Signals | null }

export interface CrashHost {
  url: string;
  /** An admin's UI session. */
  token: string;
  /** Resolves when the process ended, however it ended. */
  exited: Promise<Exit>;
  /** What the process wrote to stderr so far. */
  stderr(): string;
  /** POST a UI mutation as the admin; a host killed meanwhile answers status 0. */
  ui(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
  /** GET as the admin. */
  get<T>(path: string): Promise<T>;
  /** Ends the process with SIGKILL, wherever it is. */
  kill(): Promise<Exit>;
}

export interface HostOptions {
  /** The test app's `dbPath`: it names the schema (support/database.ts). */
  dbPath: string;
  /** The database's URL, maybe through a proxy (support/stalling-proxy.ts). */
  databaseUrl: string;
  /** The providers' fakes. */
  fakes: { cloudflare: string; ngrok: string };
  /** The kill point to end this host at. */
  killPoint?: string;
}

const children = new Set<ChildProcess>();
/** The master key of every host this test process starts: they share their databases. */
const MASTER_KEY = randomBytes(32).toString('hex');

export function startHost(o: HostOptions): Promise<CrashHost> {
  const child = spawn(process.execPath, [HOST], {
    env: {
      ...process.env, CRASH_DB_PATH: o.dbPath, HOPPER_DATABASE_URL: o.databaseUrl,
      HOPPER_WORK_DIR: mkdtempSync(join(tmpdir(), 'crash-host-')),
      CRASH_CLOUDFLARE_URL: o.fakes.cloudflare, CRASH_NGROK_URL: o.fakes.ngrok, CRASH_MASTER_KEY: MASTER_KEY,
      ...(o.killPoint ? { HOPPER_TEST_KILL_POINT: o.killPoint } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stderr = '', stdout = '';
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const exited = new Promise<Exit>((resolve) => child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal }); }));
  return new Promise<CrashHost>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the crash host did not serve in ${START_MS} ms:\n${stderr}`)), START_MS);
    void exited.then((e) => { clearTimeout(timer); reject(new Error(`the crash host ended before it served (${e.signal ?? e.code}):\n${stderr}`)); });
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      const line = stdout.split('\n').slice(0, -1).find((l) => l.startsWith(READY));
      if (!line) return;
      stdout = '';
      clearTimeout(timer);
      const { url, token } = JSON.parse(line.slice(READY.length)) as { url: string; token: string };
      const headers = { 'content-type': 'application/json', origin: url, 'x-hopper-session': token };
      resolve({
        url, token, exited, stderr: () => stderr,
        kill: () => { child.kill('SIGKILL'); return exited; },
        ui: async (path, body) => {
          try {
            const r = await rawRequest(url, { method: 'POST', path, headers, body: JSON.stringify(body) });
            return { status: r.status, body: r.text ? JSON.parse(r.text) as unknown : undefined };
          } catch { return { status: 0, body: undefined }; }
        },
        get: async <T>(path: string) => {
          const r = await rawRequest(url, { path, headers: { 'x-hopper-session': token } });
          if (r.status !== 200) throw new Error(`GET ${path}: ${r.status} ${r.text}`);
          return JSON.parse(r.text) as T;
        },
      });
    });
  });
}

/** Ends every host still running: SIGTERM, then SIGKILL after 10 s. Each test file calls it in afterEach. */
export async function stopHosts(): Promise<void> {
  await Promise.all([...children].map((c) => new Promise<void>((resolve) => {
    c.once('exit', () => resolve());
    c.kill('SIGTERM');
    setTimeout(() => c.kill('SIGKILL'), 10_000).unref();
  })));
}

/** Ends every saga lease in the database at once, as their time would: a killed host's sagas are due again. */
export function endLeases(databaseUrl: string): void {
  const db = openDb(databaseUrl);
  try { db.run("UPDATE sagas SET lease_until = '1970-01-01T00:00:00.000Z' WHERE lease_owner IS NOT NULL"); } finally { db.close(); }
}

/** A seeded pick (mulberry32): the same seed picks the same kill points, so a failure is reproduced by its seed. */
export function seeded(seed: number): <T>(of: readonly T[]) => T {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (of) => of[Math.floor(next() * of.length)]!;
}
