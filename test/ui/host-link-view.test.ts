// @vitest-environment happy-dom
// Settings → Host link (issue #712), rendered against a fake of the daemon's HTTP: it shows the default the hopper uses
// when none is set, and the admin saves an address, or clears it for the default again. On a hopper in WSL it shows how to
// test the Windows link from PowerShell, and the .wslconfig fixes.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let posts: unknown[] = [];

async function render(first: { hostLinkBase: string; default: string; wsl: boolean }) {
  posts = [];
  let current = first;
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    if (init.method === 'POST' && path === '/ui/api/host-link') {
      const body = JSON.parse(String(init.body)) as { hostLinkBase: string };
      posts.push(body);
      current = { ...current, hostLinkBase: body.hostLinkBase.replace(/\/+$/, '') };
    }
    return json(current);
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const view = '../../ui/src/views/host-link.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const store = '../../ui/src/store/index.ts';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role: 'admin', realm: 'local', identity: 'ada' } });
  const { HostLink } = (await import(view)) as { HostLink: () => El };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(HostLink)); });
  await settle();
}

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function type(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const click = async (text: string) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === text)!;
  await act(async () => { b.click(); });
  await settle();
};

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Settings → Host link (issue #712)', () => {
  it('shows the default when none is set, saves an address, and clears it for the default again', async () => {
    await render({ hostLinkBase: '', default: 'http://localhost:4790', wsl: false });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Host link base"]')!;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('http://localhost:4790');
    expect(document.querySelector('[data-slot="host-link"]')!.textContent).toContain('Now: http://localhost:4790 (the default)');

    type('Host link base', 'http://127.0.0.1:4790');
    await click('Save');
    expect(posts).toEqual([{ hostLinkBase: 'http://127.0.0.1:4790' }]);
    expect(document.querySelector('[data-slot="host-link"]')!.textContent).toContain('Now: http://127.0.0.1:4790');

    type('Host link base', '');
    await click('Save');
    expect(posts[1]).toEqual({ hostLinkBase: '' });
    expect(document.querySelector('[data-slot="host-link"]')!.textContent).toContain('(the default)');
  });

  it('on a plain Linux host shows no Windows hint', async () => {
    await render({ hostLinkBase: '', default: 'http://localhost:4790', wsl: false });
    expect(document.querySelector('[data-slot="host-link-wsl"]')).toBeNull();
  });

  it('in WSL shows how to test the link from Windows, the .wslconfig fixes, and that a client in this distro checks it', async () => {
    await render({ hostLinkBase: '', default: 'http://localhost:4790', wsl: true });
    const hint = document.querySelector('[data-slot="host-link-wsl"]')!.textContent!;
    expect(hint).toContain('Invoke-WebRequest http://localhost:4790/api/health');
    expect(hint).toContain('localhostForwarding=true');
    expect(hint).toContain('networkingMode=mirrored');
    expect(hint).toContain('wsl --shutdown');
    expect(hint).toContain('Add machine → A computer');
    expect(hint).toContain('hopper doctor');
  });

  it('in WSL tests the host link base the admin set, not the default', async () => {
    await render({ hostLinkBase: 'http://127.0.0.1:4790', default: 'http://localhost:4790', wsl: true });
    expect(document.querySelector('[data-slot="host-link-wsl"]')!.textContent).toContain('Invoke-WebRequest http://127.0.0.1:4790/api/health');
  });
});
