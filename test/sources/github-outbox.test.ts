// Issues #1194 and #1238: Assign to me, Release claim, Take off the backburner and Take into Intake answer before their
// GitHub writes. Each write is a row in the GitHub outbox, sent by a flush after the answer; the item shows it
// (`writeBehind`) until it went through, and when it failed; its event is recorded once GitHub took it. A discover never
// waits for the outbox. A second send of the same act before a discover listed the item again writes nothing more. A
// failed one is offered again and goes through when sent again. The rows due for one issue are coalesced.
import { describe, expect, it } from 'vitest';
import type { GitHubApi } from '../../src/sources/github/api.ts';
import { GitHubApiError, createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import type { GitHubSourceOptions } from '../../src/sources/github/index.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';
import { createGitHubOutbox, memoryGitHubOutbox } from '../../src/sources/github/outbox.ts';
import type { OutboxChange } from '../../src/domain/github-outbox.ts';

const AT = '2026-10-08T09:00:00.000Z';
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const WRITES = ['addAssignees', 'removeLabels', 'addLabels'];

/** A GitHub whose writes wait until `open()`; reads answer at once. `writes` counts the writes sent. */
function gatedGitHub<T extends GitHubApi>(gh: T) {
  let open!: () => void;
  let gate = new Promise<void>((res) => { open = res; });
  const writes: string[] = [];
  const api = new Proxy(gh, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function' || !WRITES.includes(String(prop))) return v;
      return async (...args: unknown[]) => { writes.push(String(prop)); await gate; return (v as (...a: unknown[]) => unknown).apply(target, args); };
    },
  });
  return { api, writes, open: () => open(), close: () => { gate = new Promise<void>((res) => { open = res; }); } };
}

function setup() {
  const gh = createFakeGitHub();
  const gated = gatedGitHub(gh);
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const options: GitHubSourceOptions = {
    name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', config: githubConfig({}), api: gated.api,
    trust: testTrust(undefined, { assignedHere: (k) => events.some((e) => e.type === 'source.issues_assigned' && (e.data.keys as string[]).includes(k)) }),
    clock: { now: () => new Date('2026-10-08T10:00:00.000Z') },
    knownKeys: () => new Set(),
    landingBranch: () => 'main',
    intake: {
      holder: 'a1b2c3d4e5f6', othersKnown: () => new Set(), migration: () => ({ at: AT, changes: [] }), migrated: () => {},
      record: (type, data) => { events.push({ type, data }); }, requestOpened: () => false, requestsWaiting: () => [],
    },
  };
  const source = createGitHubSource(options);
  const item = (key: string) => source.intake?.().find((x) => x.key === key);
  return { gh, gated, events, source, item };
}

