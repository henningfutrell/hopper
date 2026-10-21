// The source a label-mirror test drives (issue #1892): a fake GitHub, the ledger's work items as the test gives them, and
// the person's label edits it records.
import { vi } from 'vitest';
import { createFakeGitHub, createGitHubSource } from '../../../src/sources/github/index.ts';
import type { memoryGitHubOutbox } from '../../../src/sources/github/outbox.ts';
import type { memoryListings } from '../../../src/sources/github/listing.ts';
import type { WorkItem } from '../../../src/domain/work-items.ts';
import { REPO, githubConfig, testTrust } from './github-support.ts';

export const LONG_AGO = '2026-10-18T10:00:00.000Z';
export const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;

export const itemOf = (key: string, o: Partial<WorkItem>): WorkItem => ({
  key, state: 'blocked', stateSince: LONG_AGO, eventState: o.state ?? 'blocked', eventAt: LONG_AGO, keptWork: [], version: 3, ...o,
});

export function labelMirrorSetup(items: Record<string, Partial<WorkItem>>, o: { parts?: string[]; reported?: string[]; outbox?: ReturnType<typeof memoryGitHubOutbox>; rerunnable?: string[]; listings?: ReturnType<typeof memoryListings>; gh?: ReturnType<typeof createFakeGitHub>; at?: string } = {}) {
  const gh = o.gh ?? createFakeGitHub();
  let now = Date.parse(o.at ?? '2026-10-18T12:00:00.000Z');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const recorded: { type: string; data: Record<string, unknown> }[] = [];
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', whoami: 'owner', assignee: () => 'owner', config: githubConfig({}), api: gh,
    trust: testTrust(), ...(o.outbox ? { outbox: o.outbox } : {}), ...(o.listings ? { listings: o.listings } : {}), clock: { now: () => new Date(now) }, knownKeys: (keys) => new Set(keys.filter((k) => items[k])),
    rerunnable: (keys: string[]) => new Set(keys.filter((k) => o.rerunnable?.includes(k))),
    intake: {
      holder: 'a1b2c3d4e5f6', othersKnown: () => new Set(), migration: () => ({ at: LONG_AGO, changes: [] }), migrated: () => {},
      // The ledger folds the person's event into the item: its Run again is asked, its state stays.
      record: (type, data) => {
        recorded.push({ type, data });
        if (type === 'work_item.label_edited') items[String(data.key)] = { ...items[String(data.key)], runAgainAsked: String(data.label) };
      },
      requestOpened: () => false, requestsWaiting: () => [],
      workItem: (key) => (items[key] ? itemOf(key, items[key]) : undefined),
      partOpen: (key) => o.parts?.includes(key) ?? false,
      failureReported: (key) => o.reported?.includes(key) ?? false,
    },
  });
  const edits = () => recorded.filter((r) => r.type === 'work_item.label_edited').map((r) => r.data);
  const reason = (n: number) => source.intake!().find((x) => x.key === url(n));
  const later = (ms: number) => { now += ms; };
  return { gh, source, edits, reason, later, recorded };
}
