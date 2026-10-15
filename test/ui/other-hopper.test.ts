// @vitest-environment happy-dom
// Issue #1295: a job's test hopper took the address of the user's hopper while that one was down, and its master key
// banner reached the admin as if it were the real hopper's. The page now knows which hopper it talks to (the instance
// tag on every answer, kept in the browser): an answer from another hopper is dropped, the session is neither sent to it
// again nor cleared, and one notice takes the place of every view and banner.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterKeyView } from '../../src/domain/types.ts';

type El = ReturnType<typeof createElement>;
const API = '../../ui/src/lib/api.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
const INSTANCE = '../../ui/src/lib/instance.ts';
const GATE = '../../ui/src/app/other-hopper.tsx';
const MASTER_KEY = '../../ui/src/app/master-key.tsx';

interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  readSession(): Promise<unknown>;
  readToken(): string | null;
}
interface Instance { OtherHopper: new (...a: never[]) => Error; checkInstance(seen: string | null): void; otherHopper(): unknown }

const MINE = '1111111111111111', THEIRS = '2222222222222222', TOKEN = 'ab'.repeat(32);
const GENERATED: MasterKeyView = { source: 'generated', previous: false, fingerprint: '0123456789abcdef', saved: false, revealable: true };

/** A daemon at the page's address: `tag` is the hopper that answers now; every request it got is kept. */
function address(tag: { now: string | null }) {
  const seen: { path: string; session: string | null }[] = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    seen.push({ path, session: new Headers(init?.headers).get('x-hopper-session') });
    const body = path === '/ui/api/session'
      ? { authenticated: false, signIn: { realms: [] } }
      : path === '/api/master-key' ? GENERATED : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(tag.now ? { 'x-hopper-instance': tag.now } : {}) } });
  });
  return { fetch, seen };
}

