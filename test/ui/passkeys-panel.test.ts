// @vitest-environment happy-dom
// Passkeys for local accounts (issue #1380, design.md "Passkeys for local accounts"), in the UI. Settings → Sign-in → Your
// passkeys: a session of a local account lists its passkeys, adds one under a name (the creation options, the browser's
// WebAuthn answer, then POST /ui/api/local-accounts/passkeys) and removes one; another session is offered none. The
// landing page offers "Sign in with a passkey" while a local account has one: the options, the browser's answer, then
// POST /ui/auth/passkey. The browser's WebAuthn calls (@simplewebauthn/browser) are faked; the daemon's HTTP too.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: vi.fn(async () => ({ id: 'new-key', type: 'public-key', response: {} })),
  startAuthentication: vi.fn(async () => ({ id: 'old-key', type: 'public-key', response: {} })),
}));

let posts: { path: string; body: Record<string, unknown> }[] = [];
let passkeys = [{ id: 'old-key', name: 'Laptop', rpId: 'localhost', createdAt: '2026-10-15T00:00:00.000Z', lastUsedAt: '2026-10-16T00:00:00.000Z' }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeDaemon(session?: unknown) {
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    if (init.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    if (path === '/ui/api/session' && session) return json(session);
    if (path === '/api/realms') return json({ version: 'v1', local: true, none: null, origin: location.origin, sessions: { idleHours: 168, maxHours: 720 }, githubAdmin: null, people: [], realms: [] });
    if (path === '/api/local-accounts/passkeys') return json({ passkeys });
    if (path === '/ui/api/local-accounts/passkeys/options') return json({ challenge: 'c1', rp: { id: 'localhost' }, user: { id: 'u', name: 'ada@example.com' } });
    if (path === '/ui/api/local-accounts/passkeys') {
      passkeys = [...passkeys, { id: 'new-key', name: 'Phone', rpId: 'localhost', createdAt: '2026-10-16T00:00:00.000Z' }] as typeof passkeys;
      return json({ passkeys });
    }
    if (path === '/ui/api/local-accounts/passkeys/remove') { passkeys = passkeys.filter((p) => p.id !== 'old-key'); return json({ passkeys }); }
    if (path === '/ui/auth/passkey/options') return json({ flow: 'f1', options: { challenge: 'c2', rpId: 'localhost' } });
    if (path === '/ui/auth/passkey') return json({ token: 'a'.repeat(64), expiresAt: '2026-10-17T00:00:00.000Z' });
    return json({ error: 'not found' }, 404);
  });
}

let root: Root | undefined;
const section = (name: string) => document.querySelector<HTMLElement>(`[data-section="${name}"]`);
const button = (el: ParentNode, label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
const click = async (b: HTMLElement | undefined) => { expect(b).toBeDefined(); await act(async () => { b!.click(); }); };
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function settings(realm: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal('fetch', fakeDaemon());
  const store = '../../ui/src/store/index.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role: 'viewer', realm, identity: 'ada@example.com', superAdmin: false, instanceAdmin: false } });
  const mod = '../../ui/src/views/realms.tsx';
  const { Realms } = (await import(mod)) as { Realms: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(Realms)); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  posts = [];
  passkeys = passkeys.slice(0, 1);
  vi.unstubAllGlobals();
});

describe('Settings: your passkeys', () => {
  it('lists your passkeys, adds one under a name, and removes one', async () => {
    await settings('local-accounts');
    await vi.waitFor(() => expect(document.querySelector('[data-passkey="old-key"]')).not.toBeNull());
    const panel = section('own-passkeys')!;
    expect(panel.textContent).toContain('Laptop');
    expect(panel.textContent).toContain('localhost');
    await type(panel.querySelector<HTMLInputElement>('[aria-label="Passkey name"]')!, 'Phone');
    await click(button(panel, 'Add passkey'));
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/api/local-accounts/passkeys', body: { name: 'Phone', response: { id: 'new-key', type: 'public-key', response: {} } } }));
    expect(posts.map((p) => p.path)).toContain('/ui/api/local-accounts/passkeys/options');
    await vi.waitFor(() => expect(document.querySelector('[data-passkey="new-key"]')).not.toBeNull());
    await click(button(document.querySelector<HTMLElement>('[data-passkey="old-key"]')!, 'Remove passkey Laptop'));
    const dialog = await vi.waitFor(() => { const d = document.querySelector<HTMLElement>('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    await click(button(dialog, 'Remove'));
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/api/local-accounts/passkeys/remove', body: { id: 'old-key' } }));
    await vi.waitFor(() => expect(document.querySelector('[data-passkey="old-key"]')).toBeNull());
  });

  it('a session that did not sign in with a local account is offered none', async () => {
    await settings('github');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Sign-in'));
    expect(section('own-passkeys')).toBeNull();
  });
});

describe('the landing page: sign in with a passkey', () => {
  async function landing(offerPasskeys: boolean) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '<div id="root"></div>';
    localStorage.clear();
    const signIn = { local: true, none: null, password: true, passkeys: offerPasskeys, gateway: false, origin: location.origin, realms: [], devices: [], required: false };
    vi.stubGlobal('fetch', fakeDaemon({ authenticated: false, signIn }));
    vi.stubGlobal('EventSource', class { addEventListener(): void {} close(): void {} });
    vi.resetModules();
    const app = '../../ui/src/app/app.tsx';
    const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
    await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="landing"]')).not.toBeNull());
  }

  it('offers the passkey while a local account has one, and signs in with its answer', async () => {
    await landing(true);
    await click(button(document.body, 'Sign in with a passkey'));
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/auth/passkey', body: { flow: 'f1', response: { id: 'old-key', type: 'public-key', response: {} } } }));
    await vi.waitFor(() => expect(localStorage.getItem('jh_session')).toBe('a'.repeat(64)));
  });

  it('offers no passkey while no local account has one', async () => {
    await landing(false);
    expect(button(document.body, 'Sign in with a passkey')).toBeUndefined();
  });
});
