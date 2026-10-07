// @vitest-environment happy-dom
// Settings → Sign-in (issues #185, #200, #256), as sign-in works: people sign in with GitHub through the
// hopper's app, and the first of them is admin (issues #214, #239) — the page says so and names them,
// with who else gets in. Other ways to sign in (a directory, an identity provider, an auth gateway) are
// optional, each on or off, moved up or down among themselves, edited in a form of its own fields or
// removed; one added from the form of the chosen type. Device links and no sign-in come last, each saying
// what it does. Every switch says On or Off in words. No password accounts (issue #237). No YAML anywhere.
// Every change posts POST /ui/api/realms with the version it read; a refusal is shown where it was made.
// Admins (issue #242): everyone who has signed in, with their role; any admin makes someone admin, a super
// admin also makes them super admin or hands theirs over. A session that is not admin sees none of it. Rendered against a fake of the daemon's HTTP.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

let posts: Record<string, unknown>[] = [];
let refuse: string | undefined;

const GITHUB = { name: 'github', label: 'GitHub', type: 'github', enabled: true, settings: { roles: { operator: { usernames: ['bea'] }, defaultRole: 'viewer' } }, secrets: [] };
let VIEW: Record<string, unknown> & { realms: Record<string, unknown>[] };
const BASE = {
  version: 'v1', local: true, none: null, origin: 'http://localhost:4790', githubAdmin: { realm: 'github', user: 'octo' },
  people: [
    { realm: 'github', subject: '1', user: 'octo', role: 'admin', superAdmin: true },
    { realm: 'github', subject: '2', user: 'bea', role: 'operator', superAdmin: false },
    { realm: 'corp', subject: 'ada', user: 'ada', role: 'admin', superAdmin: false },
  ],
  realms: [
    GITHUB,
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

async function render(role: 'admin' | 'operator', superAdmin = false, instanceAdmin = role === 'admin') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  posts = [];
  refuse = undefined;
  VIEW ??= structuredClone(BASE);
  vi.stubGlobal('fetch', fakeDaemon());
  const store = '../../ui/src/store/index.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'admin', name: 'admin', role, realm: 'local', identity: 'login code', superAdmin, instanceAdmin } });
  const mod = '../../ui/src/views/realms.tsx';
  const { Realms } = (await import(mod)) as { Realms: () => ReturnType<typeof createElement> };
  await act(async () => {
    root = createRoot(document.getElementById('root')!);
    root.render(createElement(Realms));
  });
}

const section = (title: string) => document.querySelector<HTMLElement>(`[data-section="${title}"]`)!;
const switchIn = (el: ParentNode) => el.querySelector<HTMLElement>('[role="switch"]')!;
const row = (name: string) => document.querySelector<HTMLElement>(`[data-realm="${name}"]`)!;
const rows = (el: ParentNode = section('other')) => [...el.querySelectorAll<HTMLElement>('[data-realm]')].map((e) => e.dataset.realm);
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
  VIEW = undefined!;
  vi.unstubAllGlobals();
});

