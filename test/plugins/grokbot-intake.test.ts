// The Grok Bot routine tells the owner when intake stops (issue #358): besides a question that reaches
// the human, it posts `source.stalled` (a source in error past the stall threshold) and
// `connected_account.expired` (a connected account whose sign-in ended). A loopback receiver.
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { createGrokBotNotifier } from '../../src/plugins/notifier/grokbot-routine/notifier.ts';
import { waitFor } from '../support/wait.ts';

let server: Server | undefined;
afterEach(async () => {
  const s = server;
  if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  server = undefined;
});

async function receiver(): Promise<{ url: string; hits: Record<string, unknown>[] }> {
  const hits: Record<string, unknown>[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { hits.push(JSON.parse(raw) as Record<string, unknown>); res.end(); });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/routine`, hits };
}

const event = (type: DomainEvent['type'], data: Record<string, unknown>): DomainEvent =>
  ({ seq: 1, schemaVersion: 1, id: 'e1', type, at: '2026-10-07T20:44:00.000Z', data });

describe('Grok Bot routine: intake stopped', () => {
  it('posts source.stalled and connected_account.expired', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    const send = (e: DomainEvent) => { for (const l of listeners) l(e); };
    send(event('source.stalled', { source: 'github-account', kind: 'github-account', error: 'GitHub refused the token', since: '2026-10-07T20:14:00.000Z' }));
    send(event('connected_account.expired', { provider: 'github', account: 'octo-user', reason: 'GitHub refused the refresh token' }));
    await waitFor(() => r.hits.length === 2, { what: 'two posts' });
    await n.stop();
    expect(r.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'hopper', kind: 'source.stalled', sourceName: 'github-account', error: 'GitHub refused the token', since: '2026-10-07T20:14:00.000Z' }),
      expect.objectContaining({ source: 'hopper', kind: 'connected_account.expired', provider: 'github', account: 'octo-user', reason: 'GitHub refused the refresh token' }),
    ]));
  });

  it('posts source.request_opened (issue #798): a request card waits for a person to approve it', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    const key = 'https://github.com/octocat/hello/issues/7';
    for (const l of listeners) l(event('source.request_opened', { source: 'github-account', key, hash: 'a'.repeat(64), author: 'helper[bot]', why: ['written by an app or a bot (helper[bot])'] }));
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    await n.stop();
    expect(r.hits[0]).toEqual(expect.objectContaining({
      source: 'hopper', kind: 'source.request_opened', sourceName: 'github-account', issueUrl: key, author: 'helper[bot]', why: ['written by an app or a bot (helper[bot])'],
    }));
  });

  it('posts connected_account.new_repositories_asked (issue #2795): a new repository waits for a person in Sources', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    for (const l of listeners) {
      l(event('connected_account.new_repositories_accepted', { provider: 'github', account: 'octo-user', repositories: ['octocat/api'] }));
      l(event('connected_account.new_repositories_asked', { provider: 'github', account: 'octo-user', repositories: ['octocat/web'] }));
    }
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    await n.stop();
    expect(r.hits).toEqual([expect.objectContaining({ source: 'hopper', kind: 'connected_account.new_repositories_asked', provider: 'github', account: 'octo-user', repositories: ['octocat/web'] })]);
  });

  it('posts infra.out_of_band_recorded (issue #871): an out-of-band infrastructure change is never silent', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    for (const l of listeners) {
      l(event('infra.out_of_band_recorded', {
        change: 'c1', source: 'cloudtrail', key: 'evt-1', target: 'sg-0abc', what: 'ec2:AuthorizeSecurityGroupIngress', who: 'arn:aws:sts::123456789012:assumed-role/Admin/console',
        at: '2026-10-07T20:40:00Z', job: 'j1',
      }));
    }
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    await n.stop();
    expect(r.hits[0]).toEqual(expect.objectContaining({
      source: 'hopper', kind: 'infra.out_of_band_recorded', change: 'c1', signal: 'cloudtrail', target: 'sg-0abc', what: 'ec2:AuthorizeSecurityGroupIngress',
      who: 'arn:aws:sts::123456789012:assumed-role/Admin/console', happenedAt: '2026-10-07T20:40:00Z',
    }));
    expect(r.hits[0]).not.toHaveProperty('infraUrl');
  });

  it('links an out-of-band change to the Infra page, where a person marks it (issue #871)', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '', infraUrl: () => 'http://hopper.lan:4790/#infra' });
    for (const l of listeners) l(event('infra.out_of_band_recorded', { change: 'c1', source: 'gitops', key: 'web', target: 'argocd app web', what: 'OutOfSync', at: '2026-10-07T20:40:00Z', job: 'j1' }));
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    await n.stop();
    expect(r.hits[0]).toEqual(expect.objectContaining({ kind: 'infra.out_of_band_recorded', change: 'c1', infraUrl: 'http://hopper.lan:4790/#infra' }));
  });

  it('posts machine.memory_low and machine.memory_recovered (issue #868): a machine runs low on free memory, and is back', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    const free = { machineId: 'win-desk', of: 'windows', freeBytes: 3e9, totalBytes: 32e9, thresholdBytes: 5e9 };
    for (const l of listeners) l(event('machine.memory_low', { ...free, since: '2026-10-07T20:30:00.000Z' }));
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    for (const l of listeners) l(event('machine.memory_recovered', { ...free, freeBytes: 9e9 }));
    await waitFor(() => r.hits.length === 2, { what: 'two posts' });
    await n.stop();
    expect(r.hits[0]).toEqual(expect.objectContaining({ source: 'hopper', kind: 'machine.memory_low', ...free, since: '2026-10-07T20:30:00.000Z' }));
    expect(r.hits[1]).toEqual(expect.objectContaining({ source: 'hopper', kind: 'machine.memory_recovered', ...free, freeBytes: 9e9 }));
  });
  it('posts machine.offline and machine.back_online (issue #1497): a seat stays offline, and is back', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    const seat = { machineId: 'seat-l1', label: 'seat l1', since: '2026-10-16T22:33:00.000Z' };
    for (const l of listeners) l(event('machine.offline', seat));
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    for (const l of listeners) l(event('machine.back_online', seat));
    await waitFor(() => r.hits.length === 2, { what: 'two posts' });
    await n.stop();
    expect(r.hits[0]).toEqual(expect.objectContaining({ source: 'hopper', kind: 'machine.offline', ...seat }));
    expect(r.hits[1]).toEqual(expect.objectContaining({ source: 'hopper', kind: 'machine.back_online', ...seat }));
  });
  it('posts machine.drained_idle (issue #2499): a drained seat sits idle while jobs are queued', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    const idle = { machineId: 'seat-l3', label: 'seat l3', since: '2026-10-22T10:00:00.000Z', drainedAt: '2026-10-21T04:00:00.000Z', until: '2026-10-22T04:00:00.000Z', reason: 'rebuild', freeLanes: 3, queued: 31 };
    for (const l of listeners) l(event('machine.drained_idle', idle));
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    await n.stop();
    expect(r.hits[0]).toEqual(expect.objectContaining({ source: 'hopper', kind: 'machine.drained_idle', ...idle }));
  });
  it('posts machine.disk_over_budget and machine.disk_within_budget (issue #1203): a machine stays over its disk budget, and is back within it', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    const over = { machineId: 'desk', usedBytes: 62e9, budgetBytes: 50e9, paths: [{ path: '/w/.worktrees', bytes: 62e9 }] };
    const e = event('machine.disk_over_budget', over);
    for (const l of listeners) l(e);
    for (const l of listeners) l(e);
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    for (const l of listeners) l(event('machine.disk_within_budget', { machineId: 'desk', usedBytes: 41e9, budgetBytes: 50e9 }));
    await waitFor(() => r.hits.length === 2, { what: 'two posts' });
    await n.stop();
    expect(r.hits).toHaveLength(2);
    expect(r.hits[0]).toEqual(expect.objectContaining({ source: 'hopper', kind: 'machine.disk_over_budget', ...over }));
    expect(r.hits[1]).toEqual(expect.objectContaining({ source: 'hopper', kind: 'machine.disk_within_budget', machineId: 'desk', usedBytes: 41e9, budgetBytes: 50e9 }));
  });
  it('posts machine.disk_low and machine.disk_ok (issue #2494): a machine\'s disk turns low, and is no longer low', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    const low = { machineId: 'seat-l1', label: 'seat l1', freeBytes: 4e9, totalBytes: 250e9, critical: true };
    for (const l of listeners) l(event('machine.disk_low', low));
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    for (const l of listeners) l(event('machine.disk_ok', { machineId: 'seat-l1', label: 'seat l1', freeBytes: 40e9, totalBytes: 250e9 }));
    await waitFor(() => r.hits.length === 2, { what: 'two posts' });
    await n.stop();
    expect(r.hits[0]).toEqual(expect.objectContaining({ source: 'hopper', kind: 'machine.disk_low', ...low }));
    expect(r.hits[1]).toEqual(expect.objectContaining({ source: 'hopper', kind: 'machine.disk_ok', machineId: 'seat-l1', label: 'seat l1', freeBytes: 40e9, totalBytes: 250e9 }));
  });
  it('posts work_item.person_asked (issue #1891): a blocked item waits on a person, with what it waits on', async () => {
    const r = await receiver();
    const listeners: ((e: DomainEvent) => void)[] = [];
    const n = createGrokBotNotifier({ name: 'grok-bot', routine: () => ({ url: r.url, key: 'k' }), logger: { info: () => undefined, warn: () => undefined }, clock: { now: () => new Date() }, baseMs: 10 });
    n.start({ subscribe: (l) => { listeners.push(l); return () => undefined; }, job: () => undefined, question: () => undefined, waitingOnHuman: () => [], answerUrl: () => '' });
    const key = 'https://github.com/octocat/hello/issues/828';
    for (const l of listeners) l({ ...event('work_item.person_asked', { key, cause: 'pr_closed', jobId: 'j1', pullRequest: 'https://github.com/octocat/hello/pull/830' }), jobId: 'j1' });
    await waitFor(() => r.hits.length === 1, { what: 'one post' });
    await n.stop();
    expect(r.hits[0]).toEqual(expect.objectContaining({
      source: 'hopper', kind: 'work_item.person_asked', jobId: 'j1', issueUrl: key, cause: 'pr_closed',
      waitingOn: 'a person: its pull request was closed without a merge', pullRequest: 'https://github.com/octocat/hello/pull/830',
    }));
  });
});
