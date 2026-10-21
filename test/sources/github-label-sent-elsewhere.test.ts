// A correction another hopper sent (issue #1892): of the hoppers on one database, any one's outbox sends the mirror's rows,
// and the listing cache is shared. A listing read before that send still shows the drift; the holder of the mirror's lease
// does not queue the correction again for it. A listing read after the send that still shows a drift is a new one.
import { describe, expect, it, vi } from 'vitest';
import { createGitHubOutbox, memoryGitHubOutbox } from '../../src/sources/github/outbox.ts';
import { createLabelMirror } from '../../src/sources/github/label-mirror.ts';
import { REPO } from './fixtures/github-support.ts';
import { itemOf, url } from './fixtures/label-mirror-support.ts';

const NOW = '2026-10-18T12:00:00.000Z';
const LISTED_BEFORE = '2026-10-18T11:59:00.000Z';
const SENT = '2026-10-18T11:59:30.000Z';
const LISTED_AFTER = '2026-10-18T11:59:45.000Z';

function world(listedAt: string) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const rows = memoryGitHubOutbox();
  const clock = { now: () => new Date(NOW) };
  const outbox = createGitHubOutbox({ source: 'github', rows, clock });
  const mirror = createLabelMirror({
    source: 'github', outbox, item: (key) => itemOf(key, { blockedCause: 'pr_closed', closedWithoutMerge: 1, jobId: 'job-1' }), part: () => false,
    listedAt: () => listedAt, now: () => NOW, log: () => {},
  });
  return { rows, mirror };
}

const stale = [{ url: url(1), repo: REPO, labels: ['hopper', 'hopper:pr-ready'] }];

describe('the label mirror and a correction another hopper sent (issue #1892)', () => {
  for (const c of [{ what: 'a listing read before the send: not queued again', listedAt: LISTED_BEFORE, rows: 2 }, { what: 'a listing read after the send: a new drift, queued', listedAt: LISTED_AFTER, rows: 4 }]) {
    it(c.what, () => {
      const { rows, mirror } = world(c.listedAt);
      expect(mirror.check(stale)).toBe(1);
      // Another hopper's outbox sent the rows: this one's memory has no word of it.
      rows.update(rows.open('github').map((r) => r.id), { state: 'sent', sentAt: SENT });
      mirror.check(stale);
      expect(rows.of('github', url(1))).toHaveLength(c.rows);
    });
  }
});
