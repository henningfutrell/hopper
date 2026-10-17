// The hopper's Claude sign-in for pods (issue #1287, design.md "The hopper's Claude sign-in for pods"), through the real
// daemon: an admin names the Claude account and starts it; the hopper runs `claude setup-token` in a pseudo-terminal (the
// fake claude, a real pty); the Logins page shows the URL and the account; one paste of the page's code, and the token it
// printed is the user's vault secret CLAUDE_TOKEN, its scope naming the account, which a job pod and a lane pod then start
// with. The token is in no answer, event or log line.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginView, VaultView } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const CLAUDE = join(import.meta.dirname, '..', 'logins', 'fake-claude-setup-token.mjs');
const TOKEN = 'sk-ant-oat01-FakeSetupToken_0123456789abcdefABCDEF-xyz';
const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&state=fake-state';
const START = '/ui/api/logins/claude-setup-token';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
let control: string;
let logged: string[] = [];

beforeEach(() => {
  control = mkdtempSync(join(tmpdir(), 'jh-setup-token-it-'));
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
  rmSync(control, { recursive: true, force: true });
});

async function boot(db = tempDbPath()): Promise<TestApp> {
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, seams: { setupToken: { file: CLAUDE, env: { FAKE_SETUP_DIR: control } } } });
  apps.push(a);
  return a;
}

const read = async (a: TestApp, id: string, token: string) => (await a.api<LoginView>('GET', `/api/logins/${id}`, undefined, { 'x-hopper-session': token })).body;

describe('the hopper\'s Claude sign-in for pods (issue #1287)', () => {
  it('one paste on the Logins page keeps the token as CLAUDE_TOKEN, naming the account; pods then start with it', async () => {
    const a = await boot();
    const token = await a.login();
    const started = await a.ui<LoginView>(START, { account: 'pods@example.com' }, { token });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ kind: 'paste_code', tool: 'claude setup-token', status: 'pending', run: 'sign-in', renewable: false, host: 'claude.com' });
    expect(started.body.machineId).toBeUndefined();
    expect(started.body.verificationUrl).toBeUndefined();
    // The sign-in request names the account, and gives the URL, to a UI session of the user.
    expect(await read(a, started.body.id, token)).toMatchObject({ verificationUrl: URL, account: 'pods@example.com', codeKept: true });

    const done = await a.ui<LoginView>(`/ui/api/logins/${started.body.id}/code`, { code: 'good-code' }, { token });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id: started.body.id, status: 'completed' });

    const vault = (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body;
    expect(vault.secrets.find((s) => s.name === 'CLAUDE_TOKEN')).toMatchObject({ scope: 'Claude account pods@example.com' });
    // A new job pod and a lane pod (after a restart too) get it from the vault, as they do since parts 1 to 3.
    expect(await a.user().vault.podCredential({ name: 'CLAUDE_TOKEN', pod: 'hopper-job-1' })).toEqual({ name: 'CLAUDE_TOKEN', value: TOKEN });

    const calls = readFileSync(join(control, 'calls.jsonl'), 'utf8');
    expect(calls).toContain('"tty":true');
    const events = JSON.stringify(await a.events());
    expect(events).not.toContain(TOKEN);
    expect(events).not.toContain('good-code');
    expect(events).toContain('vault.secret_set');
    expect(JSON.stringify(vault)).not.toContain(TOKEN);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('a second sign-in replaces the token and the account; a wrong code fails the login and keeps the one before', async () => {
    const a = await boot();
    const token = await a.login();
    const first = (await a.ui<LoginView>(START, { account: 'one@example.com' }, { token })).body;
    expect((await a.ui<LoginView>(`/ui/api/logins/${first.id}/code`, { code: 'good-code' }, { token })).body.status).toBe('completed');

    const bad = (await a.ui<LoginView>(START, { account: 'two@example.com' }, { token })).body;
    const failed = await a.ui<LoginView>(`/ui/api/logins/${bad.id}/code`, { code: 'wrong-code' }, { token });
    expect(failed.body).toMatchObject({ status: 'failed', reason: expect.stringContaining('OAuth error') });
    let vault = (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body;
    expect(vault.secrets.find((s) => s.name === 'CLAUDE_TOKEN')).toMatchObject({ scope: 'Claude account one@example.com' });

    const second = (await a.ui<LoginView>(START, { account: 'two@example.com' }, { token })).body;
    expect((await a.ui<LoginView>(`/ui/api/logins/${second.id}/code`, { code: 'good-code' }, { token })).body.status).toBe('completed');
    vault = (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body;
    expect(vault.secrets.filter((s) => s.name === 'CLAUDE_TOKEN')).toEqual([expect.objectContaining({ scope: 'Claude account two@example.com' })]);
  });

  it('a stop between the token and the CLI\'s end loses no token: it is in the vault after the start (issue #1610)', async () => {
    writeFileSync(join(control, 'linger'), '');
    const db = tempDbPath();
    const a = await boot(db);
    const token = await a.login();
    const started = (await a.ui<LoginView>(START, { account: 'pods@example.com' }, { token })).body;
    // The code is given; the CLI prints the token and does not end.
    void a.ui(`/ui/api/logins/${started.id}/code`, { code: 'good-code' }, { token }).catch(() => undefined);
    const kept = async () => (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body.secrets.find((s) => s.name === 'CLAUDE_TOKEN');
    for (let i = 0; i < 100 && !(await kept()); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await kept()).toMatchObject({ scope: 'Claude account pods@example.com' });
    expect((await read(a, started.id, token)).status).toBe('pending');
    await a.stop();
    apps.splice(apps.indexOf(a), 1);

    const b = await boot(db);
    expect(await b.user().vault.podCredential({ name: 'CLAUDE_TOKEN', pod: 'hopper-job-1' })).toEqual({ name: 'CLAUDE_TOKEN', value: TOKEN });
  });

  it('the account must be an email; a new sign-in cancels the one before; only an admin starts one', async () => {
    const a = await boot();
    const token = await a.login();
    expect((await a.ui(START, {}, { token })).status).toBe(400);
    expect((await a.ui(START, { account: '--help' }, { token })).status).toBe(400);
    const first = (await a.ui<LoginView>(START, { account: 'one@example.com' }, { token })).body;
    await a.ui<LoginView>(START, { account: 'one@example.com' }, { token });
    expect((await read(a, first.id, token)).status).toBe('cancelled');
    expect((await a.ui(START, { account: 'one@example.com' })).status).toBe(403);
  });
});
