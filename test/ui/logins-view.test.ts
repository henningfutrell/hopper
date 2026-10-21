// @vitest-environment happy-dom
// The Logins view (issue #477), rendered inside the whole app against a fake of the daemon's HTTP surface and a
// fake clock. A pending login shows its code, URL, machine, tool, what it blocks and a countdown of server time;
// the nav badge and the header count it; it never shows in Questions. Under the warning the card and the badge
// warn and a screen reader hears it once; at `expiresAt` the code goes and the card says Expired, before the
// server says so. `auth.completed` turns it into Signed in. A viewer sees a notice, never the code; a 403 on an
// action drops to the landing page.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const CODE = 'WDJB-MJHT';

const job = {
  id: 'j1', status: 'running', priority: 50, attempts: 1, maxAttempts: 1, createdAt: at(-60), updatedAt: at(-60), laneId: 'desk/lane-1', machineId: 'desk',
  spec: { executor: 'herdr-claude', prompt: 'Push the branch', goal: 'Push the branch' },
};
const machine = { id: 'desk', label: 'Desk tower', maxLanes: 1, online: true, executors: ['herdr-claude'], lanes: [], usage: [] };
const pending = (over: Record<string, unknown> = {}) => ({
  id: 'l1', kind: 'device_code', tool: 'gh', status: 'pending', expiresAt: at(900), jobId: 'j1', laneId: 'desk/lane-1', machineId: 'desk',
  run: 'herdr-claude', renewable: true, createdAt: at(0), updatedAt: at(0), codeKept: true, verificationUrl: 'https://github.com/login/device', userCode: CODE, ...over,
});

type Role = 'viewer' | 'operator' | 'admin';
interface Daemon { logins: Record<string, unknown>[]; now?: () => string; role?: Role; mutationStatus?: number }

function fakeDaemon(d: Daemon) {
  const posts: string[] = [];
  const bodies: unknown[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [job], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [machine] },
    '/api/decisions': { decisions: [] },
    '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] },
    '/api/webhooks/deliveries': { deliveries: [] },
    '/api/sources': { sources: [] },
    '/api/questions': { questions: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/accounts': { accounts: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path] = String(input).split('?') as [string];
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: d.role ?? 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/logins') {
      const role = d.role ?? 'operator';
      const logins = role === 'viewer' ? d.logins.map(({ userCode: _c, verificationUrl: _u, ...l }) => l) : d.logins;
      return json(200, { now: d.now?.() ?? new Date().toISOString(), settings: { onExpiry: 'fail', warnSec: 60 }, logins });
    }
    if (path.startsWith('/ui/api/')) {
      posts.push(`${init.method ?? 'GET'} ${path}`);
      bodies.push(init.body ? JSON.parse(String(init.body)) : undefined);
      if (d.mutationStatus) return json(d.mutationStatus, { error: 'missing or invalid x-hopper-session', session: 'ended' });
      return json(200, {});
    }
    return json(200, routes[path] ?? {});
  });
  return { fetch, posts, bodies };
}

/** The stream: the test sends an event through it as the daemon would. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (m: { data: string }) => void>();
  constructor() { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (m: { data: string }) => void): void { this.listeners.set(type, fn); }
  close(): void {}
  send(e: Record<string, unknown>): void { this.listeners.get(String(e.type))?.({ data: JSON.stringify(e) }); }
}

let root: Root | undefined;
let daemon: ReturnType<typeof fakeDaemon>;

async function boot(hash: string, d: Daemon) {
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  daemon = fakeDaemon(d);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const mod = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(mod.App)); });
  await settle();
}

/** Let fetches resolve and debounced refreshes run. */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
/** Move the fake clock on, one tick at a time, as the page lives through it. */
async function pass(seconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(seconds * 1000); });
  await settle();
}

