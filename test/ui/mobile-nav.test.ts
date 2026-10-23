// @vitest-environment happy-dom
// Issue #905: on a phone the navigation drawer lists more entries than the screen is high. The drawer's list scrolls on
// its own, inside the drawer's full height and clear of the bottom safe area, so every entry can be reached; the close
// button stays outside the list, so it never scrolls away. happy-dom lays nothing out, so the test reads the classes
// that make the list scroll, at a phone's width and height.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

type Component = (p: { view: string }) => ReturnType<typeof createElement>;
const navPath = '../../ui/src/app/nav.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
const { MobileNav, Sidebar, VIEWS, viewLabel } = (await import(navPath)) as {
  MobileNav: Component; Sidebar: Component; VIEWS: readonly string[]; viewLabel: (v: string) => string;
};

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

async function openDrawer() {
  Object.assign(window, { innerWidth: 390, innerHeight: 664 });
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => root!.render(createElement(MobileNav, { view: 'dashboard' })));
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]')!;
  await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  return document.querySelector<HTMLElement>('[data-slot="sheet-content"]')!;
}

const classes = (el: Element) => el.getAttribute('class')!.split(/\s+/);

describe('the navigation drawer at a phone width', () => {
  it('lists every view inside one list that scrolls on its own', async () => {
    const drawer = await openDrawer();
    const list = drawer.querySelector<HTMLElement>('[data-slot="nav-scroll"]');
    expect(list).not.toBeNull();
    expect(classes(list!)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-contain']));
    const labels = [...list!.querySelectorAll('a')].map((a) => a.textContent);
    // Every view, in its nav group's order (issue #906): the groups set the order, not VIEWS. No Search: the command
    // palette's button is in the header at every width (issue #2661).
    expect([...labels].sort()).toEqual([...VIEWS.map(viewLabel)].sort());
  });

  it('keeps the drawer to the screen height and the list clear of the bottom safe area', async () => {
    const drawer = await openDrawer();
    expect(classes(drawer)).toEqual(expect.arrayContaining(['data-[side=left]:inset-y-0', 'max-h-dvh', 'flex', 'flex-col']));
    const list = drawer.querySelector('[data-slot="nav-scroll"]')!;
    expect(list.getAttribute('class')).toContain('pb-[max(0.75rem,env(safe-area-inset-bottom))]');
  });

  it('keeps the close button out of the list, so it does not scroll away', async () => {
    const drawer = await openDrawer();
    const close = drawer.querySelector('[data-slot="sheet-close"]');
    expect(close).not.toBeNull();
    expect(drawer.querySelector('[data-slot="nav-scroll"]')!.contains(close)).toBe(false);
  });
});

describe('the sidebar on a wide screen', () => {
  it('scrolls its list when the window is not high enough', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    await act(async () => root!.render(createElement(Sidebar, { view: 'dashboard' })));
    expect(classes(document.querySelector('aside')!)).toContain('overflow-y-auto');
  });
});