let root: Root | undefined;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('jh_session', TOKEN);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('another hopper at the page\'s address (#1295)', () => {
  it('an answer from another hopper is dropped; the session is not sent to it again, nor cleared', async () => {
    const tag = { now: MINE as string | null };
    const d = address(tag);
    vi.stubGlobal('fetch', d.fetch);
    const api = (await import(API)) as Api;
    const { OtherHopper, otherHopper } = (await import(INSTANCE)) as Instance;
    expect(await api.get('/api/health')).toEqual({ ok: true });
    tag.now = THEIRS;
    await expect(api.get('/api/master-key')).rejects.toBeInstanceOf(OtherHopper);
    expect(otherHopper()).toEqual({ expected: MINE, seen: THEIRS });
    const asked = d.seen.length;
    await expect(api.get('/api/master-key')).rejects.toBeInstanceOf(OtherHopper);
    await expect(api.post('/ui/api/master-key', { action: 'reveal' })).rejects.toBeInstanceOf(OtherHopper);
    await expect(api.readSession()).rejects.toBeInstanceOf(OtherHopper);
    expect(d.seen.length).toBe(asked);
    expect(api.readToken()).toBe(TOKEN);
  });

  it('a fresh page knows its hopper from the browser: another one there is told at the first answer, and the session it says is over stays', async () => {
    localStorage.setItem('jh_instance', MINE);
    vi.stubGlobal('fetch', address({ now: THEIRS }).fetch);
    const api = (await import(API)) as Api;
    const { OtherHopper } = (await import(INSTANCE)) as Instance;
    await expect(api.readSession()).rejects.toBeInstanceOf(OtherHopper);
    expect(api.readToken()).toBe(TOKEN);
  });

  it('an answer with no tag, once the page knows its hopper, is from another one', async () => {
    const tag = { now: MINE as string | null };
    vi.stubGlobal('fetch', address(tag).fetch);
    const api = (await import(API)) as Api;
    const { OtherHopper } = (await import(INSTANCE)) as Instance;
    await api.get('/api/health');
    tag.now = null;
    await expect(api.get('/api/health')).rejects.toBeInstanceOf(OtherHopper);
  });

  it('the first hopper the browser meets is kept as its own', async () => {
    vi.stubGlobal('fetch', address({ now: MINE }).fetch);
    const api = (await import(API)) as Api;
    await api.get('/api/health');
    expect(localStorage.getItem('jh_instance')).toBe(MINE);
  });

  it('the test hopper\'s master key banner never shows: the notice takes the place of the page', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const tag = { now: MINE as string | null };
    vi.stubGlobal('fetch', address(tag).fetch);
    const api = (await import(API)) as Api;
    const { HopperGate } = (await import(GATE)) as { HopperGate: (p: { children?: El }) => El };
    const { MasterKeyBanner } = (await import(MASTER_KEY)) as { MasterKeyBanner: (p: Record<string, unknown>) => El };
    await api.get('/api/health');
    document.body.innerHTML = '<div id="root"></div>';
    const page = () => createElement(HopperGate, null, createElement(MasterKeyBanner, { view: GENERATED, admin: true, onReveal: () => {}, onSaved: () => {} }));
    await act(async () => { root = createRoot(document.getElementById('root')!); root.render(page()); });
    const el = document.getElementById('root')!;
    expect(el.querySelector('[data-master-key]')).not.toBeNull();
    expect(el.querySelector('[data-other-hopper]')).toBeNull();

    tag.now = THEIRS;
    await act(async () => { await api.get('/api/master-key').catch(() => undefined); });
    expect(el.querySelector('[data-master-key]')).toBeNull();
    const notice = el.querySelector('[data-other-hopper]')!;
    expect(notice.textContent).toContain('Another hopper answers at this address');
    expect(notice.textContent).toContain(MINE);
    expect(notice.textContent).toContain(THEIRS);
  });

  it('"This is my hopper now" forgets the old one and the session, and reads the page again', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('jh_instance', MINE);
    vi.stubGlobal('fetch', address({ now: THEIRS }).fetch);
    const reload = vi.fn();
    const api = (await import(API)) as Api;
    const { HopperGate } = (await import(GATE)) as { HopperGate: (p: { children?: El; reload?: () => void }) => El };
    await api.readSession().catch(() => undefined);
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(HopperGate, { reload }, createElement('p', null, 'page'))); });
    const el = document.getElementById('root')!;
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('This is my hopper now'))!;
    await act(async () => button.click());
    expect(localStorage.getItem('jh_instance')).toBeNull();
    expect(api.readToken()).toBeNull();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('the event stream: no event before its tag; another hopper\'s tag ends it', async () => {
    const streams: FakeEventSource[] = [];
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      readonly listeners = new Map<string, ((m: { data: string }) => void)[]>();
      constructor() { streams.push(this); }
      addEventListener(type: string, fn: (m: { data: string }) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
      emit(type: string, data: unknown): void { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); }
      close(): void { this.closed = true; }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', address({ now: MINE }).fetch);
    const api = (await import(API)) as Api;
    const { connect } = (await import('../../ui/src/store/stream.ts')) as { connect(): () => void };
    const { useHopper } = (await import('../../ui/src/store/index.ts')) as { useHopper: { getState(): { events: { seq: number }[] } } };
    await api.get('/api/health');
    const close = connect();
    const es = streams[0]!;
    const event = (seq: number) => ({ seq, type: 'job.queued', at: '2026-10-15T00:00:00.000Z', jobId: 'j1', data: {} });
    es.onopen?.();
    es.emit('job.queued', event(1));
    expect(useHopper.getState().events.map((e) => e.seq)).toEqual([]);
    es.emit('hopper.instance', MINE);
    es.emit('job.queued', event(2));
    expect(useHopper.getState().events.map((e) => e.seq)).toEqual([2]);
    es.onopen?.();
    es.emit('hopper.instance', THEIRS);
    es.emit('job.queued', event(3));
    expect(es.closed).toBe(true);
    expect(useHopper.getState().events.map((e) => e.seq)).toEqual([2]);
    close();
  });
});
