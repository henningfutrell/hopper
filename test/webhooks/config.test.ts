import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../src/domain/ports.ts';
import type { WebhookSubscription } from '../../src/domain/types.ts';
import { createWebhookConfigWatcher, loadWebhooksFile } from '../../src/webhooks/config.ts';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jh-wh-')); file = join(dir, 'webhooks.yaml'); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

const write = (text: string, mode = 0o600) => { writeFileSync(file, text); chmodSync(file, mode); };
const hook = (name: string, extra = '') =>
  `  - name: ${name}\n    url: http://127.0.0.1:4795/${name}\n    events: ["job.finished"]\n    secret: s-${name}\n${extra}`;
const doc = (...hooks: string[]) => `version: 1\nwebhooks:\n${hooks.join('')}`;

describe('loadWebhooksFile', () => {
  it('missing file → no webhooks and a warning', () => {
    expect(loadWebhooksFile(join(dir, 'nope.yaml'))).toEqual({ webhooks: [], warnings: ['no webhooks file'] });
  });

  it('parses a valid file; active defaults to true', () => {
    write(doc(hook('a'), hook('b', '    active: false\n')));
    const r = loadWebhooksFile(file);
    expect(r).toEqual({
      webhooks: [
        { name: 'a', url: 'http://127.0.0.1:4795/a', events: ['job.finished'], secret: 's-a', active: true },
        { name: 'b', url: 'http://127.0.0.1:4795/b', events: ['job.finished'], secret: 's-b', active: false },
      ],
      warnings: [],
    });
  });

  it('accepts "*" and rejects unknown event types', () => {
    write(doc(hook('a').replace('["job.finished"]', '["*"]')));
    expect('error' in loadWebhooksFile(file)).toBe(false);
    write(doc(hook('a').replace('job.finished', 'job.exploded')));
    expect(loadWebhooksFile(file)).toHaveProperty('error');
  });

  it('reads secretFile (with ~ expanded) and trims it', () => {
    const secretPath = join(dir, 'a.secret');
    writeFileSync(secretPath, 'topsecret\n');
    write(doc(hook('a').replace('    secret: s-a\n', `    secretFile: ${secretPath}\n`)));
    const r = loadWebhooksFile(file);
    expect('webhooks' in r && r.webhooks[0]?.secret).toBe('topsecret');
    write(doc(hook('a').replace('    secret: s-a\n', '    secretFile: ~/definitely-not-here-jh.secret\n')));
    const bad = loadWebhooksFile(file);
    expect('error' in bad && bad.error).toContain(join(homedir(), 'definitely-not-here-jh.secret'));
  });

  it.each([
    ['not yaml', ': : :\n  - ['],
    ['wrong version', 'version: 2\nwebhooks: []\n'],
    ['non-http url', doc(hook('a').replace('http://', 'ftp://'))],
    ['both secret and secretFile', doc(hook('a', '    secretFile: /x\n'))],
    ['neither secret nor secretFile', doc(hook('a').replace('    secret: s-a\n', ''))],
    ['duplicate names', doc(hook('a'), hook('a'))],
    ['unknown key', doc(hook('a', '    extra: 1\n'))],
  ])('invalid: %s', (_n, text) => {
    write(text);
    expect(loadWebhooksFile(file)).toHaveProperty('error');
  });

  it('inline secret in a group/other-readable file → loaded with a warning', () => {
    write(doc(hook('a')), 0o644);
    const r = loadWebhooksFile(file);
    expect('webhooks' in r && r.webhooks).toHaveLength(1);
    expect('warnings' in r && r.warnings.join(' ')).toMatch(/readable by group\/other/);
    write(doc(hook('a')), 0o600);
    expect(loadWebhooksFile(file)).toMatchObject({ warnings: [] });
  });
});

// ---- watcher ---------------------------------------------------------------------------

function fakeStore() {
  const subs = new Map<string, WebhookSubscription>();
  const deleted: string[] = [];
  let n = 0;
  const store = {
    webhooks: {
      upsertByName(i: { name: string; url: string; events: string[]; secret: string; active: boolean }) {
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
  it('reload reconciles by name: upsert present, delete absent', () => {
    const f = fakeStore();
    const w = createWebhookConfigWatcher({ path: file, store: f.store, clock, intervalMs: 5000 });
    write(doc(hook('a'), hook('b')));
    w.reload();
    expect(f.names()).toEqual(['a', 'b']);
    const idA = [...f.subs.values()].find((s) => s.name === 'a')!.id;
    write(doc(hook('a').replace('job.finished', 'job.failed')));
    w.reload();
    expect(f.names()).toEqual(['a']);
    expect(f.subs.get(idA)?.events).toEqual(['job.failed']);
    expect(f.deleted).toHaveLength(1);
    expect(w.status()).toMatchObject({ path: file, loadedAt: '2026-10-02T12:00:00.000Z', warnings: [] });
    expect(w.status().error).toBeUndefined();
  });

  it('invalid file keeps previous subscriptions and sets error; a good file clears it', () => {
    const f = fakeStore();
    const w = createWebhookConfigWatcher({ path: file, store: f.store, clock, intervalMs: 5000 });
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

  it('missing file clears all subscriptions and reports the warning', () => {
    const f = fakeStore();
    const w = createWebhookConfigWatcher({ path: file, store: f.store, clock, intervalMs: 5000 });
    write(doc(hook('a')));
    w.reload();
    rmSync(file);
    w.reload();
    expect(f.names()).toEqual([]);
    expect(w.status().warnings).toEqual(['no webhooks file']);
  });

  it('start loads now, then reloads only when the mtime changes; stop halts it', () => {
    vi.useFakeTimers();
    const f = fakeStore();
    write(doc(hook('a')));
    utimesSync(file, 1000, 1000);
    const upsert = vi.spyOn(f.store.webhooks, 'upsertByName');
    const w = createWebhookConfigWatcher({ path: file, store: f.store, clock, intervalMs: 5000 });
    w.start();
    expect(f.names()).toEqual(['a']);
    vi.advanceTimersByTime(5000);
    expect(upsert).toHaveBeenCalledTimes(1); // unchanged mtime: no re-read
    write(doc(hook('a'), hook('b')));
    utimesSync(file, 2000, 2000);
    vi.advanceTimersByTime(5000);
    expect(f.names()).toEqual(['a', 'b']);
    w.stop();
    write(doc(hook('z')));
    utimesSync(file, 3000, 3000);
    vi.advanceTimersByTime(20000);
    expect(f.names()).toEqual(['a', 'b']);
  });
});