describe('Settings: Sign-in', () => {
  it('lists the realms in order, with their type, whether each is on, and the callback to register', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toEqual(['staff', 'corp']));
    expect(row('staff').textContent).toContain('Staff');
    expect(row('staff').textContent).toContain('SAML');
    expect(row('staff').textContent).toContain('On');
    expect(row('corp').textContent).toContain('Off');
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
    // Up past staff: the place staff holds in the whole list, after GitHub.
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'move', name: 'corp', to: 1, version: 'v2' }));
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
    VIEW = structuredClone(BASE);
    VIEW.realms[2]!.environment = true;
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(row('corp').textContent).toContain('from the environment');
    expect(row('staff').textContent).not.toContain('from the environment');
  });

  it('offers no password realm to add, and GitHub only where GitHub is: the hopper keeps no password accounts (issue #237)', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await click(buttonIn(document.body, 'Add realm'));
    const types = [...field('Realm type').querySelectorAll('option')].map((o) => (o as HTMLOptionElement).value);
    expect(types).toEqual(['ldap', 'oidc', 'saml', 'gateway']);
    expect(document.querySelector('[data-account]')).toBeNull();
  });

  it('says people sign in with GitHub and names the admin, the first of them, with who else gets in (issue #256)', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows(section('github'))).toEqual(['github']));
    const github = section('github');
    expect(github.textContent).toMatch(/sign in with GitHub/);
    expect(github.textContent).toMatch(/octo.*admin.*first to sign in with GitHub/);
    expect(github.textContent).toMatch(/operator.*bea/);
    expect(github.textContent).toMatch(/anyone else.*viewer/i);
    // On in words, and none of the realm's inner names: no "github" badge, no "github" name beside "GitHub".
    expect(row('github').textContent).toContain('On');
    expect(row('github').textContent).not.toContain('github');
    // GitHub is not one of the others, and the help no longer speaks of a password form or LDAP order there.
    expect(rows()).toEqual(['staff', 'corp']);
    expect(github.textContent).not.toMatch(/password|LDAP/);
    expect(document.body.textContent).not.toContain('Without a realm');
  });

  it('before anyone signs in with GitHub, says the first who does becomes admin', async () => {
    VIEW = { ...structuredClone(BASE), githubAdmin: null };
    await render('admin');
    await vi.waitFor(() => expect(rows(section('github'))).toEqual(['github']));
    expect(section('github').textContent).toMatch(/Nobody has signed in with GitHub yet.*first.*becomes admin/);
  });

  it('a GitHub realm turned off says Off, and turning it on posts enable', async () => {
    VIEW = structuredClone(BASE);
    VIEW.realms[0]!.enabled = false;
    await render('admin');
    await vi.waitFor(() => expect(rows(section('github'))).toEqual(['github']));
    expect(row('github').textContent).toContain('Off');
    await click(switchIn(row('github')));
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'enable', name: 'github', enabled: true, version: 'v1' }));
  });

  it('with no GitHub realm, offers to add GitHub sign-in back', async () => {
    VIEW = { ...structuredClone(BASE), githubAdmin: null, realms: structuredClone(BASE.realms.slice(1)) };
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await click(buttonIn(section('github'), 'Add GitHub sign-in'));
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'save', version: 'v1', realm: { name: 'github', label: 'GitHub', type: 'github' } }));
  });

  it('the other ways are company sign-ins at the edge: their people still connect GitHub for their jobs, and the hopper asks for no password of its own (issues #214, #237, #264)', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    const other = section('other').querySelector('p')!.textContent;
    expect(other).toMatch(/company/);
    expect(other).toMatch(/connect their GitHub.*Sources/);
    expect(other).not.toMatch(/username|password/i);
  });

  it('with no other way to sign in, says GitHub is the only one', async () => {
    VIEW = { ...structuredClone(BASE), realms: [structuredClone(GITHUB)] };
    await render('admin');
    await vi.waitFor(() => expect(rows(section('github'))).toEqual(['github']));
    expect(rows()).toEqual([]);
    expect(section('other').textContent).toMatch(/GitHub is the only way to sign in/);
  });

  it('device links: what they are, On or Off in words, and the switch posts the login code setting', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    const links = section('device-links');
    expect(links.textContent).toMatch(/another device/);
    expect(links.textContent).toMatch(/new user/);
    expect(links.textContent).toContain('On');
    await click(switchIn(links));
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'settings', local: false, version: 'v1' }));
  });

  it('no sign-in: off, and only for a hopper behind something that decides who gets in', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    const none = section('no-sign-in');
    expect(field('No sign-in').value).toBe('');
    expect(none.textContent).toMatch(/Off/);
    expect(none.textContent).toMatch(/proxy or network that already decides who gets in/);
    await act(async () => type(field('No sign-in'), 'viewer'));
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'settings', none: 'viewer', version: 'v1' }));
  });

  it('an admin of their own user who is not an instance admin (issue #240) sees no realms', async () => {
    await render('admin', false, false);
    expect(document.body.textContent).toContain('Only the hopper\'s admins manage sign-in.');
    expect(document.querySelectorAll('[data-realm]')).toHaveLength(0);
  });

  it('lists everyone who signed in with their role; a super admin makes them admin or super admin, or hands it over (issue #242)', async () => {
    await render('admin', true);
    const person = (name: string) => section('admins').querySelector<HTMLElement>(`[data-person="${name}"]`)!;
    await vi.waitFor(() => expect(person('octo')).not.toBeNull());
    expect(person('octo').textContent).toContain('super admin');
    expect(person('bea').textContent).toContain('operator');
    expect(person('ada').textContent).toContain('admin');
    expect(buttonIn(person('octo'), 'Make admin')).toBeUndefined();
    expect(buttonIn(person('octo'), 'Make super admin')).toBeUndefined();
    expect(buttonIn(person('ada'), 'Make admin')).toBeUndefined();
    await click(buttonIn(person('bea'), 'Make admin'));
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'admin', who: { realm: 'github', subject: '2' }, version: 'v1' }));
    await click(buttonIn(person('ada'), 'Make super admin'));
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'super-admin', who: { realm: 'corp', subject: 'ada' }, version: 'v2' }));
    await click(buttonIn(person('ada'), 'Hand over super admin'));
    const dialog = await vi.waitFor(() => { const d = document.querySelector<HTMLElement>('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    expect(dialog.textContent).toContain('You stay admin');
    await click(buttonIn(dialog, 'Hand over'));
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'super-admin', who: { realm: 'corp', subject: 'ada' }, transfer: true, version: 'v2' }));
  });

  it('a regular admin makes someone admin, and is offered no super admin change (issue #242)', async () => {
    await render('admin', false);
    const person = (name: string) => section('admins').querySelector<HTMLElement>(`[data-person="${name}"]`)!;
    await vi.waitFor(() => expect(person('bea')).not.toBeNull());
    expect(section('admins').textContent).toContain('You are not a super admin');
    expect(buttonIn(section('admins'), 'Make super admin')).toBeUndefined();
    expect(buttonIn(section('admins'), 'Hand over super admin')).toBeUndefined();
    await click(buttonIn(person('bea'), 'Make admin'));
    await vi.waitFor(() => expect(posts).toContainEqual({ action: 'admin', who: { realm: 'github', subject: '2' }, version: 'v1' }));
  });

  it('a session that is not admin sees no realms', async () => {
    await render('operator');
    expect(document.body.textContent).toContain("Only the hopper's admins manage sign-in.");
    expect(document.querySelectorAll('[data-realm]')).toHaveLength(0);
    expect(buttonIn(document, 'Add realm')).toBeUndefined();
  });
});
