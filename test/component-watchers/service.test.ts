// Component watchers (issue #1077): each watcher checks its component on its own interval against its source of truth.
// A drift is one event when found and one when cleared, and — with the user's setting on — one drift issue on the
// hopper's repository, found again by its drift key and updated, never filed twice. GitHub is a fake at its port.
//
// Feature: component watchers
//   Scenario: injected drift produces exactly one issue within one watch interval
//     Given the setting to file drift issues is on, and a ledger row that disagrees with GitHub
//     When the watcher checks, and checks again
//     Then there is one drift.found, one issue filed, and no second issue
//   Scenario: a drift issue already on GitHub is updated, not filed again
//   Scenario: a drift that ends is one drift.cleared, and its issue says so
//   Scenario: with the setting off, a drift is an event and no issue
//   Scenario: a check that fails keeps the drift as it was and says why
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComponentWatchers, type ComponentWatcher, type DriftGitHub } from '../../src/component-watchers/service.ts';
import { DRIFT_MARKER, type Drift } from '../../src/domain/drift.ts';
import type { ComponentWatcherSettings, NewEvent } from '../../src/domain/types.ts';

const NOW = '2026-10-13T12:00:00.000Z';
const DRIFT: Drift = { watcher: 'ledger-github', kind: 'failed_but_finished', items: [{ key: 'https://github.com/o/r/issues/1', ledger: 'failed', github: 'pull request merged', since: NOW }] };

function fakeGitHub(open: { number: number; url: string; body: string }[] = []) {
  const filed: { title: string; body: string; labels: string[] }[] = [];
  const updated: { number: number; body: string }[] = [];
  const gh: DriftGitHub = {
    async find(key) { const i = open.find((x) => x.body.includes(`${DRIFT_MARKER}${key}\n`) || x.body.endsWith(`${DRIFT_MARKER}${key}`)); return i ? { number: i.number, url: i.url } : undefined; },
    async file(issue) { filed.push(issue); const n = 100 + filed.length; open.push({ number: n, url: `https://github.com/h/h/issues/${n}`, body: issue.body }); return { number: n, url: `https://github.com/h/h/issues/${n}` }; },
    async update(number, issue) { updated.push({ number, body: issue.body }); },
  };
  return { gh, filed, updated };
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops.splice(0)) await s(); });

function setup(o: { drifts: () => Drift[] | Promise<Drift[]>; fileIssues?: boolean; github?: DriftGitHub | { problem: string } }) {
  const events: NewEvent[] = [];
  let settings: ComponentWatcherSettings | undefined = o.fileIssues === undefined ? undefined : { fileIssues: o.fileIssues };
  const watcher: ComponentWatcher = { name: 'ledger-github', component: 'the work-item ledger', truth: 'GitHub', intervalMs: 60_000, check: async () => o.drifts() };
  const w = createComponentWatchers({
    watchers: [watcher],
    store: {
      events: { append: (e: NewEvent) => { events.push(e); } },
      settings: { getComponentWatchers: () => settings, setComponentWatchers: (s: ComponentWatcherSettings) => { settings = s; } },
    },
    github: () => o.github ?? { problem: 'not connected' },
    now: () => NOW,
    log: () => undefined,
  });
  stops.push(() => w.stop());
  const of = (type: string) => events.filter((e) => e.type === type);
  return { w, events, of };
}

