// @vitest-environment happy-dom
// Settings as a long page (issue #2353, part 2): its sections' links are in groups that fold, a folded group kept over a
// reload, and a jump list names every section and opens the one picked.
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { all, boot, click, unmount } from './long-page-harness.ts';

afterEach(unmount);

const group = (id: string) => document.querySelector(`[data-settings-group="${id}"]`);
const links = (id: string) => [...(group(id)?.querySelectorAll('a[href^="#settings/"]') ?? [])];

describe('Settings as a long page (issue #2353)', () => {
  it('puts every section in one group, each group a toggle', async () => {
    await boot('#settings');
    const groups = all('[data-settings-group]');
    expect(groups.length).toBeGreaterThanOrEqual(4);
    const hrefs = groups.flatMap((g) => [...g.querySelectorAll('a[href^="#settings/"]')].map((a) => a.getAttribute('href')));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs).toContain('#settings/version');
    expect(hrefs).toContain('#settings/sign-in');
    for (const g of groups) expect(g.querySelector('[data-slot="settings-group-toggle"]')).not.toBeNull();
  });

  it('folds a group, and keeps it folded over a reload', async () => {
    await boot('#settings');
    expect(links('security').length).toBeGreaterThan(0);
    await click(group('security')!.querySelector('[data-slot="settings-group-toggle"]'));
    expect(links('security')).toHaveLength(0);
    await unmount();
    await boot('#settings', {}, true);
    expect(links('security')).toHaveLength(0);
    expect(group('security')!.querySelector('[data-slot="settings-group-toggle"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the open section\'s link in view when its group is folded', async () => {
    await boot('#settings/allowed-hosts');
    await click(group('security')!.querySelector('[data-slot="settings-group-toggle"]'));
    expect(links('security').map((a) => a.getAttribute('href'))).toEqual(['#settings/allowed-hosts']);
  });

  it('jumps to the section picked in the jump list', async () => {
    await boot('#settings');
    const jump = document.querySelector<HTMLSelectElement>('select[data-slot="settings-jump"]')!;
    const options = [...jump.options].map((o) => o.value);
    expect(options).toContain('sign-in');
    expect(options).toContain('version');
    await act(async () => { jump.value = 'sign-in'; jump.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(window.location.hash).toBe('#settings/sign-in');
  });
});
