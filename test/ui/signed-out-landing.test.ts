// @vitest-environment happy-dom
// Issue #213: logged out, the page shows nothing of the app — no navigation, no read-only notice, no
// error from reads it should not make — only the landing page with the ways to sign in. Nothing of the
// app shows before that: until the session is read the page is blank. Rendered in happy-dom, the whole
// app against a fake of the daemon's HTTP.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const offer = (required: boolean) => ({ local: true, none: null, password: true, gateway: false, origin: location.origin, realms: [], required });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;
let reads: string[] = [];
/** True once any part of the app shell (the navigation) was in the page, at any moment. */
let shellSeen = false;
let watch: MutationObserver | undefined;

const shell = () => document.querySelector('a[href="#overview"], a[href="#queue"], nav, header');

async function boot(session: (path: string) => Promise<Response>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#overview';
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    reads.push(path);
    if (path === '/ui/api/session') return session(path);
    return json({ error: 'not found' }, 404);
  }));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  watch = new MutationObserver(() => { if (shell()) shellSeen = true; });
  watch.observe(document.body, { childList: true, subtree: true });
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

const landing = () => document.querySelector('[data-slot="landing"]');
const text = () => document.body.textContent ?? '';

afterEach(async () => {
  await act(async () => root?.unmount());
  watch?.disconnect();
  root = undefined;
  reads = [];
  shellSeen = false;
  vi.unstubAllGlobals();
});

describe('logged out: only the landing page', () => {
  for (const required of [false, true]) {
    it(`${required ? 'several users' : 'one user'}: the ways to sign in and nothing of the app, and no read but the session`, async () => {
      await boot(async () => json({ authenticated: false, viewing: { id: 'admin', name: 'admin' }, signIn: offer(required) }));
      await vi.waitFor(() => expect(landing()).not.toBeNull());
      expect(document.querySelector('input[aria-label="Username"]')).not.toBeNull();
      expect(document.querySelector('input[aria-label="Login code"]')).toBeNull();
      expect(shell()).toBeNull();
      for (const label of ['Queue', 'Questions', 'Decisions', 'Events', 'Sources', 'Machines', 'Usage', 'Settings']) expect(text()).not.toContain(label);
      expect(text()).not.toMatch(/Read-only|Could not load/);
      expect(reads).toEqual(['/ui/api/session']);
      expect(shellSeen).toBe(false);
    });
  }

  it('before the session is read the page is blank; then the landing page, with no flash of the app between', async () => {
    let answer: (r: Response) => void = () => {};
    await boot(() => new Promise<Response>((resolve) => { answer = resolve; }));
    expect(document.getElementById('root')!.innerHTML).toBe('');
    await act(async () => { answer(json({ authenticated: false, signIn: offer(false) })); });
    await vi.waitFor(() => expect(landing()).not.toBeNull());
    expect(shellSeen).toBe(false);
  });

  // Issue #266: a page, not a lone card. Beside the sign-in card, a panel says what the hopper does in
  // three steps (wide screens; a phone gets the card alone, by CSS); the backdrop is lanes of jobs.
  it('the sign-in card beside a panel that says what the hopper does, in three steps, over lanes', async () => {
    await boot(async () => json({ authenticated: false, signIn: offer(false) }));
    await vi.waitFor(() => expect(landing()).not.toBeNull());
    const card = landing()!.querySelector('[data-landing-card]');
    const showcase = landing()!.querySelector('[data-landing-showcase]');
    expect(card!.querySelector('input[aria-label="Username"]')).not.toBeNull();
    expect(showcase?.querySelector('h2')?.textContent).toContain('Your GitHub issues, worked on your machines');
    expect([...showcase!.querySelectorAll('[data-landing-step]')].map((s) => s.querySelector('h3')?.textContent)).toEqual([
      'Label an issue', 'It runs on your machine', 'Review the pull request',
    ]);
    expect(showcase!.contains(card)).toBe(false);
    expect(landing()!.querySelectorAll('.landing-lane').length).toBeGreaterThanOrEqual(3);
  });

  it('the daemon unreachable: the landing page says so, and nothing of the app shows', async () => {
    await boot(async () => { throw new TypeError('Failed to fetch'); });
    await vi.waitFor(() => expect(landing()).not.toBeNull());
    expect(landing()!.textContent).toContain('Could not reach the hopper');
    expect(shellSeen).toBe(false);
  });
});

describe('signed in', () => {
  it('the app: navigation and views, no landing page', async () => {
    await boot(async () => json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: offer(false) }));
    await vi.waitFor(() => expect(shell()).not.toBeNull());
    expect(landing()).toBeNull();
  });
});
