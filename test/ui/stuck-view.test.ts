// @vitest-environment happy-dom
// Stuck work in Failures (issue #1010): every item that waits on a person, counted by its stuck cause, first in the view;
// a cause the hopper acts on in bulk has one button, asked first, else it says what a person does. Only when some is stuck.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T0, view, boot, settle, buttonsIn, daemon, unmount } from './failures-view-harness.ts';

const stuck = [
  { cause: 'continue', ids: ['h1', 'h2'], what: 'Failed jobs that can go on in their work', act: 'Continue all' },
  { cause: 'own_wait', ids: ['j4'], what: 'Jobs stuck on their own wait, past its deadline', todo: 'End its wait or cancel it, on the job.' },
];
const panel = () => document.querySelector('[data-section="stuck"]');
const cause = (c: string) => document.querySelector(`[data-stuck="${c}"]`);
const click = async (b: Element | undefined) => {
  await act(async () => { (b as HTMLButtonElement).click(); });
  await settle();
};
const button = (root: ParentNode | null, text: string) => [...(root?.querySelectorAll('button') ?? [])].filter((x) => x.textContent === text).at(-1);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Stuck work (issue #1010)', () => {
  it('counts each cause, with its bulk action or what a person does', async () => {
    await boot('#failures', { failures: view({ problems: [], stuck }) });
    expect(panel()?.textContent).toContain('3');
    expect(cause('continue')?.textContent).toContain('2');
    expect(cause('continue')?.textContent).toContain('Failed jobs that can go on in their work');
    expect(buttonsIn(cause('continue'))).toEqual(['Continue all']);
    expect(cause('own_wait')?.textContent).toContain('End its wait or cancel it, on the job.');
    expect(buttonsIn(cause('own_wait'))).toEqual([]);
  });

  it('the bulk action asks first, then goes to the daemon', async () => {
    await boot('#failures', { failures: view({ problems: [], stuck }) });
    await click(button(cause('continue'), 'Continue all'));
    expect(daemon.posts).not.toContain('POST /ui/api/failures/stuck/continue');
    expect(document.body.textContent).toContain('2 items');
    await click(button(document, 'Continue all'));
    expect(daemon.posts).toContain('POST /ui/api/failures/stuck/continue');
  });

  it('a viewer is offered no action; nothing stuck shows no panel', async () => {
    await boot('#failures', { failures: view({ problems: [], stuck }), role: 'viewer' });
    expect(buttonsIn(cause('continue'))).toEqual([]);
    await unmount();
    await boot('#failures', { failures: view({ problems: [] }) });
    expect(panel()).toBeNull();
  });
});
