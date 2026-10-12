// @vitest-environment happy-dom
// Settings → Intake (issue #930), the trusted actor picker rendered against fakes of its reads: accounts from GitHub with
// avatar, login and type, never a typed login. The connected login is trusted by default. An admin adds a candidate, or
// one looked up by login, and Save posts the ids; a login GitHub does not know is said so and cannot be added. A list kept
// before ids is looked up again and shown to save. A viewer reads only.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const OWNER = { id: 1, login: 'owner', type: 'User', avatarUrl: 'https://avatars.example/u/1' };
const TEAMMATE = { id: 42, login: 'teammate', type: 'User', avatarUrl: 'https://avatars.example/u/42' };
const OUTSIDER = { id: 55, login: 'outsider', type: 'User', avatarUrl: 'https://avatars.example/u/55' };

let VIEW: { accounts: unknown[]; unresolved: string[]; connected: string | null } = { accounts: [], unresolved: [], connected: 'owner' };
let root: Root | undefined;
const posts: { path: string; body: unknown }[] = [];

async function boot(role: 'admin' | 'viewer', view = VIEW) {
  posts.length = 0;
  VIEW = view;
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path, query = ''] = String(input).split('?');
    if (path === '/ui/api/intake-actors') {
      const ids = (JSON.parse(String(init.body)) as { ids: number[] }).ids;
      posts.push({ path, body: { ids } });
      VIEW = { ...VIEW, accounts: [OWNER, TEAMMATE, OUTSIDER].filter((a) => ids.includes(a.id)), unresolved: [] };
      return json(VIEW);
    }
    if (path === '/api/intake-actors') return json(VIEW);
    if (path === '/api/intake-actors/candidates') {
      return json({ candidates: [{ ...OWNER, from: ['connected', 'collaborator'] }, { ...TEAMMATE, from: ['collaborator'] }], problems: ['the members of octo: GitHub answered 403'] });
    }
    if (path === '/api/intake-actors/lookup') {
      const login = new URLSearchParams(query).get('login');
      return login === 'outsider' || login === 'teammate' ? json(login === 'outsider' ? OUTSIDER : TEAMMATE) : json({ error: `GitHub knows no account ${login}` }, 404);
    }
    return json({});
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const store = '../../ui/src/store/index.ts';
  const view = '../../ui/src/views/intake-actors.tsx';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: unknown): void } };
  useHopper.setState({ authed: true, user: { role, realm: 'local', name: 'someone' } });
  const { IntakeActors } = (await import(view)) as { IntakeActors: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(IntakeActors)); });
  await settle();
}

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const button = (text: string, within: ParentNode = document) => [...within.querySelectorAll('button')].find((b) => b.textContent === text);
const rows = (slot: string) => [...document.querySelectorAll(`[data-slot="${slot}"]`)];
const textOf = (slot: string) => rows(slot).map((r) => r.querySelector('[data-slot="actor-login"]')!.textContent);
function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const click = async (b: HTMLButtonElement | undefined) => { expect(b).toBeDefined(); await act(async () => { b!.click(); }); await settle(); };

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Settings → Intake: trusted actors (issue #930)', () => {
  it('the connected login is trusted by default, shown with its avatar and type; there is no box to type logins in', async () => {
    await boot('admin', { accounts: [], unresolved: [], connected: 'owner' });
    expect(textOf('trusted-actor')).toEqual(['owner']);
    const row = rows('trusted-actor')[0]!;
    expect(row.querySelector('img')?.getAttribute('src')).toBe(OWNER.avatarUrl);
    expect(row.textContent).toContain('User');
    expect(row.textContent).toContain('trusted by default');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('[data-slot="intake-actors"]')!.textContent).toContain('shows in Intake as a request');
    expect(document.querySelector('[data-slot="intake-actors"]')!.textContent).not.toContain('in Sources');
  });

  it('an admin adds a candidate from GitHub and Save posts the ids', async () => {
    await boot('admin', { accounts: [], unresolved: [], connected: 'owner' });
    expect(textOf('actor-candidate')).toEqual(['teammate']);
    expect(rows('actor-candidate')[0]!.textContent).toContain('collaborator');
    expect(document.querySelector('[data-slot="candidate-problems"]')?.textContent).toContain('the members of octo');
    expect(button('Save')!.disabled).toBe(true);
    await click(button('Add', rows('actor-candidate')[0]!));
    expect(textOf('trusted-actor')).toEqual(['owner', 'teammate']);
    await click(button('Save'));
    expect(posts).toEqual([{ path: '/ui/api/intake-actors', body: { ids: [1, 42] } }]);
  });

  it('a login is looked up on GitHub: one that exists is added, one that does not is said so', async () => {
    await boot('admin', { accounts: [OWNER], unresolved: [], connected: 'owner' });
    const find = document.querySelector<HTMLInputElement>('[aria-label="Find a GitHub account"]')!;
    await act(async () => type(find, 'nobody-here'));
    await click(button('Look up nobody-here on GitHub'));
    expect(document.querySelector('[data-slot="lookup-problem"]')?.textContent).toBe('GitHub knows no account nobody-here');
    await act(async () => type(find, 'outsider'));
    await click(button('Look up outsider on GitHub'));
    await click(button('Add', rows('actor-candidate').find((r) => r.textContent?.includes('outsider'))!));
    await click(button('Save'));
    expect(posts).toEqual([{ path: '/ui/api/intake-actors', body: { ids: [1, 55] } }]);
  });

  it('an admin removes a trusted actor', async () => {
    await boot('admin', { accounts: [OWNER, TEAMMATE], unresolved: [], connected: 'owner' });
    await click(button('Remove', rows('trusted-actor').find((r) => r.textContent?.includes('teammate'))!));
    await click(button('Save'));
    expect(posts).toEqual([{ path: '/ui/api/intake-actors', body: { ids: [1] } }]);
  });

  it('a list kept before ids is looked up again: found accounts are ready to save, a login GitHub does not know is said so', async () => {
    await boot('admin', { accounts: [], unresolved: ['teammate', 'gone-user'], connected: 'owner' });
    expect(textOf('trusted-actor')).toEqual(['teammate']);
    expect(document.querySelector('[data-slot="unresolved"]')?.textContent).toContain('gone-user');
    expect(button('Save')!.disabled).toBe(false);
    await click(button('Save'));
    expect(posts).toEqual([{ path: '/ui/api/intake-actors', body: { ids: [42] } }]);
  });

  it('a viewer reads the trusted actors and changes nothing', async () => {
    await boot('viewer', { accounts: [OWNER, TEAMMATE], unresolved: [], connected: 'owner' });
    expect(textOf('trusted-actor')).toEqual(['owner', 'teammate']);
    expect(button('Save')).toBeUndefined();
    expect(button('Remove')).toBeUndefined();
    expect(rows('actor-candidate')).toEqual([]);
  });
});
