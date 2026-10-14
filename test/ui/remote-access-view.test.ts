// @vitest-environment happy-dom
// Settings → Remote access (issue #968), rendered against a fake of the daemon's HTTP: off by default with Cloudflare offered
// first; the admin pastes the API token and turns it on in one step; on, the copy-out panel shows the URLs with a copy
// button each; what a release could not remove is listed.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let posts: unknown[] = [];

const URL_ = 'https://hopper.example.com';
const OFF = { enabled: false, credentials: {}, service: true, status: { state: 'off' } };
const ON = {
  enabled: true, provider: 'cloudflare', url: URL_, provisioned: { provider: 'cloudflare', domain: 'hopper.example.com' },
  credentials: { cloudflare: { setBy: 'ada', setAt: '2026-10-12T10:00:00.000Z', last4: 'cccc' } }, service: true, status: { state: 'up', url: URL_ },
  links: { url: URL_, api: `${URL_}/api/`, apiToken: `${URL_}/ui/auth/api-token`, tokenRefresh: `${URL_}/ui/auth/token/refresh` },
};

async function render(first: object) {
  posts = [];
  let current: object = first;
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    if (init.method === 'POST' && path === '/ui/api/remote-access') { posts.push(JSON.parse(String(init.body))); current = ON; }
    return json(current);
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const view = '../../ui/src/views/remote-access.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const store = '../../ui/src/store/index.ts';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role: 'admin', realm: 'local', identity: 'ada' } });
  const { RemoteAccess } = (await import(view)) as { RemoteAccess: () => El };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(RemoteAccess)); });
  await settle();
}

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function type(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Settings → Remote access', () => {
  it('is off, offers Cloudflare first, and turns on in one step with the API token alone', async () => {
    await render(OFF);
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[name="remote-access-provider"]')];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([['cloudflare', true], ['ngrok', false]]);
    const sw = document.querySelector<HTMLButtonElement>('[aria-label="Remote access"]')!;
    expect(sw.disabled).toBe(true);
    expect(document.querySelector('[data-slot="remote-access-copy-out"]')).toBeNull();
    await act(async () => type('API token', 'c'.repeat(40)));
    expect(sw.disabled).toBe(false);
    await act(async () => sw.click());
    await settle();
    expect(posts).toEqual([{ provider: 'cloudflare', credential: 'c'.repeat(40), enabled: true }]);
    const panel = document.querySelector('[data-slot="remote-access-copy-out"]')!;
    expect(panel.textContent).toContain(`${URL_}/api/`);
    expect(panel.textContent).toContain(`${URL_}/ui/auth/token/refresh`);
    expect(panel.querySelectorAll('button[aria-label^="Copy "]')).toHaveLength(4);
  });

  it('lists what the hopper could not remove at the provider', async () => {
    await render({ ...OFF, provider: 'cloudflare', leftover: ['the tunnel tun1 (account acc1): Cloudflare does not answer'] });
    expect(document.querySelector('[data-slot="remote-access-leftover"]')?.textContent).toContain('the tunnel tun1');
  });
});
