// @vitest-environment happy-dom
// The Failures view as a long page (issue #2353): the counts and Cards or Rows stay in view; in Rows a failure is one
// line, its summary out; Needs a person, Recent failures and Ended page 6 cards (30 in Rows) to a page with no
// scroll box of their own, and fold; the mode and the folds are kept over a reload.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T0, handoff, record, view, boot, unmount } from './failures-view-harness.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const recent = Array.from({ length: 100 }, (_, i) => record({ id: `f${i}`, jobId: `j${i}` }));
const inSection = (name: string, sel: string) => document.querySelectorAll(`[data-section="${name}"] ${sel}`);

describe('the Failures view as a long page (issue #2353)', () => {
  it('keeps the counts and the mode in view', async () => {
    await boot('#failures', { failures: view() });
    const bar = document.querySelector('[data-slot="failures-bar"]')!;
    expect(bar.className).toContain('sticky');
    expect(bar.querySelector('[data-section="failure-counts"]')).not.toBeNull();
    expect(bar.querySelector('[data-slot="failures-mode-rows"]')).not.toBeNull();
  });

  it('pages 100 recent failures: 6 cards, or 30 one-line rows in Rows; no scroll box of its own', async () => {
    await boot('#failures', { failures: view({ recent }) });
    expect(inSection('open-failures', '[data-failure]')).toHaveLength(6);
    expect(document.querySelector('[data-section="open-failures"] [data-list-box]')).toBeNull();
    expect(inSection('open-failures', '[data-slot="pager-range"]')[0]?.textContent).toBe('1–6 of 100');
    await click(document.querySelector('[data-slot="failures-mode-rows"]')!);
    const rows = inSection('open-failures', '[data-failure]');
    expect(rows).toHaveLength(30);
    expect(rows[0]!.hasAttribute('data-row')).toBe(true);
    expect(rows[0]!.textContent).not.toContain('Held: Disk full on desk');
  });

  it('pages the open hand-offs 6 to a page', async () => {
    const handoffs = Array.from({ length: 12 }, (_, i) => handoff({ id: `h${i}`, jobId: `k${i}` }));
    await boot('#failures', { failures: view({ handoffs }) });
    expect(inSection('needs-a-person', '[data-handoff]')).toHaveLength(6);
    await click(document.querySelector('[data-section="needs-a-person"] [data-slot="pager-more"]')!);
    expect(inSection('needs-a-person', '[data-handoff]')).toHaveLength(6);
  });

  it('keeps the mode and a folded section over a reload', async () => {
    await boot('#failures', { failures: view() });
    await click(document.querySelector('[data-slot="failures-mode-rows"]')!);
    await click(document.querySelector('[data-section="open-failures"] [data-slot="panel-toggle"]')!);
    expect(inSection('open-failures', '[data-failure]')).toHaveLength(0);
    await unmount();
    await boot('#failures', { failures: view() }, true);
    expect(document.querySelector('[data-slot="failures-mode-rows"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(inSection('open-failures', '[data-failure]')).toHaveLength(0);
    await click(document.querySelector('[data-section="open-failures"] [data-slot="panel-toggle"]')!);
    expect(inSection('open-failures', '[data-failure]')).toHaveLength(2);
  });
});
