// The secret canary check (issue #1957), in process: through the real composition root, the real HTTP server and the
// real `hopper-skill` and `hopper-step`, a hopper is given distinct random canaries as the master key, a vault secret a
// box step reads, a connected account's tokens and a webhook's signing secret; the job's proxy token is the credential
// the hopper mints. Jobs then run every path this part covers: a sandbox the job asks for, a box step that reads the
// vault secret after a person grants the vault, a question answered, a failure, and the outbound webhook of each event.
// Then the whole database, the work dir, the job's files, the console, the event log, an SSE replay, the webhook bodies
// and the boxes' environment and argv are scanned: no canary is anywhere. A planted leak in each kind of place is found.
// The container runtime is a double at its port (its boxes run the real need box script under `sh`); OpenFGA is a
// double at its seam.
//
// Feature: a secret appears only where it is kept
//   Scenario: after a full job run, no canary is in any place the scan reads
//   Scenario: a leak planted in the database, a file, a gzip file and a log line is found, and each place is named
//     (in the database also as gzip in base64 text, as a checkpoint's row keeps it)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultView } from '../../src/domain/types.ts';
import { HOME } from '../../src/sandbox/flags.ts';
import { openDb } from '../../src/store/db.ts';
import { STEP_SCRIPT } from '../../src/windows-steps/script.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { boot, runningJob, skill, stopAll, type Booted, type Run } from '../support/read-only-check.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { canary, databasePlaces, filePlaces, formsOf, report, scan, type Place } from '../support/secret-canary.ts';
import { openSse } from '../support/sse.ts';
import { putAccount } from '../support/system-secrets.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

let logged: string[] = [];
const receivers: Receiver[] = [];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});
afterEach(async () => {
  await stopAll();
  for (const r of receivers.splice(0)) await r.close();
  vi.restoreAllMocks();
});

const HOST = 'auth.example.test:443';
const ASK = ['sandbox', '--why', 'Run the sign-in end-to-end test against the dev host', '--secrets', 'E2E_PASSWORD', '--egress', HOST, '--image', 'test'];

