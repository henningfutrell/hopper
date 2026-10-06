// Issue #260: this machine's herdr session is the one named when it was added, and the hopper starts it
// when it is not running — never the default session. A stand-in herdr keeps which sessions run in files.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHerdrSession } from '../../src/executors/herdr/index.ts';

let dir: string;
let herdr: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-herdr-session-'));
  herdr = join(dir, 'herdr');
  // `--session <s> status server` says running once `server` ran for that session (unless it is `broken`).
  writeFileSync(herdr, `#!/bin/sh
echo "$*" >> "${dir}/calls"
s="$2"; shift 2
case "$*" in
  "status server") if [ -e "${dir}/run-$s" ]; then echo "status: running"; else echo "status: not running"; fi ;;
  server) [ "$s" = broken ] || touch "${dir}/run-$s" ;;
esac
`);
  chmodSync(herdr, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const calls = (): string[] => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []);

describe('ensureHerdrSession', () => {
  it('not running: starts `herdr --session <s> server` and waits until it answers', async () => {
    expect(await ensureHerdrSession({ bin: herdr, session: 'jobs', systemdRun: null, pollMs: 10 })).toBe('started');
    expect(calls()).toContain('--session jobs server');
    expect(existsSync(join(dir, 'run-jobs'))).toBe(true);
  });

  it('already running: nothing is started', async () => {
    writeFileSync(join(dir, 'run-jobs'), '');
    expect(await ensureHerdrSession({ bin: herdr, session: 'jobs', systemdRun: null, pollMs: 10 })).toBe('running');
    expect(calls()).toEqual(['--session jobs status server']);
  });

  it('never answers: rejects, naming the session', async () => {
    await expect(ensureHerdrSession({ bin: herdr, session: 'broken', systemdRun: null, pollMs: 10, waitMs: 200 })).rejects.toThrow(/herdr session broken did not start/);
  });

  it('herdr missing: rejects, saying so', async () => {
    await expect(ensureHerdrSession({ bin: join(dir, 'nope'), session: 'jobs', systemdRun: null, pollMs: 10, waitMs: 200 })).rejects.toThrow(/herdr not found/);
  });

  it('never the default session', async () => {
    await expect(ensureHerdrSession({ bin: herdr, session: 'default', systemdRun: null })).rejects.toThrow(/default/);
    expect(calls()).toEqual([]);
  });
});