describe('component watchers', () => {
  it('turns injected drift into exactly one issue, then updates it instead of filing again', async () => {
    const { gh, filed, updated } = fakeGitHub();
    let drifts = [DRIFT];
    const { w, of } = setup({ drifts: () => drifts, fileIssues: true, github: gh });
    await w.check('ledger-github');
    await w.check('ledger-github');
    expect(filed).toHaveLength(1);
    expect(filed[0]!.labels).toEqual(['user-report']);
    expect(filed[0]!.body).toContain(`${DRIFT_MARKER}ledger-github/failed_but_finished`);
    expect(of('drift.found').map((e) => e.data)).toEqual([{ watcher: 'ledger-github', kind: 'failed_but_finished', items: 1 }]);
    expect(of('drift.issue_filed').map((e) => e.data)).toEqual([{ watcher: 'ledger-github', kind: 'failed_but_finished', number: 101, url: 'https://github.com/h/h/issues/101' }]);
    expect(updated).toEqual([]);

    // One more item in the same drift: the same issue, its body updated.
    drifts = [{ ...DRIFT, items: [...DRIFT.items, { key: 'https://github.com/o/r/issues/2', ledger: 'failed', github: 'issue closed (completed)' }] }];
    await w.check('ledger-github');
    expect(filed).toHaveLength(1);
    expect(updated.map((u) => u.number)).toEqual([101]);
    expect(of('drift.issue_updated')).toHaveLength(1);
    expect(of('drift.found')).toHaveLength(1);
    expect(w.view().watchers[0]).toMatchObject({ name: 'ledger-github', checkedAt: NOW, drifts: [{ kind: 'failed_but_finished', items: 2, issue: { number: 101 } }] });
  });

  it('finds a drift issue already open on GitHub by its drift key and updates it', async () => {
    const { gh, filed, updated } = fakeGitHub([{ number: 7, url: 'https://github.com/h/h/issues/7', body: `old\n\n${DRIFT_MARKER}ledger-github/failed_but_finished` }]);
    const { w, of } = setup({ drifts: () => [DRIFT], fileIssues: true, github: gh });
    await w.check('ledger-github');
    expect(filed).toEqual([]);
    expect(updated.map((u) => u.number)).toEqual([7]);
    expect(of('drift.issue_updated').map((e) => e.data)).toEqual([{ watcher: 'ledger-github', kind: 'failed_but_finished', number: 7, url: 'https://github.com/h/h/issues/7' }]);
  });

  it('records a drift that ends once, and its issue says no item is in it now', async () => {
    const { gh, updated } = fakeGitHub();
    let drifts = [DRIFT];
    const { w, of } = setup({ drifts: () => drifts, fileIssues: true, github: gh });
    await w.check('ledger-github');
    drifts = [];
    await w.check('ledger-github');
    await w.check('ledger-github');
    expect(of('drift.cleared').map((e) => e.data)).toEqual([{ watcher: 'ledger-github', kind: 'failed_but_finished' }]);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.body).toContain('No item is in this drift now');
  });

  it('with the setting off (the default), records the drift and files nothing', async () => {
    const { gh, filed } = fakeGitHub();
    const { w, of } = setup({ drifts: () => [DRIFT], github: gh });
    await w.check('ledger-github');
    expect(of('drift.found')).toHaveLength(1);
    expect(filed).toEqual([]);
    expect(w.view().settings).toEqual({ fileIssues: false });
  });

  it('keeps the drift as it was when a check fails, and says why', async () => {
    let fail = false;
    const { w, of } = setup({ drifts: () => { if (fail) throw new Error('GitHub answered 502'); return [DRIFT]; } });
    await w.check('ledger-github');
    fail = true;
    await w.check('ledger-github');
    expect(of('drift.cleared')).toEqual([]);
    expect(w.view().watchers[0]).toMatchObject({ error: 'GitHub answered 502', drifts: [{ kind: 'failed_but_finished' }] });
  });

  it('a change of the setting is saved and recorded once; the same value records nothing', async () => {
    const { w, of } = setup({ drifts: () => [] });
    await w.change({ fileIssues: true }, 'admin');
    await w.change({ fileIssues: true }, 'admin');
    expect(of('component_watchers.settings_changed').map((e) => e.data)).toEqual([{ from: { fileIssues: false }, to: { fileIssues: true }, by: 'admin' }]);
  });

  it('checks at start and then on its interval', async () => {
    vi.useFakeTimers();
    try {
      let checks = 0;
      const { w } = setup({ drifts: () => { checks++; return []; } });
      w.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(checks).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(checks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
