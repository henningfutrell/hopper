// @vitest-environment happy-dom
// Issue #167: the top bar always says who you are — the signed-in user and role, or "not signed in"
// and whose work a read without a session shows. With several users, a logged-out page reads none of
// it: the daemon's answer says sign-in is required, and the page offers only the ways to sign in.
// Rendered against a fake of the daemon's HTTP.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
const offer = (required: boolean) => ({ local: true, none: null, password: true, origin: 'http://localhost:4790', realms: [], required });
let reads: string[] = [];

function fakeDaemon(session: unknown) {
  return vi.fn(async (input: string) => {
    reads.push(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (String(input) === '/ui/api/session') return json(session);
    return json({ error: 'not found' }, 404);
  });
}

const store = '../../ui/src/store/index.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
interface Store { useHopper: { setState(s: Record<string, unknown>): void }; load(): Promise<boolean> }
let root: Root | undefined;

async function render(mod: string, name: string, state: Record<string, unknown>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal('fetch', fakeDaemon({ authenticated: false, signIn: offer(false) }));
  const { useHopper } = (await import(store)) as Store;
  useHopper.setState(state);
  const view = (await import(mod)) as Record<string, () => El>;
  const tooltip = '../../ui/src/components/ui/tooltip.tsx';
  const { TooltipProvider } = (await import(tooltip)) as { TooltipProvider: (p: { children?: unknown }) => El };
  await act(async () => {
    root = createRoot(document.getElementById('root')!);
    root.render(createElement(TooltipProvider, null, createElement(view[name]!)));
  });
}

const who = () => document.querySelector<HTMLElement>('[data-who]');

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  reads = [];
  vi.unstubAllGlobals();
});

describe('the top bar says who you are', () => {
  it('signed in: the user and role, at every width', async () => {
    await render('../../ui/src/app/header.tsx', 'Header', {
      authed: true, signIn: offer(true), viewing: null, user: { id: 'bea', name: 'Bea', role: 'operator', realm: 'password', identity: 'bea' },
    });
    expect(who()?.textContent).toContain('Bea');
    expect(who()?.textContent).toContain('operator');
    expect(who()?.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it('logged out: not signed in, and whose work the page shows', async () => {
    await render('../../ui/src/app/header.tsx', 'Header', { authed: false, user: null, signIn: offer(false), viewing: { id: 'owner', name: 'owner' } });
    expect(who()?.textContent).toContain('not signed in');
    expect(who()?.textContent).toContain('owner');
    expect(who()?.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });
});

describe('several users: sign in first', () => {
  it('a logged-out page reads no user\'s work when sign-in is required', async () => {
    vi.stubGlobal('fetch', fakeDaemon({ authenticated: false, viewing: { id: 'owner', name: 'owner' }, signIn: offer(true) }));
    const { load } = (await import(store)) as Store;
    expect(await load()).toBe(false);
    expect(reads).toEqual(['/ui/api/session']);
  });

  it('the sign-in screen offers the ways to sign in, and shows no work', async () => {
    await render('../../ui/src/app/banner.tsx', 'SignInRequired', { authed: false, user: null, signIn: offer(true), viewing: null });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Several people use this hopper');
    expect(document.querySelector('input[aria-label="Username"]')).toBeTruthy();
    expect(document.querySelector('input[aria-label="Login code"]')).toBeTruthy();
  });
});
