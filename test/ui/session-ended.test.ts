// @vitest-environment happy-dom
// A session that ends while the page is open (issue #439): the next call that finds it gone — or the page's
// own check — sends the person straight to sign-in with the realm the session was made with, keeping the
// page to come back to, which the page opens once signed in again. Against a fake of the daemon's HTTP.
import { afterEach, describe, expect, it, vi } from 'vitest';

const store = '../../ui/src/store/index.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
type Store = {
  useHopper: { setState(s: Record<string, unknown>): void; getState(): Record<string, unknown> };
  act(path: string, body?: unknown): Promise<boolean>;
  recheckSession(): Promise<void>;
  checkSession(): Promise<void>;
};

const offer = { local: true, none: null, password: false, gateway: false, origin: location.origin, realms: [{ name: 'corp', label: 'Corp SSO', type: 'oidc' }], devices: [], required: false };
const user = { id: 'u1', name: 'ada', role: 'admin', realm: 'corp', identity: 'Ada', superAdmin: false, instanceAdmin: true };

function daemon(o: { authenticated: boolean; mutation?: number }) {
  return vi.fn(async (input: string) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (String(input) === '/ui/api/session') return json(o.authenticated ? { authenticated: true, user, signIn: offer } : { authenticated: false, signIn: offer });
    if (String(input).startsWith('/ui/api/')) return json({ error: 'missing or invalid x-hopper-session' }, o.mutation ?? 403);
    return json({});
  });
}

async function openPage(): Promise<{ s: Store; assign: ReturnType<typeof vi.fn> }> {
  vi.resetModules();
  const assign = vi.fn();
  vi.stubGlobal('location', { ...location, origin: location.origin, hash: '#settings/sign-in', assign, reload: vi.fn() });
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const s = (await import(store)) as Store;
  s.useHopper.setState({ authed: true, user, signIn: offer });
  return { s, assign };
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('a session that ended while the page was open', () => {
  it('a refused change sends the person to sign in with their realm at once; the page to come back to is kept', async () => {
    const { s, assign } = await openPage();
    vi.stubGlobal('fetch', daemon({ authenticated: false }));
    expect(await s.act('/ui/api/queue-gate', { mode: 'review' })).toBe(false);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(String(assign.mock.calls[0]![0])).toMatch(/^\/ui\/auth\/corp\/start\?binding=/);
    expect(localStorage.getItem('jh_return')).toBe('#settings/sign-in');
    expect(localStorage.getItem('jh_session')).toBeNull();
    expect(s.useHopper.getState().authed).toBe(false);
  });

  it('the page\'s own check finds it ended, with no call failing first', async () => {
    const { s, assign } = await openPage();
    vi.stubGlobal('fetch', daemon({ authenticated: false }));
    await s.recheckSession();
    expect(String(assign.mock.calls[0]![0])).toMatch(/^\/ui\/auth\/corp\/start\?binding=/);
  });

  it('a session still live is left alone', async () => {
    const { s, assign } = await openPage();
    vi.stubGlobal('fetch', daemon({ authenticated: true }));
    await s.recheckSession();
    expect(assign).not.toHaveBeenCalled();
    expect(s.useHopper.getState().authed).toBe(true);
  });

  it('signed in again, the page opens where the person was', async () => {
    const { s } = await openPage();
    localStorage.setItem('jh_return', '#settings/sign-in');
    (location as { hash: string }).hash = '';
    vi.stubGlobal('fetch', daemon({ authenticated: true }));
    await s.checkSession();
    expect(location.hash).toBe('#settings/sign-in');
    expect(localStorage.getItem('jh_return')).toBeNull();
  });
});
