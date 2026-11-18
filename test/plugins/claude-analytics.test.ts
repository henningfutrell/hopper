// The built-in usage source `claude-analytics` (issue #2966, design.md "Daily usage from the Analytics API"): Claude
// Enterprise accounts' daily usage from the Analytics API, with the user's analytics key. Informational: no reading,
// never unknown usage. Against a fake Analytics API on loopback (fake-claude-analytics.ts); never a real URL.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unreadUsageOf } from '../../src/decider/usage.ts';
import { systemBackendRefusal, systemSecretKind } from '../../src/domain/vault.ts';
import type { UsageSource } from '../../src/domain/ports.ts';
import type { Account } from '../../src/domain/types.ts';
import { optionsJsonSchema, parseOptions } from '../../src/plugins/options.ts';
import claudeAnalytics, { NOT_CONFIGURED } from '../../src/plugins/usage-source/claude-analytics/index.ts';
import { analyticsContext } from '../../src/users/analytics-key.ts';
import { waitFor } from '../support/wait.ts';
import { fakeUser, startFakeAnalytics, type FakeAnalytics } from './fake-claude-analytics.ts';
import { fakeKit } from './support.ts';

const claude = (identity: string, over: Partial<Account> = {}): Account => ({ service: 'claude', identity, detail: { plan: 'enterprise', machine: 'm' }, ...over });

