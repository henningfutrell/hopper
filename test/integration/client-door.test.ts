// Issue #695, through the real composition root, the real HTTP server and a real joined client: a job on a client target
// reaches the hopper through its client's door, on loopback there — never at a name of the hopper's, which a machine
// outside the hopper's own network does not resolve (the bare container name `hopper` was the case: "Could not resolve
// host: hopper"). The job runs the real `hopper-skill` at the URL it is given. OpenFGA is a double at its seam.
//
// Feature: a job on an attached machine reaches the hopper with no name resolved
//   Scenario: a job on a client target is given its client's door, and its tools work through it
//     Given a hopper whose LAN name is its bare container name `hopper`, which this machine does not resolve
//     And a client target joined at the hopper's URL
//     When a job runs there
//     Then the job's HOPPER_URL is the client's door, on loopback, not the hopper's URL
//     And the machine reached the hopper at that URL before the job ran (the real check: curl, through the door)
//     And `hopper-skill` lists the catalog through the door
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import type { Executor, MachineShell } from '../../src/domain/ports.ts';
import type { DiscoveryFacts } from '../../src/domain/types.ts';
import { localShell } from '../../src/executors/machine-shell.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const NOTHING: DiscoveryFacts = { path: ['/usr/bin'], bins: [{ dir: '/usr/bin', name: 'sh' }], versions: {}, aws: [], kube: [], credentials: { env: [], files: [] } };

const apps: TestApp[] = [];
const clients: Client[] = [];
const cleanups: (() => void)[] = [];
const saved = { ...process.env };
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** An executor whose jobs hold their lane, keeping the variables they were given; the machine's reach check, run here, recorded. */
function holder() {
  const held = new Map<string, { env: Record<string, string>; end(): void }>();
  const asked: string[] = [];
  const shell: MachineShell = {
    async reap() { return { kept: [] }; },
    async survey() { return { scopes: [], processes: [], scratch: [] }; },
    async keepCredential() {},
    async discover() { return NOTHING; },
    async reach(url) {
      const problem = await localShell().reach(url);
      asked.push(problem ? `${url}: ${problem}` : url);
      return problem;
    },
  };
  const executor: Executor = {
    name: 'holder', idempotent: false, validate: () => null, machineShell: () => shell,
    async run(ctx) {
      const env = { ...(await ctx.credentials?.(`/work/.worktrees/@scratch/${ctx.job.id}`)) };
      // An abort (cancel, park, shutdown) returns at once, as the port asks: the daemon's stop does not wait it out.
      const aborted = await new Promise<boolean>((end) => {
        held.set(ctx.job.id, { env, end: () => end(false) });
        ctx.signal.addEventListener('abort', () => end(true), { once: true });
      });
      return aborted ? { kind: 'failed', error: 'aborted' } : { kind: 'finished', result: 'ended' };
    },
    resume: async () => ({ kind: 'failed', error: 'not resumed' }),
  };
  cleanups.push(() => { for (const j of held.values()) j.end(); });
  return { executor, held, asked };
}

function skill(url: string, token: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = temp('job-credentials-');
  writeFileSync(join(dir, 'token'), `${token}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  return new Promise((resolve) => {
    execFile('sh', [join(dir, 'skill')], { env: { PATH: process.env.PATH, HOPPER_URL: url, HOPPER_TOKEN_FILE: join(dir, 'token'), TMPDIR: tmpdir() }, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

describe('a job on a client target reaches the hopper through its client door (issue #695)', () => {
  it('is given the door as HOPPER_URL, checked from the machine first, and its tools work through it', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
    process.env.FAKE_HERDR_RUNNING = '1';
    const h = holder();
    const a = await startTestApp({
      dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, env: { HOPPER_LAN_NAMES: 'hopper', HOPPER_LAN_PEERS: '192.0.2.0/24' },
      plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['holder'] } },
      seams: { executors: [h.executor], authorizationServer: createFakeAuthorizationServer() },
    });
    apps.push(a);
    const session = await a.login();
    const code = (await a.ui<{ code: string }>('/ui/api/machines/join', {}, { token: session })).body.code;
    const dir = temp('hopper-machine-');
    await joinHopper({ line: `${a.url}#${code}`, name: 'fleet', dir });
    clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
    await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === 'fleet' && m.online), { timeoutMs: 10000, what: 'fleet online' });

    const job = await a.pull({}, { executor: 'holder' });
    const { env } = await waitFor(async () => h.held.get(job.id), { timeoutMs: 15000, what: 'the job to run on fleet' });
    expect((await a.job(job.id)).laneId).toBe('fleet/lane-1');
    expect(env.HOPPER_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.HOPPER_URL).not.toBe(a.url);
    expect(env.HOPPER_URL).not.toContain('hopper:');
    expect(h.asked).toEqual([env.HOPPER_URL]);

    const token = proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id);
    const r = await skill(env.HOPPER_URL!, token);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('artifacts');
  });
});
