// @vitest-environment happy-dom
// Usage, Resources, Sources and Accounts as long pages (issue #2353, part 2): their panels and sections fold by their
// title, and a folded one stays folded over a reload.
import { afterEach, describe, expect, it } from 'vitest';
import { boot, click, openOf, toggleOf, unmount } from './long-page-harness.ts';

afterEach(unmount);

const NOW = '2026-10-12T12:00:00.000Z';
const RESOURCES = {
  '/api/resources': {
    at: NOW, remoteBoxes: [],
    containers: { containers: [{ service: 'postgres', group: 'stack', name: 'hopper-postgres-1', image: 'postgres:17-alpine', state: 'running', restarts: 0 }] },
    postgres: { connections: { active: 3, total: 12, max: 100 }, databaseBytes: 1, cacheHitFrac: 0.9, locksWaiting: 0, longTransactions: 0, oldestTransactionS: 1, statements: { calls: 1, meanMs: 0.4 } },
    openfga: { checks: 1, errors: 0, meanMs: 1 }, solr: { queries: 1, errors: 0, meanMs: 1, p95Ms: 1, docs: 1, indexBytes: 1, pending: 0 },
  },
};
const TOOL_ACCOUNTS = {
  '/api/tool-accounts': {
    accounts: [{ service: 'claude', identity: 'a@example.com', detail: {}, login: 'signed-in', spend: [],
      machines: [{ machineId: 'm1', label: 'Desk', source: 'claude-desk', login: 'signed-in', readAt: NOW }] }],
  },
};
const SOURCES = { '/api/sources': { sources: [{ name: 'github-account', kind: 'github-account', state: 'ok', itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail: {} }] } };

/** Folds the panel or section titled `title`, reloads, and finds it still folded; open again, it opens. */
async function foldsAndKeeps(hash: string, routes: Record<string, unknown>, title: string) {
  await boot(hash, routes);
  expect(openOf(title)).toBe('true');
  await click(toggleOf(title));
  expect(openOf(title)).toBe('false');
  await unmount();
  await boot(hash, routes, true);
  expect(openOf(title)).toBe('false');
  await click(toggleOf(title));
  expect(openOf(title)).toBe('true');
}

describe('folds on the long pages (issue #2353)', () => {
  it('Usage: Accounts folds and stays folded', () => foldsAndKeeps('#usage', {}, 'Accounts'));
  it('Usage: Lane effect folds and stays folded', () => foldsAndKeeps('#usage', {}, 'Lane effect'));
  it('Resources: Postgres folds and stays folded', () => foldsAndKeeps('#resources', RESOURCES, 'Postgres'));
  it('Resources: Containers folds and stays folded', () => foldsAndKeeps('#resources', RESOURCES, 'Containers'));
  it('Accounts: a tool account folds and stays folded', () => foldsAndKeeps('#accounts', TOOL_ACCOUNTS, 'a@example.com'));
  it('Sources: the GitHub section folds and stays folded', () => foldsAndKeeps('#sources', SOURCES, 'GitHub'));
});
