// Tenant migration 71 (issue #1349): a sandbox does one step and is burned, so no box reads a template's time limit or
// whether it keeps its home. Each stored template loses `ttlMinutes` and `keepHome` from its limits; its CPUs and memory
// stay, and a template with no limits left has none.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at70(...templates: Record<string, unknown>[]): Db {
  const raw = t.tenantAt(t.url(), 70);
  for (const tp of templates) raw.run('INSERT INTO templates (name, body) VALUES (?, ?)', tp.name, JSON.stringify(tp));
  return raw;
}

const stored = (raw: Db) => raw.all('SELECT body FROM templates ORDER BY name').map((r) => JSON.parse(String(r.body)) as Record<string, unknown>);
const base = (name: string) => ({ name, image: 'img', secrets: ['KUBE'], savedBy: 'Ada', savedAt: '2026-10-11T10:00:00Z' });

describe('tenant migration 71: no time limit or kept home on a template', () => {
  it('drops ttlMinutes and keepHome; CPUs and memory stay, and limits with nothing left go', () => {
    const kube = { ...base('kube'), limits: { cpus: { default: 2, max: 4 }, memoryMb: { default: 2048, max: 4096 }, ttlMinutes: { default: 60, max: 240 }, keepHome: false } };
    const only = { ...base('only'), limits: { ttlMinutes: { max: 30 }, keepHome: true } };
    const plain = { ...base('plain'), tools: ['helm'] };
    const raw = at70(kube, only, plain);
    migrateTenant(raw, 71);
    expect(stored(raw)).toEqual([
      { ...base('kube'), limits: { cpus: { default: 2, max: 4 }, memoryMb: { default: 2048, max: 4096 } } },
      base('only'),
      plain,
    ]);
    raw.close();
  });
});
