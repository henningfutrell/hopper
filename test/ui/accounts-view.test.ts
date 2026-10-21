// @vitest-environment happy-dom
// The Accounts view (issue #1128), rendered against a fake of the daemon's HTTP: a card per tool account — the service and identity,
// its plan, the machines signed in as it with their sign-in, when each was read and last ran a job, and its week windows —, and one
// for the machines signed in as nobody, with why. The model: how an account and a machine are written, and the badge's count.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolAccount, ToolAccountMachine, ToolAccountsReport } from '../../src/domain/types.ts';
import { accountTitle, machineLine, signedOutLines, signedOutMachines } from '../../ui/src/model/tool-accounts.ts';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const at = (m: number) => new Date(NOW - m * 60_000).toISOString();

const SIGNED_IN: ToolAccount = {
  service: 'claude', identity: 'a@example.com', detail: { plan: 'max', organization: 'Example Org' }, login: 'signed-in', lastUsedAt: at(30),
  machines: [
    { machineId: 'm1', label: 'Desk', source: 'claude-desk', login: 'signed-in', readAt: at(5), lastUsedAt: at(30) },
    { machineId: 'm2', label: 'Laptop', source: 'claude-laptop', login: 'signed-in', readAt: at(2) },
  ],
  spend: [{ source: 'claude-desk', window: 'week', used: 40, limit: 100, unit: '%', resetsAt: '2026-10-16T09:00:00.000Z', at: at(5) }],
};
const SIGNED_OUT: ToolAccount = {
  service: 'claude', detail: {}, login: 'signed-out', spend: [],
  machines: [{ machineId: 'm3', label: 'Server', source: 'claude-server', login: 'signed-out', problem: 'not logged in', readAt: at(1), signIn: true }],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let posts: { path: string; body: unknown }[] = [];

async function render(report: ToolAccountsReport, role: 'viewer' | 'operator' = 'viewer') {
  posts = [];
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (String(url).startsWith('/ui/api/')) { posts.push({ path: String(url), body: JSON.parse(String(init.body)) }); return json({ id: 'l9', status: 'pending' }); }
    if (String(url).startsWith('/api/logins')) return json({ now: new Date(NOW).toISOString(), settings: { onExpiry: 'renew', warnSec: 60 }, logins: [] });
    return String(url).startsWith('/api/tool-accounts') ? json(report) : json({ error: 'not found' }, 404);
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const store = '../../ui/src/store/index.ts';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, serverOffsetMs: 0, user: { id: 'u1', name: 'ada', role, realm: 'github', identity: 'ada' } });
  const view = '../../ui/src/views/accounts.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { Accounts } = (await import(view)) as { Accounts: () => El };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(Accounts)); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const cards = () => document.querySelectorAll('[data-slot="tool-account"]');
const machines = () => [...document.querySelectorAll('[data-slot="tool-account-machine"]')].map((r) => r.textContent ?? '');

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
  localStorage.clear();
});