const card = () => document.querySelector('[data-login="l1"]');
const navBadge = () => document.querySelector('[data-slot="page-tabs"] a[href="#machines/logins"] [data-slot="tab-badge"]');
const header = () => document.querySelector('[data-logins-pending]');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0 + 1000);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the Logins view', () => {
  it('names what asks — the tool at its host, the account, the scopes — and the lane (issue #698); the code goes on the host (issue #2142)', async () => {
    await boot('#logins', { logins: [pending({ tool: 'python3 .agents/skills/workflow-mcp-auth/mcp_auth.py login', host: 'auth.example.com', account: 'dev-account-7', scopes: ['repo', 'read:org'] })] });
    const d = card()!.querySelector('[data-slot="login-details"]')!;
    expect(d.textContent).toContain('mcp_auth.py login at auth.example.com');
    expect([card()!.textContent!.includes('Enter this code on auth.example.comWDJB'), card()!.querySelector('a [data-open-provider-label].truncate')?.textContent]).toEqual([true, 'Open auth.example.com']);
    expect(d.textContent).toContain('dev-account-7');
    expect(d.textContent).toContain('repo, read:org');
    expect(d.textContent).toContain('desk/lane-1');
  });

  it('a pending login: code, URL, machine, tool, the job it blocks, a countdown; the nav badge and the header count it', async () => {
    await boot('#logins', { logins: [pending()] });
    const c = card()!;
    expect(c).not.toBeNull();
    expect(c.getAttribute('data-phase')).toBe('pending');
    expect(c.querySelector('[data-device-code]')?.textContent).toBe(CODE);
    expect(c.querySelector('a[data-open-provider]')?.getAttribute('href')).toBe('https://github.com/login/device');
    expect(c.textContent).toContain('Enter this code on github.comWDJB'); // no host: its page's (issue #2142)
    expect(c.textContent).toContain('gh');
    expect(c.textContent).toContain('Desk tower');
    expect(c.textContent).toContain('Push the branch');
    expect(c.querySelector('[data-countdown]')?.textContent).toBe('14:59');
    expect(navBadge()?.textContent).toBe('1');
    expect(header()?.textContent).toContain('1 login pending');
    await pass(1);
    expect(card()!.querySelector('[data-countdown]')?.textContent).toBe('14:58');
  });

  it('never shows in Questions', async () => {
    await boot('#questions', { logins: [pending()] });
    expect(card()).toBeNull();
    expect(document.body.textContent).not.toContain(CODE);
    expect(document.querySelector('a[href="#questions"] [data-slot="nav-badge"]')).toBeNull();
  });

  it('under the warning the card and the badge warn, and a screen reader hears it once', async () => {
    await boot('#logins', { logins: [pending({ expiresAt: at(120) })] });
    expect(card()!.getAttribute('data-phase')).toBe('pending');
    expect(card()!.querySelector('[data-login-announce]')?.textContent).toBe('');
    await pass(60);
    expect(card()!.getAttribute('data-phase')).toBe('expiring');
    expect(navBadge()?.className).toContain('bg-warn');
    expect(header()?.className).toContain('warn');
    const said = card()!.querySelector('[data-login-announce]');
    expect(said?.getAttribute('aria-live')).toBe('polite');
    expect(said?.textContent).toMatch(/gh login .* expires soon/);
    await pass(5);
    expect(card()!.querySelector('[data-login-announce]')?.textContent).toBe(said?.textContent);
  });

  it('at expiresAt, on the client\'s clock: Expired, the code gone, the badge no longer counts it; the job fails', async () => {
    await boot('#logins', { logins: [pending({ expiresAt: at(30) })] });
    await pass(30);
    const c = card()!;
    expect(c.getAttribute('data-phase')).toBe('expired');
    expect(c.textContent).toContain('Expired');
    expect(c.querySelector('[data-device-code]')).toBeNull();
    expect(c.querySelector('a[data-open-provider]')).toBeNull();
    expect(c.textContent).not.toContain(CODE);
    expect(c.textContent).toContain('The job fails');
    expect(navBadge()).toBeNull();
    expect(header()).toBeNull();
  });

  it('auth.completed: the login leaves the cards at once for Earlier logins, the code cleared (issue #1110)', async () => {
    const d: Daemon = { logins: [pending()] };
    await boot('#logins', d);
    d.logins = [pending({ status: 'completed', endedAt: at(5), updatedAt: at(5), codeKept: false, verificationUrl: undefined, userCode: undefined })];
    await act(async () => { FakeEventSource.last!.send({ seq: 1, schemaVersion: 1, id: 'e1', type: 'auth.completed', at: at(5), jobId: 'j1', data: { loginId: 'l1', kind: 'device_code', tool: 'gh' } }); });
    await pass(1);
    expect(card()).toBeNull();
    expect(document.querySelector('[data-earlier-login="l1"]')?.textContent).toContain('completed');
    expect(document.querySelector('[data-device-code]')).toBeNull();
    expect(navBadge()).toBeNull();
  });

  it('Dismiss puts an open login away; a reopened login says why (issue #1110)', async () => {
    const d: Daemon = { logins: [pending({ reason: 'gh auth status: not logged in', codeKept: false, verificationUrl: undefined, userCode: undefined })] };
    await boot('#logins', d);
    expect(card()!.querySelector('[data-slot="login-reopened"]')?.textContent).toContain('gh auth status: not logged in');
    expect(card()!.textContent).not.toContain('it restarted');
    const dismiss = [...card()!.querySelectorAll('button')].find((b) => b.textContent?.includes('Dismiss'))!;
    await act(async () => { dismiss.click(); });
    await pass(1);
    expect(daemon.posts).toContain('POST /ui/api/logins/l1/dismiss');
  });

  it('several pending logins sort by time left, the shortest first', async () => {
    await boot('#logins', { logins: [pending({ id: 'long', expiresAt: at(900) }), pending({ id: 'short', tool: 'codex', expiresAt: at(300) })] });
    expect([...document.querySelectorAll('[data-login]')].map((x) => x.getAttribute('data-login'))).toEqual(['short', 'long']);
    expect(navBadge()?.textContent).toBe('2');
    expect(header()?.textContent).toContain('2 logins pending');
  });

  it('counts down from the server\'s time when the browser\'s clock is 5 minutes behind', async () => {
    await boot('#logins', { logins: [pending()], now: () => new Date(Date.now() + 300_000).toISOString() });
    vi.setSystemTime(T0 + 1000 - 300_000);
    await pass(1);
    expect(card()!.querySelector('[data-countdown]')?.textContent).toBe('14:58');
  });

  it('Cancel and Request a new code go to the daemon; a 403 drops to the landing page', async () => {
    await boot('#logins', { logins: [pending()] });
    const button = (text: string) => [...card()!.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
    await act(async () => { button('Request a new code').click(); });
    await settle();
    expect(daemon.posts).toContain('POST /ui/api/logins/l1/new-code');
    await act(async () => { button('Cancel').click(); });
    await settle();
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent === 'Cancel login') as HTMLButtonElement | undefined;
    await act(async () => { confirm?.click(); });
    await settle();
    expect(daemon.posts).toContain('POST /ui/api/logins/l1/cancel');
  });

  it('a 403 on an action drops the UI to the landing page', async () => {
    await boot('#logins', { logins: [pending()], mutationStatus: 403 });
    const button = [...card()!.querySelectorAll('button')].find((b) => b.textContent?.includes('Request a new code'))!;
    await act(async () => { button.click(); });
    await settle();
    expect(card()).toBeNull();
  });

  it('a viewer sees a notice instead of the code and the actions', async () => {
    await boot('#logins', { logins: [pending()], role: 'viewer' });
    const c = card()!;
    expect(c.querySelector('[data-device-code]')).toBeNull();
    expect(c.querySelector('[data-slot="login-notice"]')?.textContent).toContain('viewer');
    expect([...c.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Cancel');
    expect(c.querySelector('[data-countdown]')?.textContent).toBe('14:59');
  });
});

