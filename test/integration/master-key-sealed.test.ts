// Issue #1296, through scripts/master-key.sh, the real composition root and the real HTTP server: the master key sealed to
// the host, unsealed at launch, and a start without the right key refused, never limited. Each start here is a new daemon
// on the same database, with the environment `master-key.sh run` gives the command it runs — as a recreate of the
// container is. The seal is the key-encryption key of this host (HOPPER_KEY_SEAL=kek: openssl, in a throwaway HOME);
// systemd-creds is the same script path with another tool (test/scripts/master-key.test.ts).
//
// Feature: a restart needs no key from a person
//   Scenario: after sealing, a recreate with no key in the caller's environment starts healthy, not limited, with the database's fingerprint
//   Scenario: with the sealed key removed, the launch fails; with a wrong key sealed, the start fails and names the expected fingerprint
//   Scenario: no file in the compose folder holds the key in plaintext, and no log line holds it
//   Scenario: a rotation seals the new key in the same step, and the next start unseals the new key; the UI's rotation is refused
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintOf } from '../../src/secrets/master-key.ts';
import { openDb } from '../../src/store/db.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { KEY, NEW_KEY } from '../support/webhooks.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'master-key.sh');
const HOPPER_ID = 'c'.repeat(64);

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

/** The compose folder: master-key.sh beside compose.yaml, a HOME of its own, and `podman` a stub whose `exec … hopper …` runs this checkout's CLI against the daemon at `url`. */
function composeFolder(): { dir: string; env: (url?: string, dbPath?: string) => NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'jh-sealed-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'compose.yaml'), readFileSync(join(ROOT, 'compose.yaml')));
  writeFileSync(join(dir, 'master-key.sh'), readFileSync(SCRIPT));
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'podman'), `#!/bin/sh
case "$*" in
  "ps -q --filter label=com.docker.compose.project=hopper --filter label=com.docker.compose.service=hopper") echo ${HOPPER_ID} ;;
  "exec ${HOPPER_ID} hopper "*) shift 3; exec '${process.execPath}' '${join(ROOT, 'src', 'cli.ts')}' "$@" --url "$STUB_URL" ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(bin, 'podman'), 0o755);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'docker'), 0o755);
  const home = join(dir, '.home');
  mkdirSync(home);
  return {
    dir,
    env: (url, dbPath) => ({
      PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), HOPPER_KEY_SEAL: 'kek',
      ...(url ? { STUB_URL: url } : {}), ...(dbPath ? { HOPPER_DATABASE_URL: databaseUrlFor(dbPath) } : {}),
    }),
  };
}

const sh = (dir: string, env: NodeJS.ProcessEnv, args: string[]) => {
  const r = spawnSync('/bin/bash', ['master-key.sh', ...args], { cwd: dir, env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

/** What `master-key.sh run` gives the command it runs: the launch environment of the recreated hopper. */
function launched(dir: string, env: NodeJS.ProcessEnv): { status: number | null; err: string; secrets?: Record<string, string> } {
  const r = sh(dir, env, ['run', process.execPath, '-e', 'process.stdout.write(JSON.stringify({ HOPPER_MASTER_KEY: process.env.HOPPER_MASTER_KEY, HOPPER_MASTER_KEY_SEALED: process.env.HOPPER_MASTER_KEY_SEALED }))']);
  return { status: r.status, err: r.err, ...(r.status === 0 ? { secrets: JSON.parse(r.out) as Record<string, string> } : {}) };
}

async function boot(dbPath: string, secrets: Record<string, string | undefined>): Promise<TestApp> {
  await t?.stop();
  t = undefined;
  t = await startTestApp({ dbPath, secrets: { HOPPER_MASTER_KEY: undefined, ...secrets } });
  return t;
}

function fingerprintInDb(dbPath: string): string | undefined {
  const db = openDb(databaseUrlFor(dbPath));
  try { return db.all('SELECT key, value FROM settings').filter((r) => r.key === 'masterKeyFingerprint').map((r) => String(r.value))[0]; } finally { db.close(); }
}

/** Every file under `dir`, read whole, for a plaintext key. */
const filesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'));

const freshDb = (): string => {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  return db.dbPath;
};

describe('the master key sealed to the host (issue #1296)', () => {
  it('after sealing, a recreate with no key in the caller\'s environment starts healthy, not limited, with the database\'s fingerprint; no file and no log line holds the key', async () => {
    const dbPath = freshDb();
    await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    const { dir, env } = composeFolder();
    const sealed = sh(dir, { ...env(), HOPPER_MASTER_KEY: KEY }, ['seal']);
    expect(sealed.status, sealed.err).toBe(0);

    // The caller gives no key: the launch unseals it, for the command it runs only.
    const launch = launched(dir, env());
    expect(launch.status, launch.err).toBe(0);
    expect(launch.secrets).toEqual({ HOPPER_MASTER_KEY: KEY, HOPPER_MASTER_KEY_SEALED: 'kek' });
    const a = await boot(dbPath, launch.secrets!);
    expect((await a.api('GET', '/api/health')).status).toBe(200);
    expect((await a.api('GET', '/api/master-key')).body).toEqual({ source: 'given', fingerprint: fingerprintOf(KEY).slice(0, 16), previous: false, saved: true, revealable: false, sealed: 'kek' });
    expect(fingerprintInDb(dbPath)).toBe(fingerprintOf(KEY));

    for (const text of filesUnder(dir)) expect(text).not.toContain(KEY);
    for (const text of [...logged, sealed.err, launch.err]) expect(text).not.toContain(KEY);
  });

  it('with the sealed key removed the launch fails; with a wrong key sealed the start fails, naming the expected fingerprint', async () => {
    const dbPath = freshDb();
    await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    await t?.stop();
    t = undefined;
    const { dir, env } = composeFolder();

    expect(sh(dir, { ...env(), HOPPER_MASTER_KEY: KEY }, ['seal']).status).toBe(0);
    rmSync(join(dir, 'hopper-master-key.enc'));
    const removed = launched(dir, env());
    expect(removed.status).not.toBe(0);
    expect(removed.err).toMatch(/no sealed master key here/);

    // The key-encryption key gone: what is sealed does not unseal, and nothing starts.
    expect(sh(dir, { ...env(), HOPPER_MASTER_KEY: KEY }, ['seal']).status).toBe(0);
    rmSync(join(env().XDG_CONFIG_HOME!, 'hopper', 'master-key.kek'));
    const lost = launched(dir, env());
    expect(lost.status).not.toBe(0);
    expect(lost.err).toMatch(/does not unseal on this host/);

    // Another key sealed: the hopper does not start on it, and says which key it needs.
    expect(sh(dir, { ...env(), HOPPER_MASTER_KEY: NEW_KEY }, ['seal']).status).toBe(0);
    const wrong = launched(dir, env());
    expect(wrong.status, wrong.err).toBe(0);
    await expect(boot(dbPath, wrong.secrets!)).rejects.toThrow(`it was set up with the key of fingerprint ${fingerprintOf(KEY).slice(0, 16)}`);
    expect(logged.some((l) => l.includes('LIMITED'))).toBe(false);
    expect(fingerprintInDb(dbPath)).toBe(fingerprintOf(KEY));
  });

  it('a rotation seals the new key in the same step, and the next start unseals it; the UI\'s rotation is refused', async () => {
    const dbPath = freshDb();
    await boot(dbPath, { HOPPER_MASTER_KEY: KEY });
    const { dir, env } = composeFolder();
    expect(sh(dir, { ...env(), HOPPER_MASTER_KEY: KEY }, ['seal']).status).toBe(0);
    const a = await boot(dbPath, launched(dir, env()).secrets!);

    const ui = await a.ui<{ error?: string }>('/ui/api/master-key', { action: 'rotate' }, { token: await a.login() });
    expect(ui.status).toBe(409);
    expect(ui.body.error).toContain('bash master-key.sh rotate');
    expect(fingerprintInDb(dbPath)).toBe(fingerprintOf(KEY));

    // The host's rotation: the running daemon answers while the script waits, so it runs beside it, not blocking it.
    const rotated = await new Promise<{ code: number; err: string }>((done) => {
      execFile('/bin/bash', ['master-key.sh', 'rotate'], { cwd: dir, env: env(a.url, dbPath), encoding: 'utf8' }, (e, _out, err) => done({ code: e ? Number(e.code ?? 1) : 0, err }));
    });
    expect(rotated.code, rotated.err).toBe(0);
    const now = fingerprintInDb(dbPath)!;
    expect(now).not.toBe(fingerprintOf(KEY));
    expect(rotated.err).toContain(`fingerprint ${now.slice(0, 16)}`);

    const next = launched(dir, env());
    expect(next.status, next.err).toBe(0);
    expect(fingerprintOf(next.secrets!.HOPPER_MASTER_KEY!)).toBe(now);
    const again = await boot(dbPath, next.secrets!);
    expect((await again.api('GET', '/api/master-key')).body).toMatchObject({ source: 'given', fingerprint: now.slice(0, 16), sealed: 'kek' });
    for (const text of filesUnder(dir)) expect(text).not.toContain(next.secrets!.HOPPER_MASTER_KEY);
    for (const text of [...logged, rotated.err]) expect(text).not.toContain(next.secrets!.HOPPER_MASTER_KEY);
  });
});
