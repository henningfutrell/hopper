// @vitest-environment happy-dom
// Won't do and Run again on a blocked item in Intake (issue #1891): an issue whose work item is blocked — no pull request to
// wait on, or its pull request closed without a merge — offers Won't do, which drops the item, and Run again on its job.
// Each goes through the daemon, which writes the label changes through the GitHub outbox: no one edits `hopper:pr-closed`.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DETAIL, SOURCES, boot, button, click, group, posts, row, streamed, unmount, url, view } from './intake-view-harness.ts';

afterEach(unmount);

const blocked = { key: url(12), title: 'Closed twice', repo: 'octo-user/hopper', reason: 'its pull request was closed without a merge: hopper:pr-closed is on the issue',
  action: 'wont_do', group: 'other', jobId: 'j-12', jobStatus: 'finished' };

async function withBlocked() {
  await boot('#intake');
  await vi.waitFor(() => expect(view()).not.toBeNull());
  await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify({ ...SOURCES[0], detail: { ...DETAIL, intake: [...DETAIL.intake, blocked] } }) }); });
  return row(group(view()!, 'other'), url(12));
}

describe('Intake: Won\'t do and Run again on a blocked item (issue #1891)', () => {
  it('Won\'t do posts the intake action for the one item', async () => {
    const r = await withBlocked();
    await click(button(r, 'Won\'t do'));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: '/ui/api/sources/github-account/intake', body: { kind: 'wont_do', keys: [url(12)] } });
  });

  it('Run again posts Run again on its job', async () => {
    const r = await withBlocked();
    await click(button(r, 'Run again'));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.path).toBe('/ui/api/jobs/j-12/rerun');
  });

  it('an item kept out for another reason offers neither', async () => {
    await withBlocked();
    const failed = row(view()!, url(8));
    expect(button(failed, 'Won\'t do')).toBeUndefined();
    expect(button(failed, 'Run again')).toBeUndefined();
  });
});
