// @vitest-environment happy-dom
// Signing in with GitHub (issue #214), on the landing page: a button per GitHub realm that is
// on; pressed, it shows the device code and the link to enter it at, and follows the sign-in until the
// person approves it there — then the page loads signed in. When the hopper can send the browser to
// GitHub and back (issue #258: the runtime gives the app's client secret, and this is the sign-in origin), the
// button does that instead, and the device code is the fallback a link away. Rendered in happy-dom, the whole app
// against a fake of the daemon's HTTP.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const OFFER = {
  local: false, none: null, password: true, gateway: false, origin: location.origin, realms: [], required: false,
  devices: [{ name: 'github', label: 'GitHub', type: 'github' }],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;
let approved = false;
let offer: Omit<typeof OFFER, 'devices'> & { devices: { name: string; label: string; type: string; redirect?: boolean }[] } = OFFER;
const posts: { path: string; body: Record<string, unknown> }[] = [];

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: false, signIn: offer });
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    if (path === '/ui/auth/github/device') return json({ flow: 'f1', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: '2099-01-01T00:00:00.000Z' });
    if (path === '/ui/auth/device/poll') return json(approved ? { state: 'signed-in', token: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' } : { state: 'waiting' });
    return json({ error: 'not found' }, 404);
  }));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  approved = false;
  offer = OFFER;
  posts.splice(0);
  vi.unstubAllGlobals();
});

const buttonNamed = (name: string) => vi.waitFor(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === name);
  expect(b).toBeDefined();
  return b!;
});

describe('landing: sign in with GitHub', () => {
  it('shows the code and the link, then signs in once the code is approved', async () => {
    await boot();
    const button = await vi.waitFor(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Sign in with GitHub');
      expect(b).toBeDefined();
      return b!;
    });
    await act(async () => { button.click(); });
    await vi.waitFor(() => expect(document.querySelector('[data-device-code]')?.textContent).toBe('WDJB-MJHT'));
    expect(document.querySelector<HTMLAnchorElement>('a[data-open-provider]')?.href).toBe('https://github.com/login/device');
    expect(document.body.textContent).toContain('github.com/login/device');
    const binding = posts.find((p) => p.path === '/ui/auth/github/device')!.body.binding as string;
    expect(binding).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    approved = true;
    await vi.waitFor(() => expect(localStorage.getItem('jh_session')).toBe('a'.repeat(64)), { timeout: 5000 });
    expect(posts.filter((p) => p.path === '/ui/auth/device/poll').every((p) => p.body.flow === 'f1' && p.body.binding === binding)).toBe(true);
  });

  it('the code panel is laid out around the code: centred, a copy button, and GitHub one press away', async () => {
    await boot();
    await act(async () => { (await buttonNamed('Sign in with GitHub')).click(); });
    const panel = await vi.waitFor(() => { const p = document.querySelector('[data-device-sign-in]'); expect(p).not.toBeNull(); return p!; });
    expect(panel.className).toContain('text-center');
    expect(panel.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
    const open = panel.querySelector<HTMLAnchorElement>('a[data-open-provider]');
    expect(open?.href).toBe('https://github.com/login/device');
    expect(open?.target).toBe('_blank');
    // Back to the ways to sign in.
    await act(async () => { (await buttonNamed('Cancel')).click(); });
    await vi.waitFor(() => expect(document.querySelector('[data-device-sign-in]')).toBeNull());
  });

  it('the hopper can redirect: the button goes to GitHub and back; the code is the fallback', async () => {
    offer = { ...OFFER, devices: [{ ...OFFER.devices[0]!, redirect: true }] };
    await boot();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...location, origin: location.origin, assign });
    await act(async () => { (await buttonNamed('Sign in with GitHub')).click(); });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]![0])).toMatch(/^\/ui\/auth\/github\/start\?binding=[A-Za-z0-9_-]{32,128}$/);
    expect(posts.some((p) => p.path === '/ui/auth/github/device')).toBe(false);
    await act(async () => { (await buttonNamed('Use a code instead')).click(); });
    await vi.waitFor(() => expect(document.querySelector('[data-device-code]')?.textContent).toBe('WDJB-MJHT'));
  });
});
