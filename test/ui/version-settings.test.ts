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
  state: 'current', channel: 'stable', autoUpdate: false, whatsNew: [],
  installed: { kind: 'install', repo: 'git@github.com:o/r.git', branch: 'stable', commit: COMMIT, installedAt: '2026-10-06T10:00:00Z' },
  installedWhatsNew: ['You can now do the newest thing.', 'An older change.'],
  restartBlockers: 0,
  checkedAt: '2026-10-06T10:01:00Z',
};
let root: Root | undefined;

const HISTORY = {
  build: UPDATE.installed,
  versions: [
    { commit: COMMIT, at: '2026-10-05T15:00:00Z', changes: ['You can now do the newest thing.'] },
    { commit: 'abcdef1'.padEnd(40, '0'), at: '2026-10-01T09:00:00Z', changes: ['An older change.', 'Another older change.'] },
  ],
};

async function render(mod: string, name: string, o: { history?: unknown; update?: unknown } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/update/history' ? Response.json(o.history ?? HISTORY) : new Response('{}', { status: 404 })));
  const { useHopper } = (await import(store)) as Store;
  useHopper.setState({ authed: true, update: o.update ?? UPDATE, health: { ok: true, version: '0.1.0', uptimeS: 1 } });
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

  it('Settings opens on Version, its first section, with Version history next (issue #363)', async () => {
    window.location.hash = '#settings';
    await render('../../ui/src/views/settings.tsx', 'Settings');
    const hrefs = [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="settings-nav"] a')].map((a) => a.getAttribute('href'));
    expect(hrefs.slice(0, 2)).toEqual(['#settings/version', '#settings/version-history']);
    expect(document.querySelector('[data-slot="settings-nav"] a[aria-current="page"]')?.getAttribute('href')).toBe('#settings/version');
    expect(document.querySelector('[data-slot="version-details"]')).not.toBeNull();
  });

  it('a deep link to another section still opens that section (issue #363)', async () => {
    window.location.hash = '#settings/routing';
    await render('../../ui/src/views/settings.tsx', 'Settings');
    expect(document.querySelector('[data-slot="settings-nav"] a[aria-current="page"]')?.getAttribute('href')).toBe('#settings/routing');
    expect(document.querySelector('[data-slot="version-details"]')).toBeNull();
  });

  it('Settings → Version shows the version, the installed commit and what this version brought', async () => {
    window.location.hash = '#settings/version';
    await render('../../ui/src/views/settings.tsx', 'Settings');
    const text = document.querySelector('[data-slot="version-details"]')?.textContent ?? '';
    expect(text).toContain('0.1.0');
    expect(text).toContain('stable c0ffee1');
    expect(text).toContain('Up to date');
    expect(text).toContain('In this version');
    expect(text).toContain('You can now do the newest thing.');
    expect(text).toContain('An older change.');
  });

  it('the channel picker offers exactly dev, beta and stable (issue #423)', async () => {
    window.location.hash = '#settings/version';
    await render('../../ui/src/views/settings.tsx', 'Settings');
    const details = document.querySelector('[data-slot="version-details"]')!;
    const channels = [...details.querySelectorAll('[data-slot="update-channels"] button')].map((b) => b.textContent);
    expect(channels).toEqual(['dev', 'beta', 'stable']);
  });

  it('the header version is a visible, labelled control', async () => {
    await render('../../ui/src/app/header.tsx', 'Header');
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Version and updates"]');
    expect(button?.textContent).toContain('0.1.0');
    expect(button?.querySelector('svg')).not.toBeNull();
    expect(button?.className).toMatch(/(^|\s)border(\s|$)/);
  });
});

