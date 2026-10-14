// The last watchers (issue #1077): the job repositories' default branches against their checks on GitHub, and the
// hopper's stack against what a healthy stack is. GitHub and the stack resources are fakes at their ports.
import { describe, expect, it } from 'vitest';
import { branchChecksWatcher, stackHealthWatcher } from '../../src/component-watchers/branch-stack.ts';
import type { BranchHead } from '../../src/domain/drift-branches.ts';
import type { StackResources } from '../../src/domain/stack-resources.ts';
import { NO_OPENFGA } from '../../src/stack-resources/index.ts';

const NOW = '2026-10-13T12:00:00.000Z';
const HOUR_AGO = '2026-10-13T11:00:00.000Z';

describe('the default-branch-vs-checks watcher', () => {
  it('reads the head of each job repository\'s default branch and answers the drift', async () => {
    const asked: string[][] = [];
    const w = branchChecksWatcher({
      repositories: () => ['o/a', 'o/b'],
      github: () => ({ heads: async (repos) => { asked.push([...repos]); return [{ repo: 'o/a', committedAt: HOUR_AGO, checks: 'failure' }, { repo: 'o/b', committedAt: HOUR_AGO, checks: 'success' }] as BranchHead[]; } }),
      now: () => NOW,
    });
    expect(w).toMatchObject({ name: 'branch-checks', component: 'the job repositories\' default branches', truth: 'their checks on GitHub', intervalMs: 900_000 });
    expect((await w.check()).map((d) => [d.kind, d.items.map((i) => i.key)])).toEqual([['checks_failing', ['o/a']]]);
    expect(asked).toEqual([['o/a', 'o/b']]);
  });

  it('fails with why when there is no GitHub connection, and asks nothing with no job repository', async () => {
    await expect(branchChecksWatcher({ repositories: () => ['o/a'], github: () => ({ problem: 'not connected' }), now: () => NOW }).check()).rejects.toThrow('not connected');
    const w = branchChecksWatcher({ repositories: () => [], github: () => ({ heads: () => { throw new Error('asked'); } }), now: () => NOW });
    expect(await w.check()).toEqual([]);
  });
});

describe('the stack-health watcher', () => {
  const down: StackResources = {
    at: NOW, containers: { containers: [{ service: 'solr', group: 'stack', name: 's', image: 'i', state: 'exited' }] }, remoteBoxes: [],
    postgres: { connections: { active: 1, total: 1, max: 100 }, databaseBytes: 1, locksWaiting: 0, longTransactions: 0, statements: { calls: 0, meanMs: 0 } },
    openfga: { problem: NO_OPENFGA }, solr: { problem: 'down', pending: 0 },
  };
  const up: StackResources = { ...down, containers: { containers: [] }, solr: { queries: 0, errors: 0, docs: 0, indexBytes: 0, pending: 0 } };

  it('answers an item only once two checks in a row found it, so a stack that starts or restarts is no drift', async () => {
    const reads = [down, down, up, down];
    const w = stackHealthWatcher({ read: async () => reads.shift()!, now: () => NOW });
    expect(w).toMatchObject({ name: 'stack-health', component: 'the hopper\'s stack', truth: 'a healthy stack', intervalMs: 300_000, instance: true });
    expect(await w.check()).toEqual([]);
    // A part the hopper is not given (no OpenFGA here) is never drift.
    expect((await w.check()).map((d) => [d.kind, d.items.map((i) => i.key)])).toEqual([['service_down', ['solr']], ['part_unreadable', ['solr']]]);
    expect(await w.check()).toEqual([]);
    expect(await w.check()).toEqual([]);
  });
});
