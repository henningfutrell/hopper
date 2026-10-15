// @vitest-environment happy-dom
// Issue #1178 in the UI: Intake takes a decision on a request card from the source's list. When the source asks again for
// an issue approved here, the card offers Approve and Decline again; an approved row says its job and the job's state; an
// approved issue whose job is done leaves Needs approval.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DETAIL, SOURCES, boot, button, click, group, request, row, streamed, unmount, url, view } from './intake-view-harness.ts';

afterEach(unmount);

describe('Intake takes a decision from the source\'s list (issue #1178)', () => {
  const update = async (intake: unknown[]) => { await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify({ ...SOURCES[0], detail: { ...DETAIL, intake } }) }); }); };
  const listed = (x: Record<string, unknown>) => DETAIL.intake.map((y) => (y.key === url(9) ? x : y));
  const takenBy = (jobStatus: string) => ({ key: url(9), title: 'Request 9', repo: 'octo-user/hopper', jobId: 'j-9-abcdefgh', jobStatus });
  const approve = async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await click(button(row(view()!, url(9)), 'Approve'));
    await update(listed(takenBy('queued')));
    await vi.waitFor(() => expect(row(view()!, url(9)).querySelector('[data-approved]')).not.toBeNull());
  };

  it('an approved row says what it waits on: its job and the job\'s state', async () => {
    await approve();
    const taken = row(view()!, url(9)).querySelector('[data-taken]')!;
    expect(taken.textContent).toBe('taken · job j-9-abcd · queued');
  });

  it('when the source asks again for the approved issue, the card offers Approve and Decline again', async () => {
    await approve();
    // The issue was reopened after its job was done: the source lists its card again, with no approved text.
    await update(listed({ ...DETAIL.intake.find((x) => x.key === url(9))!, request: { ...request(9), why: ['reopened after its job was done'] } }));
    await vi.waitFor(() => expect(button(row(view()!, url(9)), 'Approve')).not.toBeUndefined());
    const card = row(view()!, url(9));
    expect(card.querySelector('[data-approved]')).toBeNull();
    expect(card.querySelector('[data-slot="request-approved"]')).toBeNull();
    expect(button(card, 'Decline')!.disabled).toBe(false);
  });

  it('an approved issue whose job is done leaves Needs approval', async () => {
    await approve();
    await update(listed(takenBy('finished')));
    await vi.waitFor(() => expect(row(view()!, url(9))).toBeNull());
    expect([...group(view()!, 'request').querySelectorAll('[data-intake-item]')].map((r) => r.getAttribute('data-intake-item'))).toEqual([url(10)]);
  });
});
