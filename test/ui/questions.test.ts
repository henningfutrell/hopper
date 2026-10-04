// @vitest-environment happy-dom
// The UI's question card (src/ui/app.js), run in happy-dom against a fake of the daemon's HTTP
// surface: the browser's only seam. Logged out, the card says how to log in where the answer box
// would be; logged in, it offers Send answer and Close; a 403 on a mutation logs the UI out and
// shows the same notice.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN_CMD = 'bash ~/.local/lib/job-hopper/scripts/open-ui.sh';
const html = readFileSync(join(process.cwd(), 'src/ui/index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');

const question = {
  id: 'bf094266', jobId: '89849c4f', text: 'Which branch?', recentOutput: 'line', detectedBy: 'marker', status: 'open',
  tier: 'human', attempts: [], notifyCount: 1, createdAt: '2026-10-03T20:00:00.000Z', updatedAt: '2026-10-03T20:00:00.000Z',
};

interface Call { path: string; method: string; headers: Record<string, string>; body?: unknown }

function fakeDaemon(o: { authed: boolean; mutationStatus?: number }) {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { routerMode: 'shadow', router: 'pass-through', uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], waitingAnswer: [], counts: {} },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] },
    '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] },
    '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [question] },
    '/api/sources': { sources: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    calls.push({ path, method: init.method ?? 'GET', headers, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === '/ui/api/session') return json(200, o.authed ? { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z' } : { authenticated: false });
    if (path.startsWith('/ui/api/')) {
      const status = o.mutationStatus ?? 200;
      return json(status, status === 200 ? { ...question, status: 'closed' } : { error: 'missing or invalid x-jobhopper-session' });
    }
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
  return { fetch, calls };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

async function boot(o: { authed: boolean; mutationStatus?: number }) {
  document.body.innerHTML = body;
  localStorage.clear();
  if (o.authed) localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(o);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', () => {});
  vi.resetModules();
  const app = '../../src/ui/app.js'; // browser code, no types: imported by path
  await import(app);
  await vi.waitFor(() => expect(document.querySelector('#questions .question')).not.toBeNull());
  return daemon;
}

const card = () => document.querySelector('#questions .question')!;
const button = (label: string) => [...card().querySelectorAll('button')].find((b) => b.textContent === label);

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('question card', () => {
  it('logged out: where the answer box would be, a notice says how to log in, with the exact command', async () => {
    await boot({ authed: false });
    expect(card().querySelector('textarea')).toBeNull();
    const notice = card().querySelector('.login-notice');
    expect(notice?.textContent).toContain('Log in to answer or close');
    expect(notice?.textContent).toContain(LOGIN_CMD);
  });

  it('logged in: the answer box offers Send answer and Close', async () => {
    await boot({ authed: true });
    expect(card().querySelector('textarea')).not.toBeNull();
    expect(button('Send answer')).toBeDefined();
    expect(button('Close')).toBeDefined();
    expect(card().querySelector('.login-notice')).toBeNull();
  });

  it('Close posts /ui/api/questions/:id/close with the session header and a JSON body', async () => {
    const daemon = await boot({ authed: true });
    button('Close')!.click();
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === `/ui/api/questions/${question.id}/close`)).toBe(true));
    const call = daemon.calls.find((c) => c.path === `/ui/api/questions/${question.id}/close`)!;
    expect(call.method).toBe('POST');
    expect(call.headers['x-jobhopper-session']).toBe('a'.repeat(64));
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toEqual({});
  });

  it('a 403 on a mutation logs the UI out and shows the login notice in the card', async () => {
    await boot({ authed: true, mutationStatus: 403 });
    const box = card().querySelector('textarea')!;
    box.value = 'main';
    box.dispatchEvent(new Event('input'));
    button('Send answer')!.click();
    await vi.waitFor(() => expect(card().querySelector('.login-notice')?.textContent).toContain(LOGIN_CMD));
    expect(card().querySelector('textarea')).toBeNull();
  });
});
