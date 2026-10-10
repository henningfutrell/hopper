// Issue #685, the daemon as a process: a container's log goes to the host's journal and stays there, so the master key
// never goes to it. Started as `node src/main.ts` with no HOPPER_MASTER_KEY on a new database, the hopper makes a key;
// its log names only where the key came from and its fingerprint. The test's isolation (support/isolate.ts) is loaded
// into the process too: no request leaves loopback.
//
// Feature: the master key is never written to the log
//   Scenario: a first start with no key makes one: the log has its source and fingerprint, never the key in any form
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprintOf } from '../../src/secrets/master-key.ts';
import { openDb } from '../../src/store/db.ts';
import { databaseUrlFor, newHopper } from '../support/database.ts';
import { waitFor } from '../support/wait.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

/** Every run of key characters in `text` that a 32-byte key could hide in. */
const candidates = (text: string): string[] => text.match(/[A-Za-z0-9+/=_-]{43,}/g) ?? [];

/** Whether `candidate` (or a 64-character or 43/44-character part of it) is the key of `fingerprint`. */
function isKey(candidate: string, fingerprint: string): boolean {
  for (const len of [64, 44, 43]) {
    for (let i = 0; i + len <= candidate.length; i++) {
      try {
        if (fingerprintOf(candidate.slice(i, i + len)) === fingerprint) return true;
      } catch { /* not a key */ }
    }
  }
  return false;
}

describe('the master key never goes to the log (issue #685)', () => {
  it('a first start with no HOPPER_MASTER_KEY makes a key; the log has its source and fingerprint, never the key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopper-685-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'db.sqlite');
    newHopper(dbPath);
    const url = databaseUrlFor(dbPath);

    let log = '';
    const child = spawn(process.execPath, ['--import', './test/support/isolate.ts', 'src/main.ts'], {
      env: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), HOPPER_DATABASE_URL: url, HOPPER_PORT: '0', HOPPER_WORK_DIR: join(dir, 'work') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    cleanups.push(() => { child.kill('SIGKILL'); });
    child.stdout.on('data', (d: Buffer) => { log += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { log += d.toString('utf8'); });
    await waitFor(() => log.includes('hopper listening on'), { timeoutMs: 30_000 });
    child.kill('SIGTERM');
    await exited;

    const db = openDb(url);
    let fingerprint: string;
    try { fingerprint = String(db.get("SELECT value FROM settings WHERE key = 'masterKeyFingerprint'")!.value); } finally { db.close(); }
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

    expect(log).toMatch(new RegExp(`master key: made for this new hopper \\(generated\\), fingerprint ${fingerprint.slice(0, 16)}`));
    expect(log).not.toContain('SAVE THIS NOW');
    expect(log).not.toContain(fingerprint);
    expect(candidates(log).filter((c) => isKey(c, fingerprint))).toEqual([]);
  }, 60_000);
});
