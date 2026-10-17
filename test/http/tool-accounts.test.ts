// Issue #1128: the tool accounts, from the usage sources' accounts — one entry per service and identity, the machines that use it,
// each machine's sign-in, when a job last started there, and the account's week windows. Machines signed in as nobody are one
// entry with no identity, beside the accounts.
import { describe, expect, it } from 'vitest';
import { toolAccountsOf } from '../../src/http/accounts.ts';
import type { Job, LastAccount, UsageReading, UsageSourceReport } from '../../src/domain/types.ts';

const signedIn = (name: string, machine: string, identity: string, extra: Partial<UsageSourceReport> = {}): UsageSourceReport => ({
  name, refreshedAt: '2026-10-14T10:00:00.000Z', accountReadAt: '2026-10-14T10:00:00.000Z',
  account: { service: 'claude', identity, detail: { plan: 'max', machine } }, ...extra,
});
const signedOut = (name: string, machine: string): UsageSourceReport => ({
  name, problem: 'usage unavailable: x', accountReadAt: '2026-10-14T10:01:00.000Z',
  account: { service: 'claude', detail: { machine }, problem: 'not logged in', signedOut: true },
});
const reading = (source: string, window: string, used: number, at: string, extra: Partial<UsageReading> = {}): UsageReading =>
  ({ source, window, used, limit: 100, unit: '%', at, resetsAt: '2026-10-16T09:00:00.000Z', ...extra });
const job = (id: string, laneId: string | undefined, executor: string, startedAt?: string): Job => ({
  id, spec: { executor, payload: {} }, priority: 50, status: 'finished', approved: true, createdAt: '2026-10-14T08:00:00.000Z',
  updatedAt: '2026-10-14T08:00:00.000Z', attempts: 1, ...(laneId ? { laneId } : {}), ...(startedAt ? { startedAt } : {}),
} as Job);

const labels = new Map([['m1', 'Desk'], ['m2', 'Laptop'], ['m3', 'Server']]);

