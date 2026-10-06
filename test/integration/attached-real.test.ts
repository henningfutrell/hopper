// Opt-in: HOPPER_REAL_SSH=<ssh-target> (e.g. laptop) with HOPPER_SSH_KEY_FILE=<the hopper's
// key, installed there by attach-machine.sh>. Issue #10 for real: a herdr-claude job pulled by the
// daemon runs on the attached machine, in a throwaway herdr session started there (jh-test-<random>),
// and reports that machine's hostname — reached as issue #59 requires: the hopper's key only, to the
// host key the user's known_hosts pins. Costs one small Claude turn there. Needs herdr and claude on
// the target, and ssh in batch mode.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownHostKey } from '../../src/machines/index.ts';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const TARGET = process.env.HOPPER_REAL_SSH;
// The real home: the test isolation moves HOME, and the target's pinned key is in the user's known_hosts.
const REAL_HOME = process.env.HOPPER_REAL_HOME ?? homedir();
const SESSION = `jh-test-${randomBytes(4).toString('hex')}`;
const ssh = (command: string): string =>
  execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', TARGET!, command], { encoding: 'utf8', timeout: 30000 });

describe.skipIf(!TARGET)('a real job on an attached machine (opt-in)', () => {
  let a: TestApp;
  let cleanup: () => void;

  beforeAll(async () => {
    const herdrBin = ssh('command -v herdr').trim().replaceAll('//', '/');
    const hostKey = await knownHostKey({ target: TARGET!, knownHosts: join(REAL_HOME, '.ssh', 'known_hosts') });
    ssh(`nohup ${herdrBin} --session ${SESSION} server >/dev/null 2>&1 </dev/null &`);
    const db = tempDbPath();
    cleanup = db.cleanup;
    writePlugins(db.dbPath, {
      version: 1,
      executors: [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { cwd: '/tmp' } }],
      machines: [
        { name: 'local', plugin: 'local' },
        { name: 'remote', plugin: 'ssh', options: { ssh: TARGET, lanes: 8, session: SESSION, herdrBin, hostKey } },
      ],
    });
    a = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_SSH_KEY_FILE: process.env.HOPPER_SSH_KEY_FILE } });
    await waitFor(async () => (await a.api('GET', '/api/machines')).body.machines.some((m: { id: string; online: boolean }) => m.id === 'remote' && m.online), { timeoutMs: 60000 });
  }, 90000);

  afterAll(async () => {
    await a?.stop();
    cleanup?.();
    try { ssh(`herdr --session ${SESSION} server stop; herdr session delete ${SESSION} --json`); } catch { /* already gone */ }
  });

  it('runs there and finishes with that machine\'s hostname', async () => {
    const hostname = ssh('hostname').trim();
    const job = await a.pull({}, {
      executor: 'herdr-claude', cwd: '/tmp',
      prompt: 'Run the shell command `hostname` and reply with exactly its output, nothing else.',
    });
    const done = await waitFor(async () => {
      const j = await a.job(job.id);
      return ['finished', 'failed', 'waiting_answer'].includes(j.status) ? j : undefined;
    }, { timeoutMs: 240000, what: 'a terminal status or a question' }).catch(async (e: unknown) => {
      throw new Error(`${(e as Error).message}; job now ${JSON.stringify(await a.job(job.id))}`);
    });
    expect(done, JSON.stringify(done)).toMatchObject({ status: 'finished' });
    const claimed = (await a.events('types=job.claimed&limit=100')).find((e) => e.jobId === job.id)!;
    expect(claimed.machineId).toBe('remote');
    expect(done.executorState).toMatchObject({ ssh: TARGET, session: SESSION, herdrBin: expect.stringMatching(/^\/.*herdr$/) });
    expect(JSON.stringify(done.result)).toContain(hostname);
  }, 300000);
});
