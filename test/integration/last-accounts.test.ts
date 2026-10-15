// The last account (issue #1269, design.md "Last account") through the real daemon: the claude-plan usage source against a
// fake `claude` (never the real one) reads who the machine is signed in as; a sign-in's login names who it was last signed
// in as, or that none is known; a completed sign-in updates it; a restart keeps it; no token is kept or answered.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOT_SIGNED_IN, type LoginView, type QuestionView, type ToolAccount } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const FAKE_CLAUDE = join(import.meta.dirname, '..', 'plugins', 'fake-claude-plan.mjs');

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
const saved = process.env.FAKE_PLAN_DIR;
let control: string;

beforeEach(() => {
  control = mkdtempSync(join(tmpdir(), 'jh-fake-plan-'));
  process.env.FAKE_PLAN_DIR = control;
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
  if (saved === undefined) delete process.env.FAKE_PLAN_DIR; else process.env.FAKE_PLAN_DIR = saved;
});

async function boot(plugins: Record<string, unknown>) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, plugins });
  apps.push(a);
  return a;
}

const toolAccounts = async (a: TestApp) => (await a.api<{ accounts: ToolAccount[] }>('GET', '/api/tool-accounts')).body.accounts;

const pendingSignIn = async (a: TestApp, token: string) => {
  const r = await a.ui<LoginView>('/ui/api/tool-accounts/sign-in', { source: 'claude' }, { token });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ kind: 'paste_code', tool: 'claude', status: 'pending', machineId: 'local' });
  return r.body;
};

describe('the last account (issue #1269)', () => {
  it('the last account (issue #1269): a sign-in names who the machine was last signed in as, a completed one updates it, a restart keeps it; never a token', async () => {
    writeFileSync(join(control, 'email'), 'first@example.com');
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const plugins = { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] };
    const first = await startTestApp({ dbPath: db.dbPath, plugins });
    apps.push(first);
    // Read signed in, kept at a tick; then the session ends on the machine.
    await waitFor(() => first.user().store.lastAccounts.get('local', 'claude'), { what: 'the last account kept' });
    writeFileSync(join(control, 'mode'), 'logged-out');
    const token = await first.login();
    const login = await pendingSignIn(first, token);
    expect(login.lastAccount).toEqual({ machineId: 'local', service: 'claude', identity: 'first@example.com', organization: 'Example Org', capturedAt: expect.any(String) });

    // The person signs in as another account: once its source read it, the sign-in's login names it.
    writeFileSync(join(control, 'email'), 'second@example.com');
    writeFileSync(join(control, 'org'), 'Second Org');
    expect((await first.ui<LoginView>(`/ui/api/logins/${login.id}/code`, { code: 'good-code' }, { token })).body.status).toBe('completed');
    const updated = await waitFor(async () => {
      const l = (await first.api<LoginView>('GET', `/api/logins/${login.id}`)).body;
      return l.lastAccount?.identity === 'second@example.com' ? l : undefined;
    }, { what: 'the last account updated' });
    expect(updated.lastAccount).toMatchObject({ identity: 'second@example.com', organization: 'Second Org' });

    // Signed out again and restarted: the account is still known; the token the tool printed is nowhere.
    writeFileSync(join(control, 'mode'), 'logged-out');
    await first.stop();
    apps.splice(apps.indexOf(first), 1);
    const again = await startTestApp({ dbPath: db.dbPath, plugins });
    apps.push(again);
    await waitFor(async () => ((await toolAccounts(again))[0]?.login === 'signed-out' ? true : undefined), { what: 'the signed-out machine after the restart' });
    const after = await pendingSignIn(again, await again.login());
    expect(after.lastAccount).toMatchObject({ identity: 'second@example.com', organization: 'Second Org' });
    const listed = JSON.stringify((await again.api('GET', '/api/logins')).body);
    expect(listed).toContain('second@example.com');
    expect(listed).not.toContain('SECRET');
    expect(JSON.stringify(again.user().store.lastAccounts.get('local', 'claude'))).not.toContain('SECRET');
    expect(JSON.stringify(await again.events())).not.toContain('SECRET');
  });

  it('a sign-in on a machine never read signed in says no account is known there (issue #1269)', async () => {
    writeFileSync(join(control, 'mode'), 'logged-out');
    const a = await boot({ usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] });
    await waitFor(async () => ((await toolAccounts(a))[0]?.login === 'signed-out' ? true : undefined), { what: 'the signed-out machine' });
    expect((await pendingSignIn(a, await a.login())).lastAccount).toBeNull();
  });

  it('every Claude sign-in request names the last account: the signed-out machine on Accounts and a job\'s not-signed-in question (issue #1269)', async () => {
    writeFileSync(join(control, 'email'), 'first@example.com');
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const plugins = { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] };
    const first = await startTestApp({ dbPath: db.dbPath, plugins });
    await waitFor(() => first.user().store.lastAccounts.get('local', 'claude'), { what: 'the last account kept' });
    await first.stop();
    // The session ended on the machine; the hopper starts again and reads it signed out.
    writeFileSync(join(control, 'mode'), 'logged-out');
    const a = await startTestApp({ dbPath: db.dbPath, plugins });
    apps.push(a);
    const machine = await waitFor(async () => (await toolAccounts(a)).find((x) => x.login === 'signed-out')?.machines[0], { what: 'the signed-out machine' });
    expect(machine.lastAccount).toMatchObject({ machineId: 'local', service: 'claude', identity: 'first@example.com', organization: 'Example Org' });

    const held = await a.pull({ op: 'ask', message: `${NOT_SIGNED_IN}.\n\nA hard screen` });
    const other = await a.pull({ op: 'ask', message: 'Is this risky?' });
    const q = await a.waitForQuestion(held.id, (x) => x.tier === 'human');
    const asked = (await a.api<QuestionView>('GET', `/api/questions/${q.id}`)).body;
    expect(asked.lastAccount).toMatchObject({ identity: 'first@example.com', organization: 'Example Org' });
    const plain = await a.waitForQuestion(other.id, (x) => x.tier === 'human');
    expect((await a.api<QuestionView>('GET', `/api/questions/${plain.id}`)).body).not.toHaveProperty('lastAccount');
    const listed = JSON.stringify((await a.api('GET', '/api/questions')).body) + JSON.stringify(await toolAccounts(a));
    expect(listed).toContain('first@example.com');
    expect(listed).not.toContain('SECRET');
  });

  it('a machine never read signed in: its Accounts entry and its not-signed-in question say no account is known (issue #1269)', async () => {
    writeFileSync(join(control, 'mode'), 'logged-out');
    const a = await boot({ usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE } }] });
    const machine = await waitFor(async () => (await toolAccounts(a)).find((x) => x.login === 'signed-out')?.machines[0], { what: 'the signed-out machine' });
    expect(machine.lastAccount).toBeNull();
    const held = await a.pull({ op: 'ask', message: `${NOT_SIGNED_IN}.\n\nA hard screen` });
    const q = await a.waitForQuestion(held.id, (x) => x.tier === 'human');
    expect((await a.api<QuestionView>('GET', `/api/questions/${q.id}`)).body.lastAccount).toBeNull();
  });
});
