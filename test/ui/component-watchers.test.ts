// Component watchers in the UI (issue #1077), pure: what the panel says of the setting, of each watcher's last check, and
// of each drift it found.
import { describe, expect, it } from 'vitest';
import { COMPONENT_WATCHERS_NOTE, componentWatchersSummary, driftItemLine, driftLine, watcherLine } from '../../ui/src/model/component-watchers.ts';

const watcher = { name: 'ledger-github', component: 'the work-item ledger', truth: 'GitHub', intervalSeconds: 900, drifts: [] };

describe('the Component watchers panel', () => {
  it('says whether a drift files a drift issue', () => {
    expect(componentWatchersSummary({ fileIssues: false })).toBe('Off: a drift is recorded as an event and shown here. No issue is filed.');
    expect(componentWatchersSummary({ fileIssues: true })).toBe('On: each kind of drift is one issue on the hopper\'s own repository, updated while it lasts.');
    expect(COMPONENT_WATCHERS_NOTE).toContain('your GitHub account');
  });

  it('says what each watcher checks, how often, and how its last check went', () => {
    expect(watcherLine(watcher)).toBe('the work-item ledger against GitHub, every 15 minutes: not checked yet.');
    expect(watcherLine({ ...watcher, checkedAt: '2026-10-13T12:00:00.000Z' })).toBe('the work-item ledger against GitHub, every 15 minutes: checked 2026-10-13T12:00:00.000Z, no drift.');
    expect(watcherLine({ ...watcher, checkedAt: '2026-10-13T12:00:00.000Z', error: 'not connected' })).toBe('the work-item ledger against GitHub, every 15 minutes: the last check failed: not connected.');
  });

  it('names each drift with its items and its issue', () => {
    expect(driftLine({ kind: 'failed_but_finished', items: 2, list: [], since: '2026-10-13T12:00:00.000Z', issue: { number: 7, url: 'u' } }))
      .toBe('failed but finished: 2 items since 2026-10-13T12:00:00.000Z, issue #7.');
    expect(driftLine({ kind: 'issue_state', items: 1, list: [], since: 'x' })).toBe('issue state: 1 item since x.');
  });

  it('says what the component and its source of truth say of each item', () => {
    expect(driftItemLine({ ...watcher, name: 'lanes-jobs', component: 'the lanes', truth: 'the job records' }, { key: 'desk/lane-1', says: 'busy with a job', truth: 'job finished' }))
      .toBe('desk/lane-1: the lanes: busy with a job; the job records: job finished.');
    expect(driftItemLine(watcher, { key: 'k', says: 'failed', truth: 'pull request merged', since: 'x' }))
      .toBe('k: the work-item ledger: failed; GitHub: pull request merged (since x).');
  });

  it('names every watcher in its note', () => {
    expect(COMPONENT_WATCHERS_NOTE).toContain('the work-item ledger against the job records');
    expect(COMPONENT_WATCHERS_NOTE).toContain('the lanes against the jobs they run');
  });
});
