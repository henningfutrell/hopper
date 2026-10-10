// @vitest-environment happy-dom
// Issue #666: on a phone the top bar had the theme switch, the user's name and role, the device link and
// Log out side by side, small and close, so a tap hit the wrong one. Now the top bar keeps the logo, the
// version badge with its channel and the connection dot, and one user menu button — the user's initials —
// opens a menu with the name and role, the theme, the device link and, last and set apart, Sign out, which
// needs a second tap. Same at every width. Rendered against the store and a fake of the daemon's HTTP.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
const store = '../../ui/src/store/index.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
interface Store { useHopper: { setState(s: Record<string, unknown>): void } }
const offer = { local: true, none: null, password: false, origin: 'http://localhost:4790', realms: [], required: true };
const ADMIN = { id: 'bea', name: 'Bea Lind', role: 'admin', realm: 'corp', identity: 'bea' };
const UPDATE = {
  state: 'current', channel: 'beta', autoUpdate: false, whatsNew: [], restartBlockers: 0, checkedAt: '2026-10-06T10:01:00Z',
  installed: { kind: 'image', repo: 'ghcr.io/o/r', branch: 'beta', commit: 'c0ffee1'.padEnd(40, '0'), installedAt: '2026-10-06T10:00:00Z' },
};
let posts: string[] = [];
let root: Root | undefined;

async function render(user: Record<string, unknown> = ADMIN) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    if (init.method === 'POST') posts.push(String(path));
    return new Response('{}', { status: String(path) === '/ui/api/logout' ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }));
  const { useHopper } = (await import(store)) as Store;
  useHopper.setState({ authed: true, conn: 'live', signIn: offer, user, update: UPDATE, health: { ok: true, version: '0.1.0', router: 'gate', fallback: false, executors: [], uptimeS: 1 } });
  const { Header } = (await import('../../ui/src/app/header.tsx')) as { Header: () => El };
  const tooltip = '../../ui/src/components/ui/tooltip.tsx';
  const { TooltipProvider } = (await import(tooltip)) as { TooltipProvider: (p: { children?: unknown }) => El };
  await act(async () => {
    root = createRoot(document.getElementById('root')!);
    root.render(createElement(TooltipProvider, null, createElement(Header)));
  });
}

/** Hidden below the `sm` breakpoint (a phone) by its own classes or an ancestor's. */
function hiddenOnPhone(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    const classes = (e.getAttribute('class') ?? '').split(/\s+/);
    if (classes.some((c) => ['hidden', 'max-sm:hidden', 'sr-only', 'max-sm:sr-only'].includes(c))) return true;
  }
  return false;
}

const trigger = () => document.querySelector<HTMLElement>('header [data-slot="user-menu-trigger"]');
const menu = () => document.querySelector<HTMLElement>('[data-slot="user-menu"]');
const items = () => [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
const item = (text: RegExp) => items().find((i) => text.test(i.textContent ?? ''));

async function openMenu() {
  const t = trigger();
  expect(t).not.toBeNull();
  await act(async () => { t!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await vi.waitFor(() => expect(menu()).not.toBeNull());
}
const select = async (el: HTMLElement) => { await act(async () => { el.click(); }); };

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the top bar on a phone (issue #666)', () => {
  it('shows only the logo, the version badge with its channel, the connection dot and the user menu button', async () => {
    await render();
    const header = document.querySelector('header')!;
    const controls = [...header.querySelectorAll<HTMLElement>('button, a')].filter((c) => !hiddenOnPhone(c));
    expect(controls.map((c) => c.getAttribute('aria-label'))).toEqual(['Version and updates: beta', 'User menu: Bea Lind, admin']);
    expect(header.querySelector('img')).not.toBeNull();
    expect(hiddenOnPhone(header.querySelector('[data-slot="badge-channel"]'))).toBe(false);
    expect(hiddenOnPhone(header.querySelector('[data-slot="connection"]'))).toBe(false);
    expect(header.textContent).not.toContain('Bea Lind');
  });

  it('the user menu button shows the user\'s initials and is at least 44 px', async () => {
    await render();
    expect(trigger()?.textContent).toBe('BL');
    expect(trigger()?.className).toMatch(/(^|\s)size-11(\s|$)/);
  });
});

describe('the user menu (issue #666)', () => {
  it('names the user and role, then the theme and the device link, with Sign out last and set apart', async () => {
    await render();
    await openMenu();
    const text = menu()!.textContent ?? '';
    expect(text).toContain('Bea Lind');
    expect(text).toContain('admin');
    const labels = items().map((i) => i.textContent?.trim());
    expect(labels[0]).toMatch(/^(Light|Dark) theme$/);
    expect(labels.slice(1)).toEqual(['Log in another device', 'Sign out']);
    const separator = menu()!.querySelector('[role="separator"]:last-of-type');
    expect(separator?.nextElementSibling).toBe(item(/Sign out/));
    for (const i of items()) expect(i.className).toMatch(/(^|\s)min-h-11(\s|$)/);
  });

  it('has no device link for a user who is not admin', async () => {
    await render({ ...ADMIN, role: 'operator' });
    await openMenu();
    expect(items().map((i) => i.textContent?.trim()).slice(1)).toEqual(['Sign out']);
    expect(items()).toHaveLength(2);
  });

  it('Sign out needs a second tap', async () => {
    await render();
    await openMenu();
    await select(item(/Sign out/)!);
    expect(posts).not.toContain('/ui/api/logout');
    expect(menu()).not.toBeNull();
    expect(item(/Tap again to sign out/)).toBeTruthy();
    await select(item(/Tap again to sign out/)!);
    await vi.waitFor(() => expect(posts).toContain('/ui/api/logout'));
  });

  it('a menu opened again asks for both taps again', async () => {
    await render();
    await openMenu();
    await select(item(/Sign out/)!);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await vi.waitFor(() => expect(menu()).toBeNull());
    await openMenu();
    expect(item(/Tap again/)).toBeUndefined();
    expect(posts).not.toContain('/ui/api/logout');
  });

  it('Escape closes it', async () => {
    await render();
    await openMenu();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await vi.waitFor(() => expect(menu()).toBeNull());
  });

  it('the theme item switches the theme and keeps the menu open', async () => {
    await render();
    await openMenu();
    const before = document.documentElement.classList.contains('dark');
    await select(item(/theme/)!);
    expect(document.documentElement.classList.contains('dark')).toBe(!before);
    expect(menu()).not.toBeNull();
  });
});