describe('the version history (issue #246)', () => {
  it('Settings has a Version history section in its navigation', async () => {
    window.location.hash = '#settings';
    await render('../../ui/src/views/settings.tsx', 'Settings');
    const link = document.querySelector<HTMLAnchorElement>('[data-slot="settings-nav"] a[href="#settings/version-history"]');
    expect(link?.textContent).toBe('Version history');
  });

  it('Settings → Version history lists each version, newest first, with its day and what it brought; the installed one marked', async () => {
    window.location.hash = '#settings/version-history';
    await render('../../ui/src/views/settings.tsx', 'Settings');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const rows = [...document.querySelectorAll('[data-slot="version-history"] [data-slot="version"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('c0ffee1');
    expect(rows[0]!.textContent).toContain('installed');
    expect(rows[0]!.textContent).toContain('You can now do the newest thing.');
    expect(rows[1]!.textContent).toContain('abcdef1');
    expect(rows[1]!.textContent).not.toContain('installed');
    expect(rows[1]!.textContent).toContain('Another older change.');
  });
});

describe('a build that does not know all of itself (issue #409)', () => {
  const partial = {
    versions: [],
    build: { kind: 'image', repo: 'https://github.com/o/r.git', branch: 'stable', installedAt: '2026-10-07T12:00:00Z' },
    reason: 'this build does not know its commit: it was built without it (build the image with scripts/build-image.sh)',
  };
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  it('Version history still shows the version, repository, branch and build time, with a short note on the missing commit', async () => {
    window.location.hash = '#settings/version-history';
    await render('../../ui/src/views/settings.tsx', 'Settings', { history: partial, update: { ...UPDATE, state: 'unavailable', installed: undefined, reason: partial.reason } });
    await settle();
    const build = document.querySelector('[data-slot="build-info"]')?.textContent ?? '';
    expect(build).toContain('0.1.0');
    expect(build).toContain('https://github.com/o/r.git');
    expect(build).toContain('stable');
    expect(build).toContain('image');
    expect(build).toMatch(/Commit\s*unknown/);
    expect(document.querySelector('[data-slot="build-note"]')?.textContent).toContain('does not know its commit');
  });

  it('a whole build shows its commit beside the versions, and no note', async () => {
    window.location.hash = '#settings/version-history';
    await render('../../ui/src/views/settings.tsx', 'Settings');
    await settle();
    expect(document.querySelector('[data-slot="build-info"]')?.textContent).toContain('c0ffee1');
    expect(document.querySelector('[data-slot="build-note"]')).toBeNull();
    expect(document.querySelectorAll('[data-slot="version-history"] [data-slot="version"]')).toHaveLength(2);
  });

  it('an image build offers no Update now: it says to pull the image', async () => {
    window.location.hash = '#settings/version';
    const target = { commit: 'beef'.padEnd(40, '0'), ref: 'stable' };
    await render('../../ui/src/views/settings.tsx', 'Settings', { update: { ...UPDATE, state: 'available', target, installed: { ...UPDATE.installed, kind: 'image' } } });
    const details = document.querySelector('[data-slot="version-details"]');
    expect([...details!.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Update now');
    expect(details!.textContent).toMatch(/pull the stable image/);
  });
});

describe('a container install is updated by its user (issue #494)', () => {
  const target = { commit: 'beef'.padEnd(40, '0'), ref: 'dev' };
  const image = { ...UPDATE, state: 'available', channel: 'dev', target, restartBlockers: 2, installed: { ...UPDATE.installed, kind: 'image' } };
  const autoUpdate = () => document.querySelector('[data-slot="version-details"] [aria-label="Auto-update"]');

  it('Version offers no Auto-update switch on an image install, and says why', async () => {
    window.location.hash = '#settings/version';
    await render('../../ui/src/views/settings.tsx', 'Settings', { update: { ...image, autoUpdate: true } });
    expect(autoUpdate()).toBeNull();
    expect(document.querySelector('[data-slot="auto-update-image"]')?.textContent).toMatch(/Auto-update does not apply to a container/);
  });

  it('a host install keeps the Auto-update switch', async () => {
    window.location.hash = '#settings/version';
    await render('../../ui/src/views/settings.tsx', 'Settings');
    expect(autoUpdate()).not.toBeNull();
    expect(document.querySelector('[data-slot="image-update"]')).toBeNull();
  });

  it('Version gives the copyable commands for the selected channel\'s tag, the tag mismatch and the restart-blocker count', async () => {
    window.location.hash = '#settings/version';
    await render('../../ui/src/views/settings.tsx', 'Settings', { update: image });
    const block = document.querySelector('[data-slot="image-update"]')!;
    const text = block.textContent ?? '';
    expect(text).toContain('HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:dev');
    expect(text).toContain('podman compose pull hopper && podman compose up -d --force-recreate --no-deps hopper');
    expect(text).toContain('docker compose pull hopper && docker compose up -d --force-recreate --no-deps hopper');
    expect(text).toContain('podman image prune -f --filter label=org.opencontainers.image.title=hopper');
    expect(text).toContain('this container runs the stable image; the selected channel is dev: switch the image tag');
    expect(text).toContain('2 running jobs would be lost');
    expect([...block.querySelectorAll('button')].filter((b) => b.textContent === 'Copy').length).toBeGreaterThanOrEqual(3);
  });

  it('the update notice gives the same commands and the restart-blocker count', async () => {
    await render('../../ui/src/app/update.tsx', 'UpdateNotice', { update: image });
    const notice = document.querySelector('[data-update-notice]')!;
    expect(notice.textContent).toContain('podman compose pull hopper && podman compose up -d --force-recreate --no-deps hopper');
    expect(notice.textContent).toContain('HOPPER_IMAGE=ghcr.io/henningfutrell/hopper:dev');
    expect(notice.textContent).toContain('2 running jobs would be lost');
    expect([...notice.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Update now');
  });
});

describe('the release notes in Version and updates (issue #493)', () => {
  const TARGET = 'beef123'.padEnd(40, '0');
  const notes = (n: number, what: string) => Array.from({ length: n }, (_, i) => `${what} change ${i + 1}.`);
  const pending = (o: Record<string, unknown> = {}) => ({ ...UPDATE, state: 'available', target: { commit: TARGET, ref: 'stable' }, whatsNew: notes(2, 'Update'), ...o });
  const details = () => document.querySelector('[data-slot="version-details"]')!;
  const section = (name: string) => details().querySelector(`[data-slot="${name}"]`);

  it('names each list for what it is: the update brings the target commit, the installed one is already running', async () => {
    window.location.hash = '#settings/version';
    await render('../../ui/src/views/settings.tsx', 'Settings', { update: pending() });
    expect(section('update-notes')?.querySelector('h3')?.textContent).toBe('Coming in the update · stable beef123');
    expect(section('installed-notes')?.querySelector('h3')?.textContent).toBe('Already installed · stable c0ffee1');
    expect(section('update-notes')?.textContent).toContain('Update change 1.');
    expect(section('installed-notes')?.textContent).toContain('You can now do the newest thing.');
    const both = [...details().querySelectorAll('[data-slot$="-notes"]')].map((e) => e.getAttribute('data-slot'));
    expect(both).toEqual(['update-notes', 'installed-notes']);
  });

  it('no list scrolls in a box of its own', async () => {
    window.location.hash = '#settings/version';
    await render('../../ui/src/views/settings.tsx', 'Settings', { update: pending({ whatsNew: notes(40, 'Update') }) });
    expect(details().querySelector('[class*="overflow-y-auto"], [class*="max-h-"]')).toBeNull();
  });

  it('a long list shows its first five and a Show all that opens the rest in place', async () => {
    window.location.hash = '#settings/version';
    await render('../../ui/src/views/settings.tsx', 'Settings', { update: pending({ whatsNew: notes(8, 'Update') }) });
    const update = section('update-notes')!;
    expect(update.querySelectorAll('li')).toHaveLength(5);
    const more = [...update.querySelectorAll('button')].find((b) => b.textContent === 'Show all 8');
    expect(more).toBeDefined();
    await act(async () => more!.click());
    expect(update.querySelectorAll('li')).toHaveLength(8);
    expect([...update.querySelectorAll('button')].map((b) => b.textContent)).toContain('Show fewer');
  });

  it('with no update pending there is no update list, and the installed one reads on its own', async () => {
    window.location.hash = '#settings/version';
    await render('../../ui/src/views/settings.tsx', 'Settings');
    expect(section('update-notes')).toBeNull();
    expect(section('installed-notes')?.querySelector('h3')?.textContent).toBe('In this version · stable c0ffee1');
  });

  it('the header sheet shows the same lists', async () => {
    await render('../../ui/src/app/header.tsx', 'Header', { update: pending() });
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Version and updates"]')!.click());
    const sheet = document.querySelector('[data-slot="version-details"]');
    expect(sheet?.querySelector('[data-slot="update-notes"] h3')?.textContent).toBe('Coming in the update · stable beef123');
    expect(sheet?.querySelector('[data-slot="installed-notes"] h3')?.textContent).toBe('Already installed · stable c0ffee1');
  });

  it("the update notice's What's new still opens the update's notes", async () => {
    await render('../../ui/src/app/update.tsx', 'UpdateNotice', { update: pending() });
    const open = [...document.querySelectorAll('button')].find((b) => b.textContent === "What's new");
    await act(async () => open!.click());
    expect(document.querySelector('[data-update-notice]')?.textContent).toContain('Update change 2.');
  });
});