describe('claude-analytics usage source', () => {
  let api: FakeAnalytics;
  let now: Date;
  let key: string | undefined;
  let keyThrows: Error | undefined;
  let accounts: Account[];
  let kept: unknown[];
  const sources: UsageSource[] = [];

  beforeEach(async () => {
    api = await startFakeAnalytics();
    api.users = [fakeUser('user_a', 'Dev.A@example.com'), fakeUser('user_other', 'someone.else@example.com', { cents: '7777.000000' }), fakeUser('user_b', 'dev.b@example.com', { cents: '20.000000', sessions: 1 })];
    now = new Date('2026-10-03T17:00:00.000Z');
    key = api.key;
    keyThrows = undefined;
    accounts = [claude('dev.a@example.com'), claude('dev.b@example.com'), claude('alias@example.com')];
    kept = [];
  });
  afterEach(async () => {
    for (const s of sources.splice(0)) s.stop?.();
    await api.close();
  });

  const ctx = () => ({
    clock: { now: () => now }, logger: { info() {}, warn() {} }, dataDir: '/nowhere', userEnv: {}, secretName: (n: string) => n, scratchDir: '/nowhere',
    instanceName: 'analytics', env: () => undefined, machine: async () => undefined, machines: async () => [], client: () => undefined,
    analytics: { key: () => { if (keyThrows) throw keyThrows; return key; }, accounts: () => accounts, keep: (r: unknown) => { kept.push(r); } },
  });
  function create(raw: Record<string, unknown> = {}): UsageSource {
    const p = parseOptions(claudeAnalytics, { baseUrl: api.url, ...raw });
    if (!p.ok) throw new Error(p.error);
    const s = claudeAnalytics.create(ctx(), p.options as never) as UsageSource;
    sources.push(s);
    return s;
  }
  const settled = (s: UsageSource) => waitFor(() => { const st = s.state!(); return st.problem !== 'not read yet' && (st.daily || st.problem || st.notConfigured) ? st : undefined; }, { what: 'the first read' });
  const unread = async (s: UsageSource) => unreadUsageOf([{ name: s.name, readings: await s.poll(), state: s.state!() }]);

  it('is a usage source; baseUrl is command-bearing, the Claude API by default; reads every 6 hours at most once an hour; detection never calls the API', async () => {
    expect(claudeAnalytics).toMatchObject({ id: 'claude-analytics', role: 'usage-source' });
    expect(parseOptions(claudeAnalytics, {})).toEqual({ ok: true, options: { baseUrl: 'https://api.anthropic.com', intervalSeconds: 21600 } });
    expect(parseOptions(claudeAnalytics, { intervalSeconds: 600 }).ok).toBe(false);
    const schema = optionsJsonSchema(claudeAnalytics) as { properties: Record<string, { commandBearing?: boolean }> };
    expect(schema.properties.baseUrl!.commandBearing).toBe(true);
    expect(await claudeAnalytics.detect(fakeKit(), { baseUrl: api.url, intervalSeconds: 21600 })).toMatchObject({ status: 'available' });
    expect(api.seen).toEqual([]);
  });

  it('with no key: "analytics key not configured", a state and not a problem; no call; its usage is not unknown', async () => {
    key = undefined;
    const s = create();
    const st = await settled(s);
    expect(st).toEqual({ notConfigured: NOT_CONFIGURED, informational: true });
    expect(NOT_CONFIGURED).toMatch(/^analytics key not configured: .*read:analytics.*Organization settings → API.*Usage$/);
    expect(await s.poll()).toEqual([]);
    expect(await unread(s)).toEqual([]);
    expect(api.seen).toEqual([]);
  });

  it('reads yesterday: each account matched by email, its cost, tokens and Claude Code activity; an account no user matched is said', async () => {
    const s = create();
    const st = await settled(s);
    expect(st.problem).toBeUndefined();
    expect(st.informational).toBe(true);
    const tokens = { input: 100000, output: 35000, cacheRead: 10000, cacheCreation: 5000 };
    expect(st.daily).toEqual({
      date: '2026-10-02',
      days: [
        { account: 'dev.a@example.com', date: '2026-10-02', costCents: 113.75, tokens, sessions: 5, commits: 12, pullRequests: 2, linesAdded: 1543, linesRemoved: 892, toolActions: { accepted: 53, rejected: 6 } },
        { account: 'dev.b@example.com', date: '2026-10-02', costCents: 20.25, tokens, sessions: 1, commits: 12, pullRequests: 2, linesAdded: 1543, linesRemoved: 892, toolActions: { accepted: 53, rejected: 6 } },
      ],
      unmatched: ['alias@example.com'],
    });
    // Another user's row is dropped as it is read: no email, id, name or cost of theirs is kept.
    const shown = JSON.stringify(st);
    for (const other of ['someone.else', 'user_other', 'user_a', 'Name of', '7777', '999']) expect(shown).not.toContain(other);
    // No reading: it never throttles or caps a lane, and its usage is never unknown.
    expect(await s.poll()).toEqual([]);
    expect(await unread(s)).toEqual([]);
    // Each read is kept for the trend (part 4): the same read, so the table holds only the matched accounts' counts.
    expect(kept).toEqual([st.daily]);
  });

  it('asks the API as its docs say: the key, the version, the beta on cost and usage only; one day; only the matched users\' Claude Code cost and tokens', async () => {
    const s = create();
    await settled(s);
    expect(api.seen.map((x) => x.path)).toEqual(['/v1/organizations/analytics/users', '/v1/organizations/analytics/cost', '/v1/organizations/analytics/usage']);
    for (const x of api.seen) expect(x.headers).toMatchObject({ 'x-api-key': api.key, 'anthropic-version': '2026-10-21' });
    const [users, cost, usage] = api.seen as [typeof api.seen[0], typeof api.seen[0], typeof api.seen[0]];
    expect(users.headers['anthropic-beta']).toBeUndefined();
    expect(Object.fromEntries(users.query)).toEqual({ date: '2026-10-02', limit: '1000' });
    for (const x of [cost, usage]) {
      expect(x.headers['anthropic-beta']).toBe('analytics-usage-cost-2026-08-24');
      expect(x.query.get('starting_at')).toBe('2026-10-02T00:00:00Z');
      expect(x.query.get('ending_at')).toBe('2026-10-03T00:00:00Z');
      expect(x.query.getAll('group_by[]')).toEqual(['actor']);
      expect(x.query.getAll('actor_types[]')).toEqual(['user_actor']);
      expect(x.query.getAll('products[]')).toEqual(['claude_code']);
      expect(x.query.getAll('actor_ids[]')).toEqual(['user_a', 'user_b']);
    }
  });

  it('a day the API has not made yet: the newest day its 400 names, once', async () => {
    api.newestDay = '2026-10-01';
    const s = create();
    const st = await settled(s);
    expect(st.problem).toBeUndefined();
    expect(st.daily?.date).toBe('2026-10-01');
    expect(st.daily?.days.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-01']);
    expect(api.seen.filter((x) => x.path.endsWith('/users')).map((x) => x.query.get('date'))).toEqual(['2026-10-02', '2026-10-01']);
    expect(api.seen.find((x) => x.path.endsWith('/cost'))!.query.get('starting_at')).toBe('2026-10-01T00:00:00Z');
  });

  it('reads every page of the users', async () => {
    api.pageSize = 1;
    const s = create();
    const st = await settled(s);
    expect(st.daily?.days.map((d) => d.account)).toEqual(['dev.a@example.com', 'dev.b@example.com']);
    expect(api.seen.filter((x) => x.path.endsWith('/users')).map((x) => x.query.get('page'))).toEqual([null, '1', '2']);
  });

  it('a key the API refuses is a problem that names the status, never the key; still informational, so its usage is not unknown', async () => {
    key = 'sk-ant-wrong-key-0123456789';
    const s = create();
    const st = await settled(s);
    expect(st.problem).toBe('the Analytics API refused the analytics key (HTTP 401): invalid x-api-key');
    expect(JSON.stringify(st)).not.toContain('wrong-key');
    expect(await unread(s)).toEqual([]);
  });

  it('an API error says the endpoint, the status and the API\'s message, with a key in it masked', async () => {
    api.fail = { status: 500, body: { type: 'error', error: { message: 'overloaded for sk-ant-admin01-secretpart' } } };
    const s = create();
    const st = await settled(s);
    expect(st.problem).toBe('Analytics API /v1/organizations/analytics/users: HTTP 500: overloaded for sk-ant-…');
  });

  it('a key that cannot be opened is a problem', async () => {
    keyThrows = new Error('sealed under a key the runtime does not give: set HOPPER_MASTER_KEY');
    const s = create();
    expect((await settled(s)).problem).toBe('the analytics key cannot be opened: sealed under a key the runtime does not give: set HOPPER_MASTER_KEY');
  });

  it('a key set after start, or an account read after start, is read within a minute, not an interval later', async () => {
    key = undefined;
    accounts = [];
    const s = create();
    await settled(s);
    key = api.key;
    now = new Date(now.getTime() + 31_000);
    await s.poll();
    await waitFor(() => (s.state!().notConfigured ? undefined : true), { what: 'the key read' });
    expect(api.seen).toEqual([]);
    accounts = [claude('dev.b@example.com')];
    now = new Date(now.getTime() + 31_000);
    await waitFor(async () => { await s.poll(); return s.state!().daily; }, { what: 'the daily read' });
    expect(s.state!().daily?.days.map((d) => d.account)).toEqual(['dev.b@example.com']);
  });
});

describe('analyticsContext', () => {
  const source = (account?: Account): UsageSource => ({ name: 'x', poll: async () => [], state: () => (account ? { account } : {}) });

  it('opens the user\'s system secret claude-analytics-key; the accounts are the Claude accounts read signed in, one per email', () => {
    const opened: string[] = [];
    const c = analyticsContext({ open: (name, purpose) => { opened.push(`${name} for ${purpose}`); return 'k'; } }, () => [
      source(claude('a@example.com')), source(claude('A@example.com', { detail: { machine: 'n' } })), source(claude('gone@example.com', { signedOut: true })),
      source({ service: 'codex', identity: 'c@example.com', detail: {} }), source({ service: 'claude', detail: {} }), source(),
    ]);
    expect(c.key()).toBe('k');
    expect(opened).toEqual(['claude-analytics-key for the claude-analytics usage source']);
    expect(c.accounts().map((a) => a.identity)).toEqual(['a@example.com']);
  });

  it('the analytics key is a system secret of its own kind, kept in the hopper: never in a vault backend', () => {
    expect(systemSecretKind('claude-analytics-key')).toBe('claude-analytics');
    expect(systemBackendRefusal('claude-analytics-key')).toContain('stays in the hopper');
  });
});
