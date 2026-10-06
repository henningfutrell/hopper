// @vitest-environment happy-dom
// Settings → Sign-in (issue #185): the realms in the order sign-in tries and shows them, each on or off,
// moved up or down, edited as its YAML or removed; a realm added from a starting entry of its type; the
// login code and no sign-in. Every change posts POST /ui/api/realms with the version it read; a refusal
// is shown where it was made. A session that is not admin sees none of it. Rendered against a fake of
// the daemon's HTTP.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

let posts: Record<string, unknown>[] = [];
let refuse: string | undefined;

const VIEW = {
  version: 'v1', local: true, none: null, origin: 'http://localhost:4790',
  realms: [
    { name: 'staff', label: 'Staff', type: 'password', enabled: true, entry: 'name: staff\nlabel: Staff\ntype: password\nusers: []\n' },
    { name: 'corp', label: 'Corp SSO', type: 'oidc', enabled: false, entry: 'name: corp\nlabel: Corp SSO\ntype: oidc\nissuer: https://idp.example.com\nclientId: c\nenabled: false\n', callback: 'http://localhost:4790/ui/auth/corp/callback' },
  ],
};

function fakeDaemon() {
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (String(input) === '/api/realms') return json(VIEW);
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
  useHopper.setState({ authed: true, user: { id: 'owner', name: 'owner', role, realm: 'local', identity: 'login code' } });
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
function type(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
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
    expect(row('staff').textContent).toContain('password');
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

  it('adds a realm from a starting entry of the chosen type', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await click(buttonIn(document, 'Add realm'));
    await act(async () => type(document.querySelector<HTMLSelectElement>('select[aria-label="Realm type"]')!, 'ldap'));
    const editor = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Realm"]')!;
    expect(editor.value).toContain('type: ldap');
    await act(async () => type(editor, 'name: dir\ntype: ldap\nurl: ldaps://ldap.example.com\nuserBase: dc=example,dc=com\n'));
    await click(buttonIn(document, 'Save'));
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'save', entry: 'name: dir\ntype: ldap\nurl: ldaps://ldap.example.com\nuserBase: dc=example,dc=com\n', version: 'v1' }));
  });

  it('edits a realm as its YAML; a refusal is shown in place', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await click(buttonIn(row('staff'), 'Edit'));
    const editor = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Realm"]')!;
    expect(editor.value).toBe(VIEW.realms[0]!.entry);
    refuse = 'invalid auth.yaml: realms.0.users.0.passwordHash: must be an argon2id hash';
    await click(buttonIn(document, 'Save'));
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'save', name: 'staff', entry: VIEW.realms[0]!.entry, version: 'v1' }));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('must be an argon2id hash'));
  });

  it('a session that is not admin sees no realms', async () => {
    await render('operator');
    expect(document.body.textContent).toContain('Only an admin manages sign-in.');
    expect(rows()).toEqual([]);
    expect(buttonIn(document, 'Add realm')).toBeUndefined();
  });
});
