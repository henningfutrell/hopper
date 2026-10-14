// Tenant migration 33 (issue #632): the default ladder goes straight to the frontier level. A stored plugins config that
// still holds the old built-in pair — claude-cli on opus, then claude-cli on fable — loses the opus level; an open
// question at it moves to the fable level. Any other set of levels is someone's own choice and stays as it is.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const OLD_PAIR = [
  { name: 'level-1', plugin: 'claude-cli', options: { machine: 'local', bin: 'claude', timeoutMs: 180000, model: 'opus' } },
  { name: 'level-2', plugin: 'claude-cli', options: { machine: 'local', bin: 'claude', timeoutMs: 180000, model: 'fable' } },
];

function at32(levels: unknown[], questions: Array<{ id: string; status: string; tier: string }> = []): Db {
  const raw = t.tenantAt(t.url(), 32);
  raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify({ version: 1, escalationLevels: levels, executors: [] }));
  for (const q of questions) {
    const body = { id: q.id, jobId: 'j', status: q.status, tier: q.tier, attempts: [{ tier: q.tier, role: 'level', outcome: 'escalated' }] };
    raw.run("INSERT INTO questions (id, job_id, status, created_at, body) VALUES (?, 'j', ?, 'x', ?)", q.id, q.status, JSON.stringify(body));
  }
  return raw;
}

const levels = (raw: Db) => (JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as { escalationLevels: unknown[] }).escalationLevels;
const question = (raw: Db, id: string) => JSON.parse(String(raw.get('SELECT body FROM questions WHERE id = ?', id)!.body)) as { tier: string; attempts: Array<{ tier: string }> };

describe('tenant migration 33: the old built-in opus level goes', () => {
  it('the old pair keeps only its fable level; an open question at the opus level moves up, the trail stays', () => {
    const raw = at32(OLD_PAIR, [{ id: 'q1', status: 'open', tier: 'level-1' }, { id: 'q2', status: 'answered', tier: 'level-1' }]);
    migrateTenant(raw, 33);
    expect(levels(raw)).toEqual([OLD_PAIR[1]]);
    expect(question(raw, 'q1')).toMatchObject({ tier: 'level-2', attempts: [{ tier: 'level-1' }] });
    expect(question(raw, 'q2').tier).toBe('level-1');
    raw.close();
  });

  it.each([
    ['a single level', [OLD_PAIR[0]]],
    ['a third level', [...OLD_PAIR, { name: 'level-3', plugin: 'anthropic-api', options: {} }]],
    ['the levels in another order', [OLD_PAIR[1], OLD_PAIR[0]]],
    ['the lower level on another plugin', [{ ...OLD_PAIR[0], plugin: 'anthropic-api' }, OLD_PAIR[1]]],
  ])('%s: kept as it is', (_n, set) => {
    const raw = at32(set);
    migrateTenant(raw, 33);
    expect(levels(raw)).toEqual(set);
    raw.close();
  });
});
