// @vitest-environment happy-dom
// Signing in with GitHub (issue #214), on the landing page: a button per GitHub realm that is
// on; pressed, it shows the device code and the link to enter it at, and follows the sign-in until the
// person approves it there — then the page loads signed in. Rendered in happy-dom, the whole app
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
const posts: { path: string; body: Record<string, unknown> }[] = [];

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: false, signIn: OFFER });
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
  posts.splice(0);
  vi.unstubAllGlobals();
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
    expect(document.body.textContent).toContain('https://github.com/login/device');
    const binding = posts.find((p) => p.path === '/ui/auth/github/device')!.body.binding as string;
    expect(binding).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    approved = true;
    await vi.waitFor(() => expect(localStorage.getItem('jh_session')).toBe('a'.repeat(64)), { timeout: 5000 });
    expect(posts.filter((p) => p.path === '/ui/auth/device/poll').every((p) => p.body.flow === 'f1' && p.body.binding === binding)).toBe(true);
  });
});