describe('the Accounts view', () => {
  it('a card per tool account: identity, plan, each machine signed in as it with when it was read and last used, and its week window', async () => {
    await render({ accounts: [SIGNED_IN, SIGNED_OUT] });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Claude · a@example.com');
    expect(text).toContain('max');
    expect(text).toContain('Example Org');
    const [desk, laptop, server] = machines();
    expect(desk).toContain('Desk');
    expect(desk).toContain('signed in');
    expect(desk).toContain('read 5m ago · last used 30m ago');
    expect(laptop).toContain('no job yet');
    expect(server).toContain('Server');
    expect(server).toContain('signed out');
    expect(server).toContain('not logged in');
    expect(document.querySelector('[data-slot="tool-account-spend"]')?.textContent).toContain('week');
    expect(text).toContain('Claude · signed in as nobody');
    expect(cards()).toHaveLength(2);
  });

  it('Sign in (issue #1128): an operator starts the tool\'s sign-in on a machine whose source can, then goes to Logins; a viewer has no button', async () => {
    await render({ accounts: [SIGNED_IN, SIGNED_OUT] });
    expect(document.querySelector('[data-sign-in]')).toBeNull();
    await act(async () => { root?.unmount(); });
    vi.resetModules();
    await render({ accounts: [SIGNED_IN, SIGNED_OUT] }, 'operator');
    const buttons = document.querySelectorAll<HTMLButtonElement>('[data-sign-in]');
    expect([...buttons].map((b) => [b.getAttribute('data-sign-in'), b.textContent])).toEqual([['claude-server', 'Sign in']]);
    await act(async () => { buttons[0]!.click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(posts).toEqual([{ path: '/ui/api/tool-accounts/sign-in', body: { source: 'claude-server' } }]);
    expect(window.location.hash).toBe('#machines/logins');
  });

  it('a machine signed in as nobody names who it was last signed in as, or that none is known there (issue #1269)', async () => {
    const out = (lastAccount: ToolAccountMachine['lastAccount']): ToolAccount => ({ ...SIGNED_OUT, machines: [{ ...SIGNED_OUT.machines[0]!, lastAccount }] });
    await render({ accounts: [SIGNED_IN, out({ machineId: 'm3', service: 'claude', identity: 'old@example.com', organization: 'Example Org', capturedAt: at(600) })] });
    const lines = () => [...document.querySelectorAll('[data-slot="last-account"]')].map((e) => e.textContent);
    expect(lines()).toEqual(['Last signed in as old@example.com (Example Org) on Server']);
    await act(async () => { root?.unmount(); });
    vi.resetModules();
    await render({ accounts: [out(null)] });
    expect(lines()).toEqual(['No previous account known for this machine (Server)']);
  });

  it('a machine whose home holds infra credential folders is flagged with their names (issue #1128 part 7)', async () => {
    const flagged: ToolAccount = { ...SIGNED_IN, machines: [{ ...SIGNED_IN.machines[0]!, infraCredentials: ['.aws', '.keycloak'] }, SIGNED_IN.machines[1]!] };
    await render({ accounts: [flagged] });
    const [desk, laptop] = machines();
    expect(desk).toContain('its job user holds credentials a job could use: .aws, .keycloak');
    expect(laptop).not.toContain('its job user holds');
  });

  it('no tool account: says where to add a usage source', async () => {
    await render({ accounts: [] });
    expect(document.body.textContent).toContain('no usage source reads a tool account yet');
  });
});

describe('the Accounts model', () => {
  it('an account is titled by its service and identity, or says its machines are signed in as nobody or not known', () => {
    expect(accountTitle(SIGNED_IN)).toBe('Claude · a@example.com');
    expect(accountTitle(SIGNED_OUT)).toBe('Claude · signed in as nobody');
    expect(accountTitle({ service: 'codex', login: 'unknown' })).toBe('codex · sign-in not known');
  });

  it('a machine says when it was read and last ran a job', () => {
    expect(machineLine({}, NOW)).toBe('not read yet · no job yet');
  });

  it('the badge counts the machines signed in as nobody', () => {
    expect(signedOutMachines([SIGNED_IN, SIGNED_OUT])).toBe(1);
    expect(signedOutMachines([SIGNED_IN])).toBe(0);
  });

  it('Needs you names each machine signed in as nobody, by its tool and label (issue #1128)', () => {
    expect(signedOutLines([SIGNED_IN, SIGNED_OUT], NOW)).toEqual(['Claude on Server: signed in as nobody — sign it in from Accounts']);
    expect(signedOutLines([SIGNED_IN], NOW)).toEqual([]);
  });

  it('Needs you names a sign-in the tool says ends within a day, and one that has ended (issue #1211)', () => {
    const ends = (m: number): ToolAccount => ({ ...SIGNED_IN, machines: [{ ...SIGNED_IN.machines[0]!, expiresAt: new Date(NOW + m * 60_000).toISOString() }] });
    expect(signedOutLines([ends(90)], NOW)).toEqual(['Claude on Desk: its sign-in ends in 1h 30m — sign it in again from Accounts']);
    expect(signedOutLines([ends(-5)], NOW)).toEqual(['Claude on Desk: its sign-in has ended — sign it in again from Accounts']);
    expect(signedOutLines([ends(25 * 60)], NOW)).toEqual([]);
  });
});
