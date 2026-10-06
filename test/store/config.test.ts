// Config records (design.md "Config in the database", issue #198): a user's `plugins` and `rules`, the
// instance's `sign-in` — JSON values in the store, each replaced whole against its version. No file,
// no YAML.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const versionOf = (value: unknown) => sha(JSON.stringify(value));

describe('config records', () => {
  it('a record not written yet reads undefined, version missing', () => {
    const s = t.open(t.url());
    expect(s.config.read('plugins')).toBeUndefined();
    expect(s.config.version('plugins')).toBe('missing');
    s.close();
  });

  it('holds a JSON value, written against missing, then only against the version it was read at', () => {
    const s = t.open(t.url());
    const plugins = { version: 1, executors: [{ name: 'test', plugin: 'test' }] };
    expect(s.config.write('plugins', plugins, 'missing')).toBe(true);
    expect(s.config.read('plugins')).toEqual(plugins);
    expect(s.config.version('plugins')).toBe(versionOf(plugins));
    expect(s.config.write('rules', 'be kind\n', 'missing')).toBe(true);
    expect(s.config.read('rules')).toBe('be kind\n');
    expect(s.config.write('rules', 'stale', 'missing')).toBe(false);
    expect(s.config.write('rules', 'stale', versionOf('other'))).toBe(false);
    expect(s.config.write('rules', 'be brief\n', versionOf('be kind\n'))).toBe(true);
    expect(s.config.read('rules')).toBe('be brief\n');
    s.close();
  });

  it('records are independent and survive a reopen; sign-in is the instance\'s, the others a user\'s', () => {
    const url = t.url();
    const s = t.open(url, fixedClock());
    s.config.write('plugins', { version: 1 }, 'missing');
    s.close();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    // A fresh hopper starts with a sign-in config record (migration 20, issue #200): written against its version.
    expect(instance.config.write('sign-in', { version: 1, realms: [] }, instance.config.version('sign-in'))).toBe(true);
    instance.close();
    const again = t.open(url);
    expect(again.config.read('plugins')).toEqual({ version: 1 });
    expect(again.config.read('rules')).toBeUndefined();
    expect(() => again.config.read('sign-in' as 'rules')).toThrow(/no config record sign-in here/);
    again.close();
    const instanceAgain = openInstanceStore({ url, clock: fixedClock() });
    expect(instanceAgain.config.read('sign-in')).toEqual({ version: 1, realms: [] });
    expect(() => instanceAgain.config.read('plugins' as 'sign-in')).toThrow(/no config record plugins here/);
    instanceAgain.close();
  });

  it('the store holds no config document table: no text to hand-edit, only the records', () => {
    const url = t.url();
    t.open(url).close();
    const raw = openDb(url);
    expect(raw.get("SELECT to_regclass('config_documents') AS t")!.t).toBeNull();
    expect(raw.get("SELECT to_regclass('config') AS t")!.t).not.toBeNull();
    raw.close();
  });

  it('a write is refused when another store replaced the record after it was read', () => {
    const url = t.url();
    const a = t.open(url);
    const b = t.open(url);
    a.config.write('rules', 'one', 'missing');
    const seen = a.config.version('rules');
    expect(b.config.write('rules', 'two', seen)).toBe(true);
    expect(a.config.write('rules', 'three', seen)).toBe(false);
    expect(b.config.write('rules', 'four', 'missing')).toBe(false);
    expect(a.config.read('rules')).toBe('two');
    a.close();
    b.close();
  });

  it('a write inside a transaction that rolls back leaves the record as it was', () => {
    const s = t.open(t.url());
    s.config.write('rules', 'a', 'missing');
    expect(() => s.tx(() => { s.config.write('rules', 'b', versionOf('a')); throw new Error('no'); })).toThrow('no');
    expect(s.config.read('rules')).toBe('a');
    s.close();
  });
});
