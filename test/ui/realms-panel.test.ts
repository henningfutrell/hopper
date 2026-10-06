// @vitest-environment happy-dom
// Settings → Sign-in (issues #185, #200): the realms in the order sign-in tries and shows them, each on
// or off, moved up or down, edited in a form of its own fields or removed; a realm added from the form
// of the chosen type; the login code and no sign-in. No password accounts (issue #237). No YAML anywhere. Every change posts
// POST /ui/api/realms with the version it read; a refusal is shown where it was made. A session that is
// not admin sees none of it. Rendered against a fake of the daemon's HTTP.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

let posts: Record<string, unknown>[] = [];
let refuse: string | undefined;

const VIEW = {
  version: 'v1', local: true, none: null, origin: 'http://localhost:4790',
  realms: [
    { name: 'staff', label: 'Staff', type: 'saml', enabled: true, settings: { entryPoint: 'https://idp.example.com/sso', idpCert: 'abc' }, secrets: [], callback: 'http://localhost:4790/ui/auth/staff/callback', metadata: 'http://localhost:4790/ui/auth/staff/metadata' },
    {
      name: 'corp', label: 'Corp SSO', type: 'oidc', enabled: false, callback: 'http://localhost:4790/ui/auth/corp/callback', secrets: ['clientSecret'],
      settings: { issuer: 'https://idp.example.com', clientId: 'c', roles: { admin: { emails: ['a@example.com'] }, defaultRole: 'viewer' } },
    },
  ],
};

function fakeDaemon() {
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (String(input) === '/api/realms') return json(VIEW);
    if (String(input) === '/api/users') return json({ users: [{ id: 'admin', name: 'admin', createdAt: '2026-10-01T00:00:00.000Z' }, { id: 'bea', name: 'Bea', createdAt: '2026-10-02T00:00:00.000Z' }] });
    if (String(input) === '/ui/api/realms') {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return refuse ? json({ error: refuse }, 400) : json({ ...VIEW, version: 'v2' });
    }
    return json({ error: 'not found' }, 404);
  });
}

let root: Root | undefined;

async function render(role: 'admin' | 'operator') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  posts = [];
  refuse = undefined;
  vi.stubGlobal('fetch', fakeDaemon());
  const store = '../../ui/src/store/index.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'admin', name: 'admin', role, realm: 'local', identity: 'login code' } });
  const mod = '../../ui/src/views/realms.tsx';
  const { Realms } = (await import(mod)) as { Realms: () => ReturnType<typeof createElement> };
  await act(async () => {
    root = createRoot(document.getElementById('root')!);
    root.render(createElement(Realms));
  });
}

const row = (name: string) => document.querySelector<HTMLElement>(`[data-realm="${name}"]`)!;
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-realm]')].map((e) => e.dataset.realm);
const buttonIn = (el: ParentNode, label: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
const click = async (b: HTMLElement | undefined) => { expect(b).toBeDefined(); await act(async () => { b!.click(); }); };
const field = (label: string) => document.querySelector<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Settings: Sign-in', () => {
  it('lists the realms in order, with their type, whether each is on, and the callback to register', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toEqual(['staff', 'corp']));
    expect(row('staff').textContent).toContain('Staff');
    expect(row('staff').textContent).toContain('saml');
    expect(row('staff').querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    expect(row('corp').querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    expect(row('corp').textContent).toContain('http://localhost:4790/ui/auth/corp/callback');
  });

  it('turns a realm on and moves it up, with the version it read', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await click(row('corp').querySelector<HTMLElement>('[role="switch"]')!);
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'enable', name: 'corp', enabled: true, version: 'v1' }));
    await click(buttonIn(row('corp'), 'Move up'));
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'move', name: 'corp', to: 0, version: 'v2' }));
  });

  it('adds a realm from the fields of the chosen type: no YAML', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await click(buttonIn(document, 'Add realm'));
    await act(async () => type(field('Realm type'), 'ldap'));
    expect(document.querySelector('textarea[aria-label="Realm"]')).toBeNull();
    await act(async () => type(field('Name'), 'dir'));
    await act(async () => type(field('Label'), 'Directory'));
    await act(async () => type(field('Directory URL'), 'ldaps://ldap.example.com'));
    await act(async () => type(field('User base'), 'dc=example,dc=com'));
    await act(async () => type(field('Group attribute'), 'memberOf'));
    await click(buttonIn(document, 'Save'));
    await vi.waitFor(() => expect(posts).toContainEqual({
      action: 'save', version: 'v1',
      realm: { name: 'dir', label: 'Directory', type: 'ldap', url: 'ldaps://ldap.example.com', userBase: 'dc=example,dc=com', attributes: { groups: 'memberOf' } },
    }));
  });

  it('edits a realm in its form, its role rules with it; a refusal is shown in place', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await click(buttonIn(row('corp'), 'Edit'));
    expect(field('Issuer URL').value).toBe('https://idp.example.com');
    expect(field('Default role').value).toBe('viewer');
    expect(field('Rule 1 values').value).toBe('a@example.com');
    await act(async () => type(field('Client ID'), 'hopper'));
    refuse = 'invalid sign-in config: realms.1.scopes: must not be empty';
    await click(buttonIn(document, 'Save'));
    await vi.waitFor(() => expect(posts).toContainEqual({
      action: 'save', name: 'corp', version: 'v1',
      realm: { name: 'corp', label: 'Corp SSO', type: 'oidc', issuer: 'https://idp.example.com', clientId: 'hopper', roles: { admin: { emails: ['a@example.com'] }, defaultRole: 'viewer' } },
    }));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('must not be empty'));
  });

  it('a secret is typed into a password field, never shown; empty keeps the stored one, Remove clears it (issue #216)', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await click(buttonIn(row('corp'), 'Edit'));
    const secret = field('Client secret');
    expect(secret.type).toBe('password');
    expect(secret.value).toBe('');
    expect(secret.placeholder).toMatch(/set.*empty keeps it/i);
    await act(async () => type(secret, 'typed-in'));
    await click(buttonIn(document, 'Save'));
    await vi.waitFor(() => expect(posts.at(-1)).toMatchObject({ action: 'save', realm: { clientSecret: 'typed-in' } }));
    await click(buttonIn(row('corp'), 'Edit'));
    await click(buttonIn(document, 'Remove client secret'));
    await click(buttonIn(document, 'Save'));
    await vi.waitFor(() => expect(posts.at(-1)).toMatchObject({ action: 'save', realm: { clientSecret: null } }));
  });

  it('a realm set up by the environment says so: the next start sets it again', async () => {
    (VIEW.realms[1] as { environment?: boolean }).environment = true;
    try {
      await render('admin');
      await vi.waitFor(() => expect(rows()).toHaveLength(2));
      expect(row('corp').textContent).toContain('from the environment');
      expect(row('staff').textContent).not.toContain('from the environment');
    } finally {
      delete (VIEW.realms[1] as { environment?: boolean }).environment;
    }
  });

  it('offers no password realm to add: the hopper keeps no password accounts (issue #237)', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await click(buttonIn(document.body, 'Add realm'));
    const types = [...field('Realm type').querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value);
    expect(types).toEqual(['ldap', 'oidc', 'github', 'saml', 'gateway']);
    expect(document.querySelector('[data-account]')).toBeNull();
  });

  it('a session that is not admin sees no realms', async () => {
    await render('operator');
    expect(document.body.textContent).toContain('Only an admin manages sign-in.');
    expect(rows()).toEqual([]);
    expect(buttonIn(document, 'Add realm')).toBeUndefined();
  });
});