describe('an intake action answers before its GitHub write (issues #1194, #1238)', () => {
  it('Assign to me: answered with the row not sent, shown on the item; the event once GitHub took it; the discover after takes it', async () => {
    const { gh, gated, events, source, item } = setup();
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    await source.discover();
    expect(await source.intakeAction?.({ kind: 'assign', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
    expect(gated.writes).toEqual([]);
    expect(item(url(1))).toMatchObject({ action: 'assign', writeBehind: { act: 'assign', state: 'running' } });
    // A second click before the next discover: done, and no second row.
    expect(await source.intakeAction?.({ kind: 'assign', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
    expect(source.describe()).toMatchObject({ writeBehindPending: 1 });
    const flushed = source.flushOutbox!();
    await Promise.resolve();
    // A discover while the write is under way does not wait for it.
    expect(await source.discover()).toEqual([]);
    expect(events).toEqual([]);
    gated.open();
    expect(await flushed).toEqual({ due: 1, wrote: [REPO] });
    expect(gated.writes).toEqual(['addAssignees']);
    expect(gh.issue(REPO, 1).assignees).toEqual(['owner']);
    expect(events).toEqual([{ type: 'source.issues_assigned', data: { source: 'github', keys: [url(1)], assignee: 'owner' } }]);
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
    expect(item(url(1))?.writeBehind).toBeUndefined();
    expect(source.describe().writeBehindPending).toBeUndefined();
    expect(source.describe().lastWriteBehindAt).toEqual(expect.any(String));
    // Its write is timed for `afterAnswer` (part 8).
    expect(source.afterAnswerTimings?.()).toMatchObject([{ act: 'assign', count: 1 }]);
  });

  it('Release claim and Take off the backburner: the labels go at the flush, their events with them; a discover before does not take them', async () => {
    const { gh, gated, events, source, item } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed', 'hopper:held-by:0f0f0f0f0f0f'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:backburner'] });
    await source.discover();
    expect(await source.intakeAction?.({ kind: 'release', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
    expect(await source.intakeAction?.({ kind: 'unbackburner', keys: [url(2)] })).toEqual({ done: [url(2)], failed: {} });
    expect(item(url(1))?.writeBehind).toEqual({ act: 'release', state: 'running' });
    expect(item(url(2))?.writeBehind).toEqual({ act: 'unbackburner', state: 'running' });
    expect(await source.discover()).toEqual([]);
    gated.open();
    expect(await source.flushOutbox!()).toEqual({ due: 2, wrote: [REPO] });
    expect(events.map((e) => e.type).sort()).toEqual(['source.backburner_lifted', 'source.claim_released']);
    expect((await source.discover()).map((i) => i.number)).toEqual([1, 2]);
  });

  it('a write GitHub refused for now shows running with its next attempt and why, and goes through when sent again', async () => {
    const { gh, gated, source, item } = setup();
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    await source.discover();
    gh.failNext('addAssignees', new GitHubApiError('GitHub is down', false, 502));
    gated.open();
    expect(await source.intakeAction?.({ kind: 'assign', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
    expect(await source.flushOutbox!()).toEqual({ due: 1, wrote: [] });
    await source.discover();
    // A transient refusal waits its backoff, and is tried again by itself meanwhile.
    expect(item(url(1))).toMatchObject({ action: 'assign', writeBehind: { act: 'assign', state: 'running', attempt: 2, error: 'GitHub is down' } });
    expect(source.describe()).toMatchObject({ writeBehindPending: 1 });
    expect(source.describe().writeBehindErrors).toBeUndefined();
    expect(await source.intakeAction?.({ kind: 'assign', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
    expect(await source.flushOutbox!()).toEqual({ due: 1, wrote: [REPO] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
    expect(item(url(1))?.writeBehind).toBeUndefined();
    expect(source.describe().writeBehindErrors).toBeUndefined();
  });

  it('a permanent refusal is failed at once, not tried again by itself', async () => {
    const { gh, gated, source, item } = setup();
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    await source.discover();
    gh.failNext('addAssignees', new GitHubApiError('not allowed', true, 403));
    gated.open();
    await source.intakeAction?.({ kind: 'assign', keys: [url(1)] });
    await source.flushOutbox!();
    expect(item(url(1))?.writeBehind).toEqual({ act: 'assign', state: 'failed', error: 'not allowed' });
    expect(source.describe().writeBehindErrors).toEqual({ [url(1)]: 'assign: not allowed' });
    expect(source.describe().writeBehindPending).toBeUndefined();
    // A row failed for good is timed too (part 8).
    expect(source.afterAnswerTimings?.()).toMatchObject([{ act: 'assign', count: 1 }]);
  });
});

describe('the outbox coalesces the rows due for one issue (issue #1238)', () => {
  const AT_CLOCK = { now: () => new Date('2026-10-15T10:00:00.000Z') };
  const label = (op: 'add_labels' | 'remove_labels', ...labels: string[]) => ({ change: { op, labels } as OutboxChange });

  function counting() {
    const calls: [string, string, OutboxChange][] = [];
    const outbox = createGitHubOutbox({ source: 'github', rows: memoryGitHubOutbox(), clock: AT_CLOCK });
    const send = async (repo: string, key: string, change: OutboxChange) => { calls.push([repo, key, change]); };
    return { calls, outbox, flush: () => outbox.flush(send) };
  }

  it('an add then a remove of the same label sends nothing', async () => {
    const { calls, outbox, flush } = counting();
    outbox.queue('take_in', url(1), REPO, [label('add_labels', 'hopper')]);
    outbox.queue('release', url(1), REPO, [label('remove_labels', 'hopper')]);
    expect(await flush()).toEqual({ due: 2, wrote: [] });
    expect(calls).toEqual([]);
    expect(outbox.held(url(1))).toBe(false);
  });

  it('three label edits on one issue send one call', async () => {
    const { calls, outbox, flush } = counting();
    outbox.queue('take_in', url(1), REPO, [label('add_labels', 'a')]);
    outbox.queue('approve', url(1), REPO, [label('add_labels', 'b')], { tag: 'h' });
    outbox.queue('assign', url(1), REPO, [label('add_labels', 'c')]);
    expect(await flush()).toEqual({ due: 3, wrote: [REPO] });
    expect(calls).toEqual([[REPO, url(1), { op: 'add_labels', labels: ['a', 'b', 'c'] }]]);
  });

  it('duplicate assignments collapse; each issue gets its own calls', async () => {
    const { calls, outbox, flush } = counting();
    outbox.queue('assign', url(1), REPO, [{ change: { op: 'add_assignees', assignees: ['owner'] } }]);
    outbox.queue('take_in', url(1), REPO, [{ change: { op: 'add_assignees', assignees: ['owner'] } }]);
    outbox.queue('assign', url(2), REPO, [{ change: { op: 'add_assignees', assignees: ['owner'] } }]);
    await flush();
    expect(calls).toEqual([
      [REPO, url(1), { op: 'add_assignees', assignees: ['owner'] }],
      [REPO, url(2), { op: 'add_assignees', assignees: ['owner'] }],
    ]);
  });
});
