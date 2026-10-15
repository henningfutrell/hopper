// Issue #1194, part 2: Assign to me, Release claim, Take off the backburner and Take into Intake answer before their
// GitHub writes. The write runs after the answer, as a write-behind the item shows (`writeBehind`) while it runs and when it
// failed; its event is recorded once GitHub took it; the next discover waits for it. A second send of the same act
// before a discover listed the item again writes nothing more. A failed one is offered again and goes through when sent again.
import { describe, expect, it } from 'vitest';
import type { GitHubApi } from '../../src/sources/github/api.ts';
import { GitHubApiError, createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import type { GitHubSourceOptions } from '../../src/sources/github/index.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';

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

describe('an intake action answers before its GitHub write (issue #1194)', () => {
  it('Assign to me: answered with the write still running, shown on the item; the event once GitHub took it; the next discover takes it', async () => {
    const { gh, gated, events, source, item } = setup();
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    await source.discover();
    expect(await source.intakeAction?.({ kind: 'assign', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
    expect(gh.issue(REPO, 1).assignees).toEqual([]);
    expect(item(url(1))).toMatchObject({ action: 'assign', writeBehind: { act: 'assign', state: 'running' } });
    expect(events).toEqual([]);
    // A second click before the next discover: done, and no second write.
    expect(await source.intakeAction?.({ kind: 'assign', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
    expect(gated.writes).toEqual(['addAssignees']);
    gated.open();
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
    expect(gh.issue(REPO, 1).assignees).toEqual(['owner']);
    expect(events).toEqual([{ type: 'source.issues_assigned', data: { source: 'github', keys: [url(1)], assignee: 'owner' } }]);
    expect(item(url(1))?.writeBehind).toBeUndefined();
  });

  it('Release claim and Take off the backburner: the labels go after the answer, their events with them', async () => {
    const { gh, gated, events, source, item } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed', 'hopper:held-by:0f0f0f0f0f0f'] });
    gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:backburner'] });
    await source.discover();
    expect(await source.intakeAction?.({ kind: 'release', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
    expect(await source.intakeAction?.({ kind: 'unbackburner', keys: [url(2)] })).toEqual({ done: [url(2)], failed: {} });
    expect(gh.issue(REPO, 1).labels).toContain('hopper:claimed');
    expect(item(url(1))?.writeBehind).toEqual({ act: 'release', state: 'running' });
    expect(item(url(2))?.writeBehind).toEqual({ act: 'unbackburner', state: 'running' });
    expect(events).toEqual([]);
    gated.open();
    expect((await source.discover()).map((i) => i.number)).toEqual([1, 2]);
    expect(events.map((e) => e.type).sort()).toEqual(['source.backburner_lifted', 'source.claim_released']);
  });

  it('a write that fails is shown on the item and in the detail, offered again, and goes through when sent again', async () => {
    const { gh, gated, source, item } = setup();
    gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    await source.discover();
    gh.failNext('addAssignees', new GitHubApiError('GitHub is down', false, 502));
    gated.open();
    expect(await source.intakeAction?.({ kind: 'assign', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
    await source.discover();
    expect(item(url(1))).toMatchObject({ action: 'assign', writeBehind: { act: 'assign', state: 'failed', error: 'GitHub is down' } });
    expect(source.describe().writeBehindErrors).toEqual({ [url(1)]: 'assign: GitHub is down' });
    expect(await source.intakeAction?.({ kind: 'assign', keys: [url(1)] })).toEqual({ done: [url(1)], failed: {} });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
    expect(item(url(1))?.writeBehind).toBeUndefined();
    expect(source.describe().writeBehindErrors).toBeUndefined();
  });

});