function step(b: Booted, creds: string, args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn('sh', [join(creds, 'step'), ...args], { cwd, env: { PATH: process.env.PATH, HOPPER_URL: b.a.url, HOPPER_TOKEN_FILE: join(creds, 'token'), TMPDIR: b.cloud.dir } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** A place of captured text. */
const captured = (name: string, value: unknown): Place => ({ name, text: typeof value === 'string' ? value : JSON.stringify(value) });

describe('the secret canary check (issue #1957)', () => {
  it('after a full job run, no canary is in any place the scan reads', async () => {
    const b = await boot([]);
    const { a, token } = b;
    // The need box's own home, where the vault copies the step's secrets: the box, not the hopper (issue #1875).
    const homeOf = (name: string): string => { const h = join(b.cloud.dir, 'boxes', `home-${name}`); mkdirSync(h, { recursive: true }); return h; };
    const run = b.cloud.runScript;
    b.runtime.runScript = (spec) => run({ ...spec, env: { ...spec.env, HOME: homeOf(spec.name) } });
    b.runtime.copyIn = async (id, dir, tar) => {
      const c = [...b.runtime.boxes.values()].find((x) => x.id === id)!;
      const to = dir.replace(HOME, homeOf(c.spec.name));
      mkdirSync(to, { recursive: true });
      execFileSync('tar', ['-xf', tar, '-C', to]);
    };

    const seeded = { vault: canary('vault'), access: canary('access'), refresh: canary('refresh'), webhook: canary('webhook') };
    const canaries: Record<string, string> = {
      'master key': KEY, 'vault secret': seeded.vault, 'account access token': seeded.access,
      'account refresh token': seeded.refresh, 'webhook signing secret': seeded.webhook,
    };
    putAccount(a.user().store, {
      provider: 'github', account: 'owner', subject: '1', connectedAt: '2026-10-07T00:00:00.000Z', grantedBy: 'device',
      accessToken: seeded.access, refreshToken: seeded.refresh, expiresAt: '2099-01-01T00:00:00.000Z',
    }, KEY);
    const rx = await startReceiver();
    receivers.push(rx);
    expect((await a.ui('/ui/api/webhooks', { action: 'add', name: 'canary', url: rx.url, events: ['*'], secret: seeded.webhook }, { token })).status).toBe(200);
    expect((await a.ui('/ui/api/vault', { action: 'set', name: 'E2E_PASSWORD', value: seeded.vault }, { token })).status).toBe(200);
    expect((await a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token })).status).toBe(200);

    // A job asks for a sandbox with the secret; a person approves its template and grants the job the vault.
    const creds = await runningJob(a);
    writeFileSync(join(creds, 'step'), STEP_SCRIPT, { mode: 0o700 });
    canaries['proxy token'] = readFileSync(join(creds, 'token'), 'utf8').trim();
    const jobId = a.user().store.jobs.list({ status: ['running'] }).at(-1)!.id;
    expect((await skill(a, creds, ASK)).code).not.toBe(0);
    const view = async () => (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body;
    const template = (await view()).templates.find((t) => t.name.startsWith('asked-'))!.name;
    expect((await a.ui('/ui/api/vault', { action: 'approve-template', name: template }, { token })).status).toBe(200);
    expect((await skill(a, creds, ASK)).code).toBe(0);
    expect((await a.ui(`/ui/api/jobs/${jobId}/grant-vault`, {}, { token })).status).toBe(200);

    // The box step reads the secret, echoes it and prints its environment: the hopper masks what comes back.
    const work = join(b.cloud.dir, 'seat-work');
    mkdirSync(work, { recursive: true });
    const read = await step(b, creds, ['box', template, '--command', 'v=$("$HOPPER_SECRET" get E2E_PASSWORD); echo "pw=$v"; echo "$v" >&2; env'], work);
    expect(read.code, read.stdout + read.stderr).toBe(0);
    expect(read.stdout).toContain('pw=***');

    // A question answered, and a failure.
    const asking = await a.pull({ op: 'ask', message: 'Which colour? This is hard.' });
    const q = await a.waitForQuestion(asking.id, (x) => x.tier === 'human' && x.status === 'open', 15_000);
    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token })).status).toBe(200);
    await a.waitForStatus(asking.id, 'finished');
    const failing = await a.pull({ op: 'fail', message: 'The build broke.' });
    await a.waitForStatus(failing.id, 'failed');
    await waitFor(() => rx.received.some((r) => r.body.includes(failing.id)), { what: 'the webhook of the failure' });

    const events = await a.events('limit=1000');
    const sse = await openSse(`${a.url}/api/events/stream`, { 'last-event-id': '0' });
    await waitFor(() => sse.messages.length >= events.length, { what: 'the SSE replay' });
    sse.close();
    const boxes = [...b.runtime.ran.values()];
    const places: Place[] = [
      ...databasePlaces(databaseUrlFor(a.dbPath)),
      ...filePlaces('work dir', a.dataDir),
      ...filePlaces('job files', join(b.cloud.dir, 'seat-work')),
      captured('console', logged.join('\n')),
      captured('event log', events),
      captured('SSE replay', sse.messages),
      captured('webhook deliveries', rx.received),
      captured('box step output', read),
      captured('box environment and argv', boxes),
    ];
    expect(places.filter((p) => p.name.startsWith('database ')).length).toBeGreaterThan(20);
    expect(report(scan(canaries, places))).toBe('');
    // The controls: the box got the vault secret (in its own home, where the vault copied it), webhooks went out, and the
    // replay is the event log.
    expect(scan({ vault: seeded.vault }, filePlaces('box', join(b.cloud.dir, 'boxes'))).length).toBeGreaterThan(0);
    expect(rx.received.length).toBeGreaterThan(5);
    // The job's own credentials hold its proxy token, and only that.
    const { 'proxy token': _minted, ...others } = canaries;
    expect(report(scan(others, filePlaces('job credentials', creds)))).toBe('');
  }, 90_000);

  it('a leak planted in the database, a file, a gzip file and a log line is found, each place named', async () => {
    const b = await boot([]);
    const planted = canary('planted'), packed = canary('packed');
    const user = openDb(ownerSchemaUrlFor(b.a.dbPath));
    try {
      user.exec('CREATE TABLE planted_leak (note text)');
      user.run('INSERT INTO planted_leak (note) VALUES (?)', `left here: ${planted}`);
      user.run('INSERT INTO planted_leak (note) VALUES (?)', gzipSync(`session ${packed}`).toString('base64'));
    } finally {
      user.close();
    }
    writeFileSync(join(b.a.dataDir, 'planted.log'), `token=${formsOf(planted).base64}\n`);
    writeFileSync(join(b.a.dataDir, 'planted.gz'), gzipSync(`checkpoint ${planted}`));
    console.warn(`url ${formsOf(planted)['url-encoded']}`);
    const found = scan({ planted, packed }, [...databasePlaces(databaseUrlFor(b.a.dbPath)), ...filePlaces('work dir', b.a.dataDir), captured('console', logged.join('\n'))]);
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({ place: expect.stringMatching(/^database .*_u_admin\.planted_leak$/), form: 'plain' }),
      expect.objectContaining({ canary: 'packed', place: expect.stringMatching(/^database .*_u_admin\.planted_leak$/), form: 'plain' }),
      { canary: 'planted', place: 'work dir planted.log', form: 'base64' },
      { canary: 'planted', place: 'work dir planted.gz', form: 'plain' },
      expect.objectContaining({ place: 'console', form: 'plain' }),
    ]));
    expect(report(found)).toMatch(/canary planted found in work dir planted\.log \(base64\)/);
  }, 60_000);
});
