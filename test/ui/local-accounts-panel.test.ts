// @vitest-environment happy-dom
// Settings → Sign-in → Local accounts (issue #1380): an admin sees the local accounts (email, role, the user each signs in
// as), adds one with an email, a role and a password, changes a role, sets a password and removes one — each a POST
// /ui/api/local-accounts. A session signed in with a local account changes its own password (POST
// /ui/api/local-accounts/password), an admin or not. Rendered against a fake of the daemon's HTTP.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

let posts: { path: string; body: Record<string, unknown> }[] = [];
const ACCOUNTS = { accounts: [{ email: 'ada@example.com', role: 'admin', createdAt: '2026-10-15T00:00:00.000Z', user: 'ada' }] };
const VIEW = {
  version: 'v1', local: true, none: null, origin: 'http://localhost:4790', sessions: { idleHours: 168, maxHours: 720 }, githubAdmin: null,
  people: [], realms: [],
};

function fakeDaemon() {
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const path = String(input);
    if (path === '/api/realms') return json(VIEW);
    if (path === '/api/local-accounts') return json(ACCOUNTS);
    if (path === '/ui/api/local-accounts' || path === '/ui/api/local-accounts/password') {
      posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return json(path.endsWith('password') ? { ok: true } : ACCOUNTS);
    }
    return json({ error: 'not found' }, 404);
  });
}

let root: Root | undefined;

async function render(o: { role: 'admin' | 'viewer'; realm: string }) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  posts = [];
  vi.stubGlobal('fetch', fakeDaemon());
  const store = '../../ui/src/store/index.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role: o.role, realm: o.realm, identity: 'ada@example.com', superAdmin: false, instanceAdmin: o.role === 'admin' } });
  const mod = '../../ui/src/views/realms.tsx';
  const { Realms } = (await import(mod)) as { Realms: () => ReturnType<typeof createElement> };
  await act(async () => {
    root = createRoot(document.getElementById('root')!);
    root.render(createElement(Realms));
  });
}

const section = (title: string) => document.querySelector<HTMLElement>(`[data-section="${title}"]`);
const buttonIn = (el: ParentNode, label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
const click = async (b: HTMLElement | undefined) => { expect(b).toBeDefined(); await act(async () => { b!.click(); }); };
const field = (el: ParentNode, label: string) => el.querySelector<HTMLInputElement & HTMLSelectElement>(`[aria-label="${label}"]`)!;
async function type(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const submit = async (form: HTMLFormElement) => { await act(async () => { form.requestSubmit(); }); };

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Settings: Sign-in → Local accounts', () => {
  it('lists the accounts with their role and user; adds one with an email, a role and a password', async () => {
    await render({ role: 'admin', realm: 'github' });
    await vi.waitFor(() => expect(document.querySelector('[data-account="ada@example.com"]')).not.toBeNull());
    const panel = section('local-accounts')!;
    expect(panel.textContent).toContain('user ada');
    expect(field(panel, 'Role of ada@example.com').value).toBe('admin');
    await click(buttonIn(document.body, 'Add account'));
    const form = panel.querySelector<HTMLFormElement>('[data-account-form]')!;
    await type(field(form, 'Email'), 'bea@example.com');
    await type(field(form, 'Role'), 'viewer');
    await type(field(form, 'Password'), 'a long enough password');
    await submit(form);
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/api/local-accounts', body: { action: 'save', email: 'bea@example.com', role: 'viewer', password: 'a long enough password' } }));
  });

  it('changes a role, sets a password and removes an account', async () => {
    await render({ role: 'admin', realm: 'github' });
    await vi.waitFor(() => expect(document.querySelector('[data-account="ada@example.com"]')).not.toBeNull());
    const row = document.querySelector<HTMLElement>('[data-account="ada@example.com"]')!;
    await type(field(row, 'Role of ada@example.com'), 'operator');
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/api/local-accounts', body: { action: 'save', email: 'ada@example.com', role: 'operator' } }));
    await click(buttonIn(row, 'Set password'));
    await type(field(row, 'New password'), 'another long password');
    await submit(row.querySelector('form')!);
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/api/local-accounts', body: { action: 'save', email: 'ada@example.com', role: 'admin', password: 'another long password' } }));
    await click(buttonIn(row, 'Remove'));
    const dialog = await vi.waitFor(() => { const d = document.querySelector<HTMLElement>('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    await click(buttonIn(dialog, 'Remove'));
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/api/local-accounts', body: { action: 'remove', email: 'ada@example.com' } }));
  });

  it('a session of a local account changes its own password, an admin or not; another session is offered none', async () => {
    await render({ role: 'viewer', realm: 'local-accounts' });
    const own = section('own-password')!;
    expect(own).not.toBeNull();
    expect(section('local-accounts')).toBeNull();
    await type(field(own, 'Current password'), 'the old password');
    await type(field(own, 'New password'), 'the new long password');
    await submit(own as HTMLFormElement);
    await vi.waitFor(() => expect(posts).toContainEqual({ path: '/ui/api/local-accounts/password', body: { current: 'the old password', password: 'the new long password' } }));
    await act(async () => root?.unmount());
    await render({ role: 'admin', realm: 'github' });
    await vi.waitFor(() => expect(section('local-accounts')).not.toBeNull());
    expect(section('own-password')).toBeNull();
  });
});
