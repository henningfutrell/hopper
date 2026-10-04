import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../src/domain/ports.ts';
import type { WebhookSubscription } from '../../src/domain/types.ts';
import { createWebhookConfigWatcher, loadWebhooksFile } from '../../src/webhooks/config.ts';
import { useTempDocuments } from '../support/documents.ts';

const docs = useTempDocuments();
afterEach(() => { vi.useRealTimers(); });

const hook = (name: string, extra = '') =>
  `  - name: ${name}\n    url: http://127.0.0.1:4795/${name}\n    events: ["job.finished"]\n    secretEnv: WEBHOOK_SECRET_${name.toUpperCase()}\n${extra}`;
const doc = (...hooks: string[]) => `version: 1\nwebhooks:\n${hooks.join('')}`;
const load = (text: string) => loadWebhooksFile(text);

describe('loadWebhooksFile', () => {
  it('missing document → no webhooks and a warning', () => {
    expect(loadWebhooksFile(undefined)).toEqual({ webhooks: [], warnings: ['no webhooks.yaml yet'] });
  });

  it('parses a valid document; active defaults to true', () => {
    const r = load(doc(hook('a'), hook('b', '    active: false\n')));
    expect(r).toEqual({
      webhooks: [
        { name: 'a', url: 'http://127.0.0.1:4795/a', events: ['job.finished'], secretEnv: 'WEBHOOK_SECRET_A', active: true },
        { name: 'b', url: 'http://127.0.0.1:4795/b', events: ['job.finished'], secretEnv: 'WEBHOOK_SECRET_B', active: false },
      ],
      warnings: [],
    });
  });

  it('accepts "*" and rejects unknown event types', () => {
    expect('error' in load(doc(hook('a').replace('["job.finished"]', '["*"]')))).toBe(false);
    expect(load(doc(hook('a').replace('job.finished', 'job.exploded')))).toHaveProperty('error');
  });

  it('names the secret, never holds it: a subscription whose variable is unset still loads (issue #56)', () => {
    const r = load(doc(hook('a')));
    expect('webhooks' in r && r.webhooks[0]).toMatchObject({ secretEnv: 'WEBHOOK_SECRET_A' });
    expect(JSON.stringify(r)).not.toContain('"secret"');
  });

  it('an inline secret is refused: the hopper stores no secret; the message says what to do', () => {
    const r = load(doc(hook('a').replace('    secretEnv: WEBHOOK_SECRET_A\n', '    secret: s-a\n')));
    expect('error' in r && r.error).toMatch(/secret.*secretEnv/);
  });

  it.each([
    ['not yaml', ': : :\n  - ['],
    ['wrong version', 'version: 2\nwebhooks: []\n'],
    ['non-http url', doc(hook('a').replace('http://', 'ftp://'))],
    ['no secretEnv', doc(hook('a').replace('    secretEnv: WEBHOOK_SECRET_A\n', ''))],
    ['a secretEnv that is not a variable name', doc(hook('a').replace('WEBHOOK_SECRET_A', 'not-a-name'))],
    ['the retired secretFile', doc(hook('a').replace('    secretEnv: WEBHOOK_SECRET_A\n', '    secretFile: /x\n'))],
    ['duplicate names', doc(hook('a'), hook('a'))],
    ['unknown key', doc(hook('a', '    extra: 1\n'))],
  ])('invalid: %s', (_n, text) => {
    expect(load(text)).toHaveProperty('error');
  });
});

// ---- watcher ---------------------------------------------------------------------------

function fakeStore() {
  const subs = new Map<string, WebhookSubscription>();
  const deleted: string[] = [];
  let n = 0;
  const store = {
    webhooks: {
      upsertByName(i: { name: string; url: string; events: string[]; secretEnv: string; active: boolean }) {
        const old = [...subs.values()].find((s) => s.name === i.name);
        const s: WebhookSubscription = { ...i, id: old?.id ?? `s-${++n}`, createdAt: old?.createdAt ?? 'now' };
        subs.set(s.id, s);
        return s;
      },
      list: () => [...subs.values()],
      delete(id: string) { deleted.push(id); return subs.delete(id); },
    },
  } as unknown as Store;
  return { store, subs, deleted, names: () => [...subs.values()].map((s) => s.name).sort() };
}
const clock = { now: () => new Date('2026-10-02T12:00:00.000Z') };

describe('createWebhookConfigWatcher', () => {
  const make = (intervalMs = 5000) => {
    const d = docs();
    const f = fakeStore();
    const w = createWebhookConfigWatcher({ documents: d, store: f.store, clock, intervalMs });
    return { d, f, w, write: (text: string) => d.set('webhooks.yaml', text) };
  };

  it('reload reconciles by name: upsert present, delete absent', () => {
    const { f, w, write } = make();
    write(doc(hook('a'), hook('b')));
    w.reload();
    expect(f.names()).toEqual(['a', 'b']);
    const idA = [...f.subs.values()].find((s) => s.name === 'a')!.id;
    write(doc(hook('a').replace('job.finished', 'job.failed')));
    w.reload();
    expect(f.names()).toEqual(['a']);
    expect(f.subs.get(idA)?.events).toEqual(['job.failed']);
    expect(f.deleted).toHaveLength(1);
    expect(w.status()).toMatchObject({ document: 'webhooks.yaml', loadedAt: '2026-10-02T12:00:00.000Z', warnings: [] });
    expect(w.status().error).toBeUndefined();
  });

  it('an invalid document keeps previous subscriptions and sets error; a good one clears it', () => {
    const { f, w, write } = make();
    write(doc(hook('a')));
    w.reload();
    write('version: 9\n');
    w.reload();
    expect(f.names()).toEqual(['a']);
    expect(w.status().error).toBeTruthy();
    write(doc(hook('a'), hook('c')));
    w.reload();
    expect(f.names()).toEqual(['a', 'c']);
    expect(w.status().error).toBeUndefined();
  });

  it('a missing document clears all subscriptions and reports the warning', () => {
    const { f, w } = make();
    f.store.webhooks.upsertByName({ name: 'a', url: 'http://127.0.0.1:4795/a', events: ['job.finished'], secretEnv: 'S', active: true });
    w.reload();
    expect(f.names()).toEqual([]);
    expect(w.status().warnings).toEqual(['no webhooks.yaml yet']);
  });

  it('the store keeps the variable name, never a secret', () => {
    const { f, w, write } = make();
    write(doc(hook('a')));
    w.reload();
    expect([...f.subs.values()][0]).toMatchObject({ name: 'a', secretEnv: 'WEBHOOK_SECRET_A' });
    expect([...f.subs.values()][0]).not.toHaveProperty('secret');
  });

  it('start loads now, then reloads only when the version changes; stop halts it', () => {
    vi.useFakeTimers();
    const { f, w, write } = make();
    write(doc(hook('a')));
    const upsert = vi.spyOn(f.store.webhooks, 'upsertByName');
    w.start();
    expect(f.names()).toEqual(['a']);
    vi.advanceTimersByTime(5000);
    expect(upsert).toHaveBeenCalledTimes(1); // unchanged version: no re-read
    write(doc(hook('a'), hook('b')));
    vi.advanceTimersByTime(5000);
    expect(f.names()).toEqual(['a', 'b']);
    w.stop();
    write(doc(hook('z')));
    vi.advanceTimersByTime(20000);
    expect(f.names()).toEqual(['a', 'b']);
  });
});
