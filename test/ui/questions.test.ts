// @vitest-environment happy-dom
// The UI's question card (ui/src/views/questions.tsx), rendered in happy-dom inside the whole app
// against a fake of the daemon's HTTP surface: the browser's only seam. Logged out, there is no card,
// only the landing page (issue #213); logged in, it offers Send answer and Close (Close asks first, in
// a dialog); a 403 on a mutation logs the UI out, to the landing page. Dismiss
// drops a question (asks first); opening the view marks the owner's questions seen. The nav badge
// counts the open questions at the human stage, seen or not, and clears only when none is open (issue #499). The Questions view holds the open questions only (issue #151): the handled ones are
// the question history in Settings, a compact list, each opening to its question and answer.
// A session whose role cannot answer (viewer, issue #39) says so; a 403 naming the role needed keeps
// the session.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const question = {
  id: 'bf094266', jobId: '89849c4f', text: 'Which branch?', recentOutput: 'line', detectedBy: 'marker', status: 'open',
  tier: 'human', attempts: [], notifyCount: 1, createdAt: '2026-10-03T20:00:00.000Z', updatedAt: '2026-10-03T20:00:00.000Z',
};

const handled = {
  ...question, id: 'c41a0d2e', text: 'Rebase or merge?', status: 'answered', answer: 'merge', answeredBy: 'human',
  createdAt: '2026-10-03T19:00:00.000Z', updatedAt: '2026-10-03T19:05:00.000Z',
};

interface Call { path: string; method: string; headers: Record<string, string>; body?: unknown }

type Role = 'viewer' | 'operator' | 'admin';
interface Boot { attempts?: unknown[]; lapsesAt?: string; seenAt?: string; tier?: string; authed: boolean; hash?: string; role?: Role; mutationStatus?: number; mutationError?: string; mutationDelayMs?: number; needs?: Role; realms?: { name: string; label: string; type: string }[] }

function fakeDaemon(o: Boot) {
  const calls: Call[] = [];
  const open = {
    ...question, attempts: o.attempts ?? [], ...(o.lapsesAt ? { lapsesAt: o.lapsesAt } : {}), ...(o.seenAt ? { seenAt: o.seenAt } : {}), ...(o.tier ? { tier: o.tier } : {}),
  } as Record<string, unknown>;
  // What GET /api/questions?status=open answers; a test changes it as the daemon's questions change.
  const daemonState = { open: [open] };
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] },
    '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] },
    '/api/webhooks/deliveries': { deliveries: [] },
    '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/accounts': { accounts: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path, query = ''] = String(input).split('?') as [string, string?];
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    calls.push({ path, method: init.method ?? 'GET', headers, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const signIn = { local: true, origin: location.origin, realms: o.realms ?? [] };
    if (path === '/ui/api/session') {
      return json(200, o.authed
        ? { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: o.role ?? 'admin', realm: 'local', name: 'login code' }, signIn }
        : { authenticated: false, signIn });
    }
    if (path === '/api/questions') return json(200, { questions: new URLSearchParams(query).get('status') === 'all' ? [...daemonState.open, handled] : daemonState.open });
    if (path === `/ui/api/questions/${question.id}/seen`) { open.seenAt ??= '2026-10-03T20:01:00.000Z'; return json(200, open); }
    if (path.startsWith('/ui/api/')) {
      if (o.mutationDelayMs) await new Promise((r) => setTimeout(r, o.mutationDelayMs));
      const status = o.mutationStatus ?? 200;
      if (status === 200) return json(200, { ...question, status: 'closed' });
      if (o.mutationError) return json(status, { error: o.mutationError });
      return json(status, o.needs ? { error: `role ${o.role} may not do this; it needs ${o.needs}`, needs: o.needs } : { error: 'missing or invalid x-hopper-session' });
    }
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
  return { fetch, calls, open, setOpen: (qs: Record<string, unknown>[]) => { daemonState.open = qs; } };
}

