// @vitest-environment happy-dom
// Issue #165: the version and what it brought are there to find at any time, not only behind an
// update notice — a Version section in Settings, and a header version that reads as a control.
// Rendered in happy-dom against the store, with no update waiting.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
const store = '../../ui/src/store/index.ts';
interface Store { useHopper: { setState(s: Record<string, unknown>): void } }
const COMMIT = 'c0ffee1'.padEnd(40, '0');
const UPDATE = {
  state: 'current', channel: 'main', autoUpdate: false, whatsNew: [],
  installed: { repo: 'git@github.com:o/r.git', branch: 'main', commit: COMMIT, installedAt: '2026-10-06T10:00:00Z' },
  installedWhatsNew: ['You can now do the newest thing.', 'An older change.'],
  checkedAt: '2026-10-06T10:01:00Z',
};
let root: Root | undefined;

async function render(mod: string, name: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  const { useHopper } = (await import(store)) as Store;
  useHopper.setState({ authed: true, update: UPDATE, health: { ok: true, version: '0.1.0', uptimeS: 1 } });
  const view = (await import(mod)) as Record<string, () => El>;
  const tooltip = '../../ui/src/components/ui/tooltip.tsx';
  const { TooltipProvider } = (await import(tooltip)) as { TooltipProvider: (p: { children?: unknown }) => El };
  await act(async () => {
    root = createRoot(document.getElementById('root')!);
    root.render(createElement(TooltipProvider, null, createElement(view[name]!)));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  window.location.hash = '';
  vi.unstubAllGlobals();
});

describe('the version, without an update notice', () => {
  it('Settings has a Version section in its navigation', async () => {
    window.location.hash = '#settings';
    await render('../../ui/src/views/settings.tsx', 'Settings');
    const link = document.querySelector<HTMLAnchorElement>('[data-slot="settings-nav"] a[href="#settings/version"]');
    expect(link?.textContent).toBe('Version');
  });

  it('Settings → Version shows the version, the installed commit and what this version brought', async () => {
    window.location.hash = '#settings/version';
    await render('../../ui/src/views/settings.tsx', 'Settings');
    const text = document.querySelector('[data-slot="version-details"]')?.textContent ?? '';
    expect(text).toContain('0.1.0');
    expect(text).toContain('main c0ffee1');
    expect(text).toContain('Up to date');
    expect(text).toContain('In this version');
    expect(text).toContain('You can now do the newest thing.');
    expect(text).toContain('An older change.');
  });

  it('the header version is a visible, labelled control', async () => {
    await render('../../ui/src/app/header.tsx', 'Header');
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Version and updates"]');
    expect(button?.textContent).toContain('0.1.0');
    expect(button?.querySelector('svg')).not.toBeNull();
    expect(button?.className).toMatch(/(^|\s)border(\s|$)/);
  });
});