describe('a tool sign-in (issue #1128)', () => {
  const SIGN_IN_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=s1';
  const signIn = (over: Record<string, unknown> = {}) => pending({
    kind: 'paste_code', tool: 'claude', jobId: undefined, laneId: undefined, run: 'sign-in', renewable: false, userCode: undefined,
    verificationUrl: SIGN_IN_URL, host: 'claude.com', ...over,
  });

  it('no job: names the sign-in on its machine, opens the sign-in page, and sends the code pasted from it', async () => {
    await boot('#logins', { logins: [signIn()] });
    const c = card()!;
    expect(c.textContent).toContain('the claude sign-in on Desk tower');
    expect(c.textContent).toContain('The sign-in stops in');
    expect(c.querySelector('[data-device-code]')).toBeNull();
    expect(c.querySelector('a[data-open-sign-in]')?.getAttribute('href')).toBe(SIGN_IN_URL);
    // Its browser profile (issue #1249): the machine's, as no account is known there, with a Firefox container link to the page.
    expect(c.querySelector('[data-profile="hopper-desk"] a')?.getAttribute('href')).toBe(`ext+container:name=hopper-desk&url=${encodeURIComponent(SIGN_IN_URL)}`);
    expect(c.textContent).not.toContain('Request a new code');
    const input = c.querySelector<HTMLInputElement>('[data-slot="sign-in-code"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' abc#def ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { c.querySelector<HTMLButtonElement>('[data-slot="sign-in-code"] button[type="submit"]')!.click(); });
    await settle();
    expect(daemon.posts).toContain('POST /ui/api/logins/l1/code');
    expect(daemon.bodies.at(daemon.posts.indexOf('POST /ui/api/logins/l1/code'))).toEqual({ code: 'abc#def' });
  });

  it('a viewer sees neither the page nor the field', async () => {
    await boot('#logins', { logins: [signIn()], role: 'viewer' });
    expect(card()!.querySelector('[data-slot="sign-in-code"]')).toBeNull();
    expect(card()!.querySelector('[data-slot="login-notice"]')).not.toBeNull();
  });

  it('a failed sign-in says why, and to start it again from Accounts', async () => {
    await boot('#logins', { logins: [signIn({ status: 'failed', reason: 'Login failed: Request failed with status code 400', endedAt: at(1), codeKept: false, verificationUrl: undefined })] });
    expect(card()!.textContent).toContain('Failed: Login failed: Request failed with status code 400. Start it again from Accounts.');
  });
});

describe('the Claude sign-in for pods (issue #1287)', () => {
  const podSignIn = (over: Record<string, unknown> = {}) => pending({
    kind: 'paste_code', tool: 'claude setup-token', jobId: undefined, laneId: undefined, machineId: undefined, run: 'sign-in', renewable: false, userCode: undefined,
    verificationUrl: 'https://claude.com/cai/oauth/authorize?code=true&state=s2', host: 'claude.com', account: 'pods@example.com', ...over,
  });
  const form = () => document.querySelector<HTMLButtonElement>('[data-claude-pod-sign-in]');

  it('an admin names the account and starts it; its card names the account and the hopper, and takes the code', async () => {
    await boot('#logins', { logins: [podSignIn()], role: 'admin' });
    const c = card()!;
    expect(c.textContent).toContain('the Claude sign-in for pods, in the hopper');
    expect(c.querySelector('[data-slot="login-details"]')!.textContent).toContain('pods@example.com');
    expect(c.querySelector('[data-slot="sign-in-code"] input')).not.toBeNull();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Claude account"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' pods@example.com ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { form()!.click(); });
    await settle();
    expect(daemon.bodies.at(daemon.posts.indexOf('POST /ui/api/logins/claude-setup-token'))).toEqual({ account: 'pods@example.com' });
  });

  it('a failed one says why and to start it again below; an operator sees no start', async () => {
    await boot('#logins', { logins: [podSignIn({ status: 'failed', reason: 'OAuth error', endedAt: at(1), codeKept: false, verificationUrl: undefined })], role: 'operator' });
    expect(card()!.textContent).toContain('Failed: OAuth error. Start it again below.');
    expect(form()).toBeNull();
  });
});

describe('the last account (issue #1269)', () => {
  const claude = (over: Record<string, unknown> = {}) => pending({ tool: 'claude', host: 'claude.com', userCode: undefined, ...over });
  const line = () => card()!.querySelector('[data-slot="login-last-account"]');

  it('a Claude login on a machine with a recorded account: that account, its organization and the machine', async () => {
    await boot('#logins', { logins: [claude({ lastAccount: { machineId: 'desk', service: 'claude', identity: 'dev@example.com', organization: 'Example Org', capturedAt: at(-3600) } })] });
    expect(line()?.textContent).toBe('Last signed in as dev@example.com (Example Org) on Desk tower');
  });

  it('a Claude login on a machine with no recorded account: says none is known there', async () => {
    await boot('#logins', { logins: [claude({ lastAccount: null })] });
    expect(line()?.textContent).toBe('No previous account known for this machine (Desk tower)');
  });

  it('a login that names no last account (another tool): no line', async () => {
    await boot('#logins', { logins: [pending()] });
    expect(line()).toBeNull();
  });
});
