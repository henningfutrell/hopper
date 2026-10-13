// @vitest-environment happy-dom
// Issue #1019: the vault's view in the store is never rolled back by an answer that is older than the one it shows. Two
// sandbox runs approved at once: the answer of the first, read before the second was approved, comes back last and
// must not put the second back to waiting. A read of the view that started before a change, answered after it, must
// not either; and a vault event while a read runs reads the view again after it, so the last change is shown.
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Held { path: string; method: string; answer: (body: unknown) => void }

function fakeDaemon() {
  const held: Held[] = [];
  const fetch = vi.fn((input: string, init: RequestInit = {}) => new Promise<Response>((resolve) => {
    held.push({
      path: String(input), method: init.method ?? 'GET',
      answer: (body) => resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })),
    });
  }));
  return { fetch, held };
}

type Run = { id: string; state: string };
interface VaultStore {
  useVaultStore: { getState: () => { view: { sandboxRequests?: Run[] } | null } };
  loadVault: () => Promise<void>;
  sendVault: (edit: unknown, done: string, o?: { quiet?: boolean }) => Promise<boolean>;
}

const run = (id: string, state: string) => ({ id, jobId: `job-${id}`, template: 't', state, askedAt: '2026-10-13T10:00:00.000Z' });
const view = (...runs: ReturnType<typeof run>[]) => ({ secrets: [], templates: [], sandboxRequests: runs });
const settle = () => new Promise((r) => setTimeout(r, 0));

async function load() {
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  vi.resetModules();
  const path = '../../ui/src/store/vault.ts'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const store = (await import(path)) as VaultStore;
  const states = () => Object.fromEntries((store.useVaultStore.getState().view?.sandboxRequests ?? []).map((r) => [r.id, r.state]));
  return { daemon, store, states };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('the vault view keeps the newest answer (issue #1019)', () => {
  it('two approvals at once: the first answer, come back last, rolls nothing back', async () => {
    const { daemon, store, states } = await load();
    const first = store.sendVault({ action: 'approve', id: 'a' }, 'a', { quiet: true });
    const second = store.sendVault({ action: 'approve', id: 'b' }, 'b', { quiet: true });
    await settle();
    expect(daemon.held).toHaveLength(2);
    daemon.held[1]!.answer(view(run('a', 'starting'), run('b', 'starting')));
    await second;
    daemon.held[0]!.answer(view(run('a', 'starting'), run('b', 'waiting')));
    await first;
    expect(states()).toEqual({ a: 'starting', b: 'starting' });
  });

  it('a read started before an approval, answered after it, rolls nothing back', async () => {
    const { daemon, store, states } = await load();
    const reading = store.loadVault();
    await settle();
    const approving = store.sendVault({ action: 'approve', id: 'a' }, 'a', { quiet: true });
    await settle();
    daemon.held[1]!.answer(view(run('a', 'starting')));
    await approving;
    daemon.held[0]!.answer(view(run('a', 'waiting')));
    await reading;
    expect(states()).toEqual({ a: 'starting' });
  });

  it('a vault event while a read runs reads the view again after it', async () => {
    const { daemon, store, states } = await load();
    const one = store.loadVault();
    await settle();
    const two = store.loadVault(); // a vault event came while the first read ran
    await settle();
    expect(daemon.held).toHaveLength(1);
    daemon.held[0]!.answer(view(run('a', 'waiting')));
    await vi.waitFor(() => expect(daemon.held).toHaveLength(2));
    expect(daemon.held[1]!.path).toBe('/api/vault');
    daemon.held[1]!.answer(view(run('a', 'starting')));
    await Promise.all([one, two]);
    expect(states()).toEqual({ a: 'starting' });
  });
});
