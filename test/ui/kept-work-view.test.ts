// @vitest-environment happy-dom
// Work not pushed in Failures (issue #1010): each ended job whose reap kept work, with Push it — and a note for the job — and
// Discard, asked first; or why Push it is not taken now. Counted in the Failures badge unless its hand-off counts it.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T0, at, view, boot, settle, buttonsIn, daemon, unmount } from './failures-view-harness.ts';

const kept = (over: Record<string, unknown> = {}) => ({
  jobId: 'j7', paths: ['/w/.worktrees/@scratch/j7/repo'], at: at(-10), status: 'failed', machineId: 'desk',
  actions: { push: { ok: true }, discard: { ok: true } }, ...over,
});
const row = () => document.querySelector('[data-kept-work="j7"]');
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

describe('Work not pushed (issue #1010)', () => {
  it('shows where the work is, with Push it and Discard; the nav badge counts it', async () => {
    await boot('#failures', { failures: view({ problems: [], keptWork: [kept()] }) });
    expect(row()?.textContent).toContain('/w/.worktrees/@scratch/j7/repo');
    expect(row()?.textContent).toContain('desk');
    expect(buttonsIn(row())).toEqual(expect.arrayContaining(['Push it', 'Discard']));
    expect(document.querySelector('a[href="#failures"] [data-slot="nav-badge"]')?.textContent).toBe('1');
  });

  it('says why each repository was kept (issue #2494); one recorded before says nothing more', async () => {
    const repo = '/w/.worktrees/@scratch/j7/repo';
    await boot('#failures', { failures: view({ problems: [], keptWork: [kept({ reasons: { [repo]: ['dirty', 'stash', 'unpushed'] } })] }) });
    expect(row()?.querySelector('[data-slot="kept-why"]')?.textContent).toBe('— changes not committed, a stash, commits not pushed');
    await unmount();
    await boot('#failures', { failures: view({ problems: [], keptWork: [kept()] }) });
    expect(row()?.querySelector('[data-slot="kept-why"]')).toBeNull();
  });

  it('Push it goes to the daemon with the note; Discard asks first, then goes', async () => {
    await boot('#failures', { failures: view({ problems: [], keptWork: [kept()] }) });
    const note = row()!.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Branch shed-blue');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(row(), 'Push it'));
    expect(daemon.posts).toContain('POST /ui/api/failures/kept-work/j7/push');
    expect(daemon.bodies.at(-1)).toEqual({ note: 'Branch shed-blue' });
    // Answered before its source takes the item back (issue #1194): the button waits, and Discard is not offered meanwhile.
    expect(buttonsIn(row())).toContain('Pushing');
    expect(buttonsIn(row())).not.toContain('Discard');
    await unmount();
    await boot('#failures', { failures: view({ problems: [], keptWork: [kept()] }) });
    await click(button(row(), 'Discard'));
    expect(daemon.posts).not.toContain('POST /ui/api/failures/kept-work/j7/discard');
    expect(document.body.textContent).toContain('You cannot undo this.');
    await click(button(document, 'Discard'));
    expect(daemon.posts).toContain('POST /ui/api/failures/kept-work/j7/discard');
  });

  it('says why Push it is not taken now; a viewer is offered no action; one with an open hand-off is not counted twice', async () => {
    await boot('#failures', { failures: view({ problems: [], keptWork: [kept({ handoffId: 'h1', actions: { push: { ok: false, why: 'its agent session cannot resume' }, discard: { ok: true } } })] }) });
    expect(row()?.textContent).toContain('its agent session cannot resume');
    expect(buttonsIn(row())).not.toContain('Push it');
    expect(document.querySelector('a[href="#failures"] [data-slot="nav-badge"]')).toBeNull();
    await unmount();
    await boot('#failures', { failures: view({ problems: [], keptWork: [kept()] }), role: 'viewer' });
    expect(buttonsIn(row())).not.toContain('Push it');
    expect(buttonsIn(row())).not.toContain('Discard');
  });

  it('a discard shows removing from the click on; the daemon\'s view says how the removal goes, and a failure with why (issue #1194)', async () => {
    const removing = 'its work is being removed on its machine';
    const d = { failures: view({ problems: [], keptWork: [kept()] }) };
    await boot('#failures', d);
    await click(button(row(), 'Discard'));
    // The daemon answers before the removal; the view it answers next says the removal is under way.
    d.failures = view({ problems: [], keptWork: [kept({ discarding: { state: 'removing' }, actions: { push: { ok: false, why: removing }, discard: { ok: false, why: removing } } })] });
    await click(button(document, 'Discard'));
    expect(daemon.posts).toContain('POST /ui/api/failures/kept-work/j7/discard');
    expect(row()?.querySelector('[data-slot="kept-work-removing"]')?.textContent).toBe('Discarded: removing the work tree on its machine');
    expect(buttonsIn(row())).not.toContain('Discard');
    expect(buttonsIn(row())).not.toContain('Push it');
    await unmount();
    await boot('#failures', { failures: view({ problems: [], keptWork: [kept({ discarding: { state: 'failed', error: 'its machine desk is out of reach' } })] }) });
    expect(row()?.querySelector('[data-slot="kept-work-discard-failed"]')?.textContent).toBe('The discard failed: its machine desk is out of reach. The work is still kept.');
    expect(buttonsIn(row())).toContain('Discard');
  });
});