const streams: FakeEventSource[] = [];
class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (m: { data: string }) => void>();
  constructor() { streams.push(this); }
  addEventListener(type: string, fn: (m: { data: string }) => void): void { this.listeners.set(type, fn); }
  close(): void {}
}
let seq = 0;
/** The daemon's stream sends a question event, as it does on a raise, an answer, a close, a dismiss or an expiry. */
const emit = (type: string) => act(async () => {
  streams.at(-1)!.listeners.get(type)!({ data: JSON.stringify({ seq: ++seq, schemaVersion: 1, id: String(seq), type, at: new Date().toISOString(), jobId: question.jobId, data: { questionId: question.id } }) });
});

let root: Root | undefined;

async function boot(o: Boot) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = o.hash ?? '#questions';
  localStorage.clear();
  if (o.authed) localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(o);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  if (!o.hash && o.authed) await vi.waitFor(() => expect(card()).not.toBeNull());
  return daemon;
}

const card = () => [...document.querySelectorAll('[data-slot="card"]')].find((c) => c.textContent?.includes(question.text)) ?? null;
const button = (label: string, within: ParentNode = card()!) => [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const notice = () => card()!.querySelector('[data-slot="login-notice"]');
const landing = () => document.querySelector('[data-slot="landing"]');
const click = (b: HTMLElement | undefined) => act(async () => { b!.click(); });

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('question card', () => {
  it('logged out: no card, only the landing page, with no login code box', async () => {
    await boot({ authed: false });
    await vi.waitFor(() => expect(landing()).not.toBeNull());
    expect(card()).toBeNull();
    expect(document.querySelector('input[aria-label="Login code"]')).toBeNull();
  });

  it('logged in: the answer box offers Send answer and Close', async () => {
    await boot({ authed: true });
    await vi.waitFor(() => expect(card()!.querySelector('textarea')).not.toBeNull());
    expect(button('Send answer')).toBeDefined();
    expect(button('Close')).toBeDefined();
    expect(notice()).toBeNull();
  });

  it('Close asks first, then posts /ui/api/questions/:id/close with the session header and a JSON body', async () => {
    const daemon = await boot({ authed: true });
    await vi.waitFor(() => expect(button('Close')).toBeDefined());
    await click(button('Close'));
    const path = `/ui/api/questions/${question.id}/close`;
    expect(daemon.calls.some((c) => c.path === path)).toBe(false);
    const dialog = await vi.waitFor(() => { const d = document.querySelector('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    await click(button('Close question', dialog));
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === path)).toBe(true));
    const call = daemon.calls.find((c) => c.path === path)!;
    expect(call.method).toBe('POST');
    expect(call.headers['x-hopper-session']).toBe('a'.repeat(64));
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toEqual({});
  });

  it('a 403 on a mutation logs the UI out, to the landing page', async () => {
    await boot({ authed: true, mutationStatus: 403 });
    const box = await vi.waitFor(() => { const t = card()!.querySelector('textarea'); expect(t).not.toBeNull(); return t!; });
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(box, 'main');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Send answer'));
    await vi.waitFor(() => expect(landing()).not.toBeNull());
    expect(card()).toBeNull();
  });

  it('a viewer: no answer box; the card says the role cannot answer', async () => {
    await boot({ authed: true, role: 'viewer' });
    await vi.waitFor(() => expect(notice()?.textContent).toContain('viewer'));
    expect(card()!.querySelector('textarea')).toBeNull();
    expect(notice()?.textContent).toMatch(/cannot answer/);
  });

  it('a 403 naming the role needed keeps the session: the answer box stays', async () => {
    await boot({ authed: true, role: 'operator', mutationStatus: 403, needs: 'admin' });
    await vi.waitFor(() => expect(button('Close')).toBeDefined());
    await click(button('Close'));
    const dialog = await vi.waitFor(() => { const d = document.querySelector('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    await click(button('Close question', dialog));
    await new Promise((r) => setTimeout(r, 50));
    expect(card()!.querySelector('textarea')).not.toBeNull();
    expect(localStorage.getItem('jh_session')).toBe('a'.repeat(64));
  });

  it('logged out with OIDC, GitHub or SAML realms: the landing page offers a sign-in button per realm', async () => {
    await boot({ authed: false, realms: [{ name: 'corp', label: 'Corp SSO', type: 'oidc' }] });
    await vi.waitFor(() => expect(button('Sign in with Corp SSO', document.body)).toBeDefined());
  });

  // Issue #376: a dialog the agent denies by itself when its countdown runs out says so, with the time left.
  it('a dialog with a countdown: the card says Claude Code denies it by itself, and when', async () => {
    await boot({ authed: true, lapsesAt: new Date(Date.now() + 90_000).toISOString() });
    const lapses = await vi.waitFor(() => { const l = card()!.querySelector('[data-slot="lapses"]'); expect(l).not.toBeNull(); return l!; });
    expect(lapses.textContent).toMatch(/^Claude Code denies this by itself in 1m.* unless it is answered first\.$/);
  });

  it('no countdown: no such line', async () => {
    await boot({ authed: true });
    await vi.waitFor(() => expect(card()!.querySelector('textarea')).not.toBeNull());
    expect(card()!.querySelector('[data-slot="lapses"]')).toBeNull();
  });

  it('logged in: Dismiss sits beside Close, asks first, then posts /ui/api/questions/:id/dismiss', async () => {
    const daemon = await boot({ authed: true });
    await vi.waitFor(() => expect(button('Dismiss')).toBeDefined());
    await click(button('Dismiss'));
    const path = `/ui/api/questions/${question.id}/dismiss`;
    expect(daemon.calls.some((c) => c.path === path)).toBe(false);
    const dialog = await vi.waitFor(() => { const d = document.querySelector('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    expect(dialog.textContent).toContain('cancelled');
    await click(button('Dismiss question', dialog));
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === path)).toBe(true));
    expect(daemon.calls.find((c) => c.path === path)!.body).toEqual({});
  });
});

const badge = () => document.querySelector('a[href="#questions"] [data-slot="nav-badge"]');

describe("the levels' recommendations on an escalated question", () => {
  const attempts = [
    { tier: 'opus', role: 'level', model: 'claude-opus-x', startedAt: '2026-10-03T20:00:00.000Z', answer: 'wait for the owner', escalate: true, reason: 'not sure', outcome: 'escalated' },
    { tier: 'fable', role: 'level', model: 'claude-fable-x', startedAt: '2026-10-03T20:00:01.000Z', answer: 'take option 1', escalate: true, reason: 'the owner picks', outcome: 'escalated' },
  ];

  const useButtons = () => [...card()!.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Use answer');
  const answers = (daemon: { calls: Call[] }) => daemon.calls.filter((c) => c.path === `/ui/api/questions/${question.id}/answer`);
  const result = () => card()?.querySelector('[data-slot="answer-result"]') ?? null;

  it('show on the trail with the model that ran, each with Use answer', async () => {
    await boot({ authed: true, attempts });
    await vi.waitFor(() => expect(card()!.querySelector('textarea')).not.toBeNull());
    expect(card()!.textContent).toContain('take option 1');
    expect(card()!.textContent).toContain('claude-fable-x');
    expect(useButtons()).toHaveLength(2);
  });

  // Issue #459: one click sends; no separate Send. The same answer route as Send answer.
  it('Use answer sends that answer at once: exactly one POST of it, and the card says it was sent', async () => {
    const daemon = await boot({ authed: true, attempts });
    await vi.waitFor(() => expect(useButtons()).toHaveLength(2));
    await click(useButtons()[1]);
    await vi.waitFor(() => expect(answers(daemon)).toHaveLength(1));
    const call = answers(daemon)[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers['x-hopper-session']).toBe('a'.repeat(64));
    expect(call.body).toEqual({ answer: 'take option 1' });
    await vi.waitFor(() => expect(result()?.textContent).toMatch(/sent/i));
    expect(card()!.querySelector('textarea')!.value).toBe('');
  });

  it('a double click is one submission: the buttons are disabled while it is in flight', async () => {
    const daemon = await boot({ authed: true, attempts, mutationDelayMs: 100 });
    await vi.waitFor(() => expect(useButtons()).toHaveLength(2));
    const use = useButtons()[0]!;
    await act(async () => { use.click(); use.click(); });
    expect(useButtons().every((b) => b.disabled)).toBe(true);
    expect(button('Sending…')!.disabled).toBe(true);
    await click(useButtons()[1]);
    await vi.waitFor(() => expect(result()?.textContent).toMatch(/sent/i));
    expect(answers(daemon)).toHaveLength(1);
    expect(answers(daemon)[0]!.body).toEqual({ answer: 'wait for the owner' });
  });

  it('a failed send says why on the card, with Retry, which sends the same answer again', async () => {
    const daemon = await boot({ authed: true, attempts, mutationStatus: 500, mutationError: 'database unavailable' });
    await vi.waitFor(() => expect(useButtons()).toHaveLength(2));
    await click(useButtons()[1]);
    await vi.waitFor(() => expect(result()?.textContent).toContain('database unavailable'));
    expect(answers(daemon)).toHaveLength(1);
    await click(button('Retry'));
    await vi.waitFor(() => expect(answers(daemon)).toHaveLength(2));
    expect(answers(daemon)[1]!.body).toEqual({ answer: 'take option 1' });
  });

  it('the answer box and Send answer stay, for an answer of the owner\'s own', async () => {
    await boot({ authed: true, attempts });
    await vi.waitFor(() => expect(button('Send answer')).toBeDefined());
    expect(card()!.querySelector('textarea')).not.toBeNull();
  });
});

describe('the Questions badge', () => {
  // Issue #499: the badge counts what waits on the owner, not what they have not looked at yet.
  it('counts the open questions at the human stage; opening Questions marks them seen and the badge stays', async () => {
    const daemon = await boot({ authed: true, hash: '#overview' });
    await vi.waitFor(() => expect(badge()?.textContent).toBe('1'));
    expect(daemon.calls.some((c) => c.path.endsWith('/seen'))).toBe(false);
    await act(async () => { window.location.hash = '#questions'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === `/ui/api/questions/${question.id}/seen` && c.method === 'POST')).toBe(true));
    await vi.waitFor(() => expect(daemon.open.seenAt).toBeDefined());
    await act(async () => { window.location.hash = '#overview'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(badge()?.textContent).toBe('1');
  });

  it('a question already seen still counts on a fresh load', async () => {
    await boot({ authed: true, hash: '#overview', seenAt: '2026-10-03T20:01:00.000Z' });
    await vi.waitFor(() => expect(badge()?.textContent).toBe('1'));
  });

  it('a question still with an escalation level does not count: it does not wait on the owner yet', async () => {
    await boot({ authed: true, hash: '#overview', tier: 'opus' });
    await vi.waitFor(() => expect(document.querySelector('a[href="#questions"]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(badge()).toBeNull();
  });

  it('clears only when none is open, and comes back when one is raised: live, from the stream, no reload', async () => {
    const daemon = await boot({ authed: true, hash: '#overview', seenAt: '2026-10-03T20:01:00.000Z' });
    await vi.waitFor(() => expect(badge()?.textContent).toBe('1'));
    daemon.setOpen([]);
    await emit('question.answered');
    await vi.waitFor(() => expect(badge()).toBeNull());
    daemon.setOpen([{ ...daemon.open, seenAt: undefined }, { ...daemon.open, id: 'd0e1f2a3', seenAt: undefined }]);
    await emit('question.escalated_to_human');
    await vi.waitFor(() => expect(badge()?.textContent).toBe('2'));
  });
});

describe('handled questions', () => {
  it('are not on the Questions view, nor are the question gates', async () => {
    await boot({ authed: true });
    expect(document.querySelector('[data-slot="handled-questions"]')).toBeNull();
    expect(document.querySelector('[data-slot="question-gates"]')).toBeNull();
  });

  it('are the question history in Settings, a compact list; a row opens to the question, the answer and who gave it', async () => {
    await boot({ authed: true, hash: '#settings/history' });
    const list = await vi.waitFor(() => { const l = document.querySelector('[data-slot="handled-questions"]'); expect(l).not.toBeNull(); return l!; });
    const rows = list.querySelectorAll('[data-slot="handled-question"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Rebase or merge?');
    expect(rows[0]!.textContent).toContain('answered');
    expect(rows[0]!.textContent).not.toContain('merge\n');
    await click(rows[0]!.querySelector('button') as HTMLElement);
    await vi.waitFor(() => expect(rows[0]!.textContent).toContain('by human'));
    expect(rows[0]!.querySelector('[data-slot="question-text"]')?.textContent).toContain('Rebase or merge?');
    expect(list.textContent).not.toContain(question.text);
  });
});
