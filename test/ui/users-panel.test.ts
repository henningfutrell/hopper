// @vitest-environment happy-dom
// Settings → Users (issue #158): the users of this hopper, and for an admin "Add user", which shows the
// one-time login link the daemon answers, to copy and hand over. A session that is not admin neither
// lists nor adds users (GET /api/users answers an admin). Rendered against a fake of the daemon's HTTP.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const LINK = `http://127.0.0.1:4790/#login=${'c'.repeat(64)}`;
let posts: unknown[] = [];
let users = [{ id: 'owner', name: 'owner', createdAt: '2026-10-05T10:00:00.000Z' }];

function fakeDaemon() {
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (String(input) === '/api/users') return json({ users });
    if (String(input) === '/ui/api/users') {
      const body = JSON.parse(String(init.body)) as { name: string };
      posts.push(body);
      const user = { id: body.name.toLowerCase(), name: body.name, createdAt: '2026-10-05T11:00:00.000Z' };
      users = [...users, user];
      return json({ user, links: [LINK] });
    }
    return json({ error: 'not found' }, 404);
  });
}

let root: Root | undefined;

async function render(role: 'admin' | 'operator') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  posts = [];
  users = [{ id: 'owner', name: 'owner', createdAt: '2026-10-05T10:00:00.000Z' }];
  vi.stubGlobal('fetch', fakeDaemon());
  const store = '../../ui/src/store/index.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'owner', name: 'owner', role, realm: 'local', identity: 'login code' } });
  const mod = '../../ui/src/views/users.tsx';
  const { Users } = (await import(mod)) as { Users: () => ReturnType<typeof createElement> };
  await act(async () => {
    root = createRoot(document.getElementById('root')!);
    root.render(createElement(Users));
  });
}

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-user]')].map((e) => e.dataset.user);

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Settings: Users', () => {
  it('lists the users', async () => {
    await render('admin');
    await vi.waitFor(() => expect(rows()).toEqual(['owner']));
  });

  it('an admin adds a user and is shown its login link to hand over; the list follows', async () => {
    await render('admin');
    await vi.waitFor(() => expect(button('Add user')).toBeTruthy());
    await act(async () => { button('Add user')!.click(); });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Bea');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('Add')!.click(); });
    await vi.waitFor(() => expect(posts).toEqual([{ action: 'add', name: 'Bea' }]));
    await vi.waitFor(() => expect(document.querySelector('[data-login-link]')?.textContent).toContain(LINK));
    await vi.waitFor(() => expect(rows()).toEqual(['owner', 'bea']));
  });

  it('a session that is not admin neither lists nor adds users', async () => {
    await render('operator');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Only an admin sees and adds users.'));
    expect(rows()).toEqual([]);
    expect(button('Add user')).toBeUndefined();
  });
});
