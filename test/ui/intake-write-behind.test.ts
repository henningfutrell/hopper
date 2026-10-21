// @vitest-environment happy-dom
// Issue #1194, part 2, in Intake: Assign to me, Release claim and Take off the backburner answer before their GitHub write.
// From the click on, the row says the write runs and offers that action no more; the daemon's list says how it ended. A
// write that failed says why on the row, and offers the action again.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DETAIL, SOURCES, boot, button, click, daemon, posts, row, streamed, unmount, url, view } from './intake-view-harness.ts';

afterEach(unmount);

/** The daemon's list sent on the stream, with item 4 changed by `item`. */
async function streamItem4(item: Record<string, unknown>) {
  const intake = DETAIL.intake.map((x) => (x.key === url(4) ? { ...x, ...item } : x));
  await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify({ ...SOURCES[0], detail: { ...DETAIL, intake } }) }); });
}

describe('Intake: an action\'s GitHub write after the answer (issue #1194)', () => {
  it('Take off the backburner: the row says it runs from the click on, and offers the action no more while the daemon\'s list still offers it', async () => {
    let answer!: () => void;
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    daemon.answer = () => new Promise((res) => { answer = () => res({ done: [url(4)], failed: {} }); });
    await click(button(row(view()!, url(4)), 'Take out of Later'));
    expect(row(view()!, url(4)).querySelector('[data-write-behind="running"]')?.textContent).toContain('taking out of Later on GitHub');
    expect(button(row(view()!, url(4)), 'Take out of Later')).toBeUndefined();
    await act(async () => { answer(); });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    await streamItem4({ writeBehind: { act: 'unbackburner', state: 'running' } });
    expect(row(view()!, url(4)).querySelector('[data-write-behind="running"]')).not.toBeNull();
    expect(button(row(view()!, url(4)), 'Take out of Later')).toBeUndefined();
  });

  it('a write that failed says why on the row, and offers the action again', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await click(button(row(view()!, url(4)), 'Take out of Later'));
    await streamItem4({ writeBehind: { act: 'unbackburner', state: 'failed', error: 'GitHub is down' } });
    expect(row(view()!, url(4)).querySelector('[data-write-behind="failed"]')?.textContent).toBe('taking out of Later on GitHub failed: GitHub is down ·');
    expect(row(view()!, url(4)).querySelector('[data-write-behind="running"]')).toBeNull();
    expect(button(row(view()!, url(4)), 'Take out of Later')).toBeDefined();
  });

  it('a write the GitHub outbox tries again by itself says so (issue #1238)', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await streamItem4({ writeBehind: { act: 'unbackburner', state: 'running', attempt: 2, error: 'GitHub is down' } });
    expect(row(view()!, url(4)).querySelector('[data-write-behind="running"]')?.textContent).toBe('taking out of Later on GitHub, trying again: GitHub is down ·');
  });

  it('a refused action shows its action again at once', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    daemon.answer = () => ({ done: [], failed: { [url(3)]: 'no GitHub account connected' } });
    await click(button(row(view()!, url(3)), 'Assign to me'));
    await vi.waitFor(() => expect(button(row(view()!, url(3)), 'Assign to me')).toBeDefined());
    expect(row(view()!, url(3)).querySelector('[data-write-behind]')).toBeNull();
  });
});
