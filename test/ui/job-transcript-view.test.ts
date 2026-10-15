// @vitest-environment happy-dom
// Issue #1169 part 4: the job's transcript on the job view (#job/<id>), rendered inside the whole app against a fake of
// the daemon's HTTP surface. An operator opens the transcript of a job whose checkpoint keeps its agent session: each
// turn is a Message in a Message Scroller — the prompt, then the agent's reply with its steps as a Trace — and a step
// opens to its input and result in a small code block. Earlier turns load in front, and the scroller keeps its place.
// A viewer, or a job with no kept session, gets no transcript.
//
// Feature: the job's transcript
//   Scenario: an operator opens the transcript; a step opens to its input and result
//   Scenario: earlier turns load in front
//   Scenario: a viewer, or a job with no kept session, gets no transcript
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { JobTranscript, TranscriptTurn } from '../../src/domain/transcript.ts';

const T = '2026-10-14T12:00:00.000Z';
const checkpoint = { at: T, machineId: 'local', base: 'b', head: 'c', commits: [], bytes: 2048, session: true };
const kept = {
  id: 'r1', spec: { executor: 'herdr-claude', payload: {}, goal: 'Paint the shed' }, priority: 50, status: 'running', approved: true, attempts: 1,
  createdAt: T, updatedAt: T, startedAt: T, laneId: 'desk/lane-1', checkpoint,
} as unknown as Job;
const none = { ...kept, id: 'n1', checkpoint: { ...checkpoint, session: false } } as unknown as Job;

const turn = (index: number, extra: Partial<TranscriptTurn> = {}): TranscriptTurn => ({ index, at: T, prompt: `prompt ${index}`, parts: [{ kind: 'text', text: `answer ${index}` }], ...extra });
const NEWEST: JobTranscript = {
  jobId: 'r1', checkpointAt: T, total: 3, start: 1,
  turns: [
    turn(1),
    turn(2, {
      parts: [
        { kind: 'reasoning', text: 'Blue is best.' },
        { kind: 'text', text: 'I paint it **blue**.' },
        { kind: 'tool', id: 't1', name: 'Bash', title: 'Paint it', input: 'paint --blue', result: 'painted' },
        { kind: 'tool', id: 't2', name: 'Read', title: 'shed.txt', input: '{}', result: 'no such file', error: true },
        { kind: 'plan', id: 'p1', items: [{ text: 'Sand', status: 'completed' }, { text: 'Paint', status: 'in_progress' }] },
        { kind: 'subagent', id: 's1', name: 'Task', title: 'Find the brush', agent: 'Explore', prompt: 'Look in the garage', result: 'In the garage.' },
      ],
    }),
  ],
};
const EARLIER: JobTranscript = { jobId: 'r1', checkpointAt: T, total: 3, start: 0, turns: [turn(0)] };

let calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];

function fakeDaemon(role: 'operator' | 'viewer') {
  const routes: Record<string, (body?: Record<string, unknown>) => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [kept, none], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/ui/api/jobs/r1/transcript': (body) => (body?.before === 1 ? EARLIER : NEWEST),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method: init.method ?? 'GET', path, ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in routes ? json(routes[path]!(body)) : new Response('{"error":"not found"}', { status: 404 });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(id: string, role: 'operator' | 'viewer' = 'operator') {
  calls = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = `#job/${id}`;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(role));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="job-view"]')).not.toBeNull());
}

const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const transcriptPosts = () => calls.filter((c) => c.method === 'POST' && c.path === '/ui/api/jobs/r1/transcript');
const messages = () => [...document.querySelectorAll<HTMLElement>('[data-slot="job-transcript"] [data-slot="message"]')];

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the job transcript on the job view (issue #1169)', () => {
  it('an operator opens it: each turn is a prompt and a reply, and a step opens to its input and result', async () => {
    await boot('r1');
    await vi.waitFor(() => expect(button(/Open transcript/)).toBeDefined());
    expect(transcriptPosts()).toHaveLength(0);
    await act(async () => { button(/Open transcript/)!.click(); });
    await vi.waitFor(() => expect(messages().length).toBe(4));
    expect(transcriptPosts()[0]!.body).toEqual({ limit: 20 });
    expect(document.querySelector('[data-slot="job-transcript"] [data-slot="message-scroller"]')).not.toBeNull();

    const [prompt1, reply1, prompt2, reply2] = messages();
    expect(prompt1!.dataset.align).toBe('end');
    expect(prompt1!.textContent).toContain('prompt 1');
    expect(reply1!.dataset.align).toBe('start');
    expect(reply1!.textContent).toContain('answer 1');
    expect(prompt2!.textContent).toContain('prompt 2');
    expect(reply2!.querySelector('strong')?.textContent).toBe('blue');

    const lines = [...reply2!.querySelectorAll<HTMLElement>('[data-slot="trace-line"]')];
    expect(lines.map((l) => l.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Thinking'), expect.stringContaining('Paint it'), expect.stringContaining('shed.txt'),
      expect.stringContaining('Plan'), expect.stringContaining('Find the brush'),
    ]));
    const read = lines.find((l) => l.textContent?.includes('shed.txt'))!;
    expect(read.dataset.status).toBe('error');

    const paint = [...reply2!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Paint it'))!;
    expect(paint.getAttribute('aria-label')).toContain('Bash');
    await act(async () => { paint.click(); });
    await vi.waitFor(() => expect(reply2!.querySelectorAll('[data-slot="code-block"][data-size="sm"]').length).toBeGreaterThanOrEqual(2));
    expect(reply2!.textContent).toContain('paint --blue');
    expect(reply2!.textContent).toContain('painted');
  });

  it('loads earlier turns in front of the ones it shows, and the scroller keeps its place', async () => {
    await boot('r1');
    await vi.waitFor(() => expect(button(/Open transcript/)).toBeDefined());
    await act(async () => { button(/Open transcript/)!.click(); });
    await vi.waitFor(() => expect(button(/Load earlier turns/)).toBeDefined());
    await act(async () => { button(/Load earlier turns/)!.click(); });
    await vi.waitFor(() => expect(messages().length).toBe(6));
    expect(transcriptPosts()[1]!.body).toEqual({ before: 1, limit: 20 });
    expect(messages()[0]!.textContent).toContain('prompt 0');
    expect(button(/Load earlier turns/)).toBeUndefined();
  });

  it('shows no transcript to a viewer, nor for a job whose checkpoint keeps no session', async () => {
    await boot('r1', 'viewer');
    await new Promise((r) => setTimeout(r, 50));
    expect(button(/Open transcript/)).toBeUndefined();
    act(() => root?.unmount());
    await boot('n1');
    await new Promise((r) => setTimeout(r, 50));
    expect(button(/Open transcript/)).toBeUndefined();
  });
});
