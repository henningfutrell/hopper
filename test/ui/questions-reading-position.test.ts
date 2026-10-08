// @vitest-environment happy-dom
// The Questions view keeps the reading position (issue #450). The list is in one order, oldest first
// (the longest waiting on top), however the daemon answers. A question that arrives, closes or grows
// while the view is open does not move the card in view, nor the answer being typed into it; an
// arrival below the screen shows as "N new below", which scrolls to it. happy-dom has no layout, so
// the cards' boxes are laid out here: each card is `height` tall, stacked from the top of the page,
// and the window scrolls by `scrollBy`.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Q { id: string; text: string; createdAt: string; attempts: unknown[]; tier: string }
const ask = (id: string, minute: number, text = `question ${id}?`): Q => ({
  id, text, tier: 'human', attempts: [], createdAt: `2026-10-08T10:${String(minute).padStart(2, '0')}:00.000Z`,
});
const wire = (q: Q) => ({
  jobId: 'j', recentOutput: 'line', detectedBy: 'marker', status: 'open', notifyCount: 1, seenAt: '2026-10-08T11:00:00.000Z', updatedAt: q.createdAt, ...q,
});

const PAGE_TOP = 100;
const VIEWPORT = 800;
const layout = { scrollY: 0, height: new Map<string, number>() };
const heightOf = (id: string) => layout.height.get(id) ?? 300;

/** The cards' boxes: stacked from PAGE_TOP, in document order, less the scroll. */
function rect(el: Element): DOMRect {
  const cards = [...document.querySelectorAll<HTMLElement>('[data-question]')];
  const i = cards.indexOf(el as HTMLElement);
  if (i < 0) return new DOMRect(0, 0, 0, 0);
  const top = PAGE_TOP + cards.slice(0, i).reduce((n, c) => n + heightOf(c.dataset.question!), 0) - layout.scrollY;
  return new DOMRect(0, top, 800, heightOf(cards[i]!.dataset.question!));
}

function scrollBy(x: number | ScrollToOptions, y?: number) {
  layout.scrollY = Math.max(0, layout.scrollY + (typeof x === 'number' ? y ?? 0 : x.top ?? 0));
  window.dispatchEvent(new Event('scroll'));
}

let open: Q[] = [];
let root: Root | undefined;

function fakeDaemon() {
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  return vi.fn(async (input: string) => {
    const [path, query = ''] = String(input).split('?') as [string, string?];
    if (path === '/ui/api/session') {
      return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    }
    // Newest first, as an older daemon answered: the view's order must not depend on it.
    if (path === '/api/questions') return json({ questions: new URLSearchParams(query).get('status') === 'all' ? [] : [...open].reverse().map(wire) });
    if (path in routes) return json(routes[path]);
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

async function boot(questions: Q[]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  open = questions;
  layout.scrollY = 0;
  layout.height.clear();
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#questions';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return rect(this); });
  vi.stubGlobal('innerHeight', VIEWPORT);
  vi.stubGlobal('scrollBy', scrollBy);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(ids()).toHaveLength(questions.length));
}

/** The daemon's open questions change, and the view refreshes as on a `question.*` event or a reconnect. */
async function refresh(next: Q[]) {
  open = next;
  const store = '../../ui/src/store/index.ts';
  const { refreshQuestions } = (await import(store)) as { refreshQuestions: () => Promise<void> };
  await act(async () => { await refreshQuestions(); });
}

const ids = () => [...document.querySelectorAll<HTMLElement>('[data-question]')].map((c) => c.dataset.question);
const cardOf = (id: string) => document.querySelector<HTMLElement>(`[data-question="${id}"]`)!;
const topOf = (id: string) => cardOf(id).getBoundingClientRect().top;
const pill = () => document.querySelector<HTMLButtonElement>('[data-slot="new-questions"]');
/** Scroll so the card's top sits at `at` on the screen, as the owner would. */
const scrollTo = (id: string, at: number) => act(async () => { scrollBy(0, topOf(id) - at); });

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const a = ask('a', 1), b = ask('b', 2), c = ask('c', 3), d = ask('d', 4);

describe('the Questions view keeps the reading position (issue #450)', () => {
  it('lists the questions oldest first, the longest waiting on top, though the daemon answered newest first', async () => {
    await boot([a, b, c]);
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('a refresh with no changes keeps the order', async () => {
    await boot([a, b, c]);
    await refresh([c, a, b]);
    expect(ids()).toEqual(['a', 'b', 'c']);
    await refresh([a, b, c]);
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('a question arriving above the card in view does not move that card', async () => {
    await boot([b, c, d]);
    await scrollTo('c', 40);
    await refresh([a, b, c, d]);
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
    expect(topOf('c')).toBe(40);
  });

  it('a question above the card in view that leaves the list, or grows, does not move that card', async () => {
    await boot([a, b, c, d]);
    await scrollTo('c', 40);
    await refresh([b, c, d]);
    expect(topOf('c')).toBe(40);
    layout.height.set('b', 700);
    await refresh([b, { ...c }, d].map((q) => (q.id === 'b' ? { ...q, tier: 'opus', attempts: [{ tier: 'opus', role: 'level', startedAt: q.createdAt, outcome: 'escalated' }] } : q)));
    expect(topOf('c')).toBe(40);
  });

  it('the card in view leaving the list puts the next one where it was', async () => {
    await boot([a, b, c, d]);
    await scrollTo('c', 40);
    await refresh([a, b, d]);
    expect(topOf('d')).toBe(40);
  });

  it('a draft answer keeps its card and its position across arrivals', async () => {
    await boot([b, c]);
    await scrollTo('c', 20);
    const box = cardOf('c').querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'half an answer');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await refresh([a, b, c, d]);
    expect(cardOf('c').querySelector('textarea')).toBe(box);
    expect(box.value).toBe('half an answer');
    expect(topOf('c')).toBe(20);
  });

  it('an arrival below the screen shows as "N new below", which scrolls to the first of them and clears', async () => {
    await boot([a, b, c]);
    expect(pill()).toBeNull();
    await refresh([a, b, c, d]);
    expect(topOf('d')).toBeGreaterThanOrEqual(VIEWPORT);
    expect(pill()?.textContent).toBe('1 new below');
    const e = ask('e', 5);
    await refresh([a, b, c, d, e]);
    expect(pill()?.textContent).toBe('2 new below');
    await act(async () => { pill()!.click(); });
    expect(topOf('d')).toBeLessThan(VIEWPORT);
    expect(topOf('d')).toBeGreaterThanOrEqual(0);
    expect(pill()).toBeNull();
  });

  it('an arrival on screen needs no indicator', async () => {
    await boot([a]);
    await refresh([a, b]);
    expect(topOf('b')).toBeLessThan(VIEWPORT);
    expect(pill()).toBeNull();
  });
});