describe('toolAccountsOf', () => {
  it('groups machines by service and identity; each machine says its sign-in, its source and when it was read', () => {
    const accounts = toolAccountsOf({
      sources: [signedIn('claude-m1', 'm1', 'a@example.com'), signedIn('claude-m2', 'm2', 'a@example.com'), signedIn('claude-m3', 'm3', 'b@example.com')],
      readings: [], labels, jobs: [],
    });
    expect(accounts.map((a) => [a.identity, a.login, a.machines.map((m) => [m.machineId, m.label, m.source, m.login])])).toEqual([
      ['a@example.com', 'signed-in', [['m1', 'Desk', 'claude-m1', 'signed-in'], ['m2', 'Laptop', 'claude-m2', 'signed-in']]],
      ['b@example.com', 'signed-in', [['m3', 'Server', 'claude-m3', 'signed-in']]],
    ]);
    expect(accounts[0]).toMatchObject({ service: 'claude', detail: { plan: 'max' } });
    expect(accounts[0]!.detail).not.toHaveProperty('machine');
    expect(accounts[0]!.machines[0]!.readAt).toBe('2026-10-14T10:00:00.000Z');
  });

  it('a signed-in machine carries when the tool says its sign-in ends; one that gives no time carries none (issue #1211)', () => {
    const ends = '2026-10-15T09:00:00.000Z';
    const [account] = toolAccountsOf({
      sources: [signedIn('claude-m1', 'm1', 'a@example.com', { account: { service: 'claude', identity: 'a@example.com', detail: { machine: 'm1' }, expiresAt: ends } }), signedIn('claude-m2', 'm2', 'a@example.com')],
      readings: [], labels, jobs: [],
    });
    expect(account!.machines.map((m) => [m.machineId, m.expiresAt])).toEqual([['m1', ends], ['m2', undefined]]);
  });

  it('machines signed in as nobody are one entry with no identity and their reason; a source with no account yet is left out', () => {
    const accounts = toolAccountsOf({
      sources: [signedIn('claude-m1', 'm1', 'a@example.com'), signedOut('claude-m2', 'm2'), signedOut('claude-m3', 'm3'), { name: 'claude-new', problem: 'not read yet' }],
      readings: [], labels, jobs: [],
    });
    expect(accounts).toHaveLength(2);
    expect(accounts[1]).toMatchObject({ service: 'claude', login: 'signed-out', detail: {}, machines: [
      { machineId: 'm2', login: 'signed-out', problem: 'not logged in' }, { machineId: 'm3', login: 'signed-out', problem: 'not logged in' },
    ] });
    expect(accounts[1]).not.toHaveProperty('identity');
  });

  it('a machine not signed in names who it was last signed in as, or null when none is known; a signed-in one names none (issue #1269)', () => {
    const kept: LastAccount = { machineId: 'm2', service: 'claude', identity: 'old@example.com', organization: 'Example Org', capturedAt: '2026-10-13T10:00:00.000Z' };
    const accounts = toolAccountsOf({
      sources: [signedIn('claude-m1', 'm1', 'a@example.com'), signedOut('claude-m2', 'm2'), signedOut('claude-m3', 'm3')],
      readings: [], labels, jobs: [], lastAccount: (machineId, service) => (machineId === 'm2' && service === 'claude' ? kept : null),
    });
    expect(accounts[0]!.machines[0]).not.toHaveProperty('lastAccount');
    expect(accounts[1]!.machines.map((m) => [m.machineId, m.lastAccount])).toEqual([['m2', kept], ['m3', null]]);
  });

  it('a machine whose tool could not be read is not known, apart from the machines signed out', () => {
    const failed: UsageSourceReport = { name: 'claude-m3', account: { service: 'claude', detail: { machine: 'm3' }, problem: 'machine m3: client m3 is not dialled in' } };
    const accounts = toolAccountsOf({ sources: [signedOut('claude-m2', 'm2'), failed], readings: [], labels, jobs: [] });
    expect(accounts.map((a) => [a.login, a.machines.map((m) => m.problem)])).toEqual([
      ['signed-out', ['not logged in']], ['unknown', ['machine m3: client m3 is not dialled in']],
    ]);
  });

  it('last used: the latest start of a job of the source\'s executors on the machine; the account\'s is its machines\' latest', () => {
    const accounts = toolAccountsOf({
      sources: [signedIn('claude-m1', 'm1', 'a@example.com', { executors: ['claude'] }), signedIn('claude-m2', 'm2', 'a@example.com')],
      readings: [], labels,
      jobs: [
        job('j1', 'm1/lane-1', 'claude', '2026-10-14T09:00:00.000Z'),
        job('j2', 'm1/lane-2', 'codex', '2026-10-14T09:30:00.000Z'), // not an executor of the source
        job('j3', 'm2/lane-1', 'codex', '2026-10-14T08:00:00.000Z'), // the source names none: every job
        job('j4', 'm1/lane-1', 'claude'), // never started
      ],
    });
    expect(accounts[0]!.machines.map((m) => m.lastUsedAt)).toEqual(['2026-10-14T09:00:00.000Z', '2026-10-14T08:00:00.000Z']);
    expect(accounts[0]!.lastUsedAt).toBe('2026-10-14T09:00:00.000Z');
  });

  it('spend: the account\'s week windows, the newest reading of each over its machines, throttling ones first; no session window', () => {
    const accounts = toolAccountsOf({
      sources: [signedIn('claude-m1', 'm1', 'a@example.com'), signedIn('claude-m2', 'm2', 'a@example.com'), signedIn('claude-m3', 'm3', 'b@example.com')],
      readings: [
        reading('claude-m1', 'week (Fable)', 90, '2026-10-14T10:00:00.000Z', { informational: true }),
        reading('claude-m1', 'session', 50, '2026-10-14T10:00:00.000Z'),
        reading('claude-m1', 'week', 30, '2026-10-14T09:00:00.000Z'),
        reading('claude-m2', 'week', 35, '2026-10-14T10:00:00.000Z'),
        reading('claude-m3', 'week', 70, '2026-10-14T10:00:00.000Z'),
      ],
      labels, jobs: [],
    });
    expect(accounts[0]!.spend.map((r) => [r.window, r.used])).toEqual([['week', 35], ['week (Fable)', 90]]);
    expect(accounts[1]!.spend.map((r) => [r.window, r.used])).toEqual([['week', 70]]);
  });

  it('a machine not configured now is named by its id', () => {
    const [a] = toolAccountsOf({ sources: [signedIn('claude-x', 'gone', 'a@example.com')], readings: [], labels, jobs: [] });
    expect(a!.machines[0]!.label).toBe('gone');
  });
});

describe('toolAccountsOf: infra credentials (issue #1128 part 7)', () => {
  it('each machine carries the infra credential folders its machine holds; a machine with none or not read carries none', () => {
    const accounts = toolAccountsOf({
      sources: [signedIn('claude-m1', 'm1', 'a@example.com'), signedIn('claude-m2', 'm2', 'a@example.com'), signedIn('claude-m3', 'm3', 'a@example.com')],
      readings: [], labels, jobs: [], infraCredentials: new Map([['m1', ['.aws', '.terraform.d']], ['m2', []]]),
    });
    expect(accounts[0]!.machines.map((m) => [m.machineId, m.infraCredentials])).toEqual([['m1', ['.aws', '.terraform.d']], ['m2', undefined], ['m3', undefined]]);
  });
});
