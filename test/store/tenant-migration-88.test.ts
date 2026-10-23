// Tenant migration 88 (issue #2146, part 5): an observe changes no asset, so a template a job asked for with read and
// observe needs only takes the read-only check, as one of read needs only does. Each stored template whose profiles are
// all reads or observes, with an observe among them, is marked `readOnly`; every other template is left as it is.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at87(...templates: Record<string, unknown>[]): Db {
  const raw = t.tenantAt(t.url(), 87);
  for (const tp of templates) raw.run('INSERT INTO templates (name, body) VALUES (?, ?)', String(tp.name), JSON.stringify(tp));
  return raw;
}

const stored = (raw: Db) => raw.all('SELECT body FROM templates ORDER BY name').map((r) => JSON.parse(String(r.body)) as Record<string, unknown>);
const base = (name: string) => ({ name, image: 'img', secrets: [], savedBy: 'job j', savedAt: '2026-10-20T10:00:00Z' });
const observe = { operation: 'observe', asset: { kind: 'namespace', name: 'utility/monitoring' } };
const read = { operation: 'read', asset: { kind: 'cluster', name: 'utility' } };
const write = { operation: 'write', asset: { kind: 'namespace', name: 'utility/web' } };

describe('tenant migration 88: a template of read and observe needs takes the read-only check', () => {
  it('marks a template of observes, or of reads and observes, readOnly; leaves the others', () => {
    const a = { ...base('a-observe'), profiles: [observe] };
    const b = { ...base('b-both'), profiles: [read, observe] };
    const c = { ...base('c-write'), profiles: [observe, write] };
    const d = { ...base('d-read'), profiles: [read] };
    const e = { ...base('e-none') };
    const raw = at87(a, b, c, d, e);
    migrateTenant(raw, 88);
    expect(stored(raw)).toEqual([{ ...a, readOnly: true }, { ...b, readOnly: true }, c, d, e]);
    raw.close();
  });
});
