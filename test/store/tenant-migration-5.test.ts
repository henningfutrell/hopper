// Tenant migration 5 (issue #209): an escalation level is named as a level, never after a model. A
// level in the config record `plugins` whose name is a model name (the built-in `opus` and `fable`,
// whatever model they now use) takes the name `level-<its place>`; its plugin and options stay. An
// open question at that level's stage moves to the new name; a question's trail is history and stays.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

function at4(plugins?: unknown, questions: Array<{ id: string; status: string; tier: string }> = []): Db {
  const raw = t.tenantAt(t.url(), 4);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  for (const q of questions) {
    const body = { id: q.id, jobId: 'j', status: q.status, tier: q.tier, attempts: [{ tier: q.tier, role: 'level', model: 'sonnet', outcome: 'escalated' }] };
    raw.run("INSERT INTO questions (id, job_id, status, created_at, body) VALUES (?, 'j', ?, 'x', ?)", q.id, q.status, JSON.stringify(body));
  }
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as Record<string, unknown>;
const question = (raw: Db, id: string) => JSON.parse(String(raw.get('SELECT body FROM questions WHERE id = ?', id)!.body)) as { tier: string; attempts: Array<{ tier: string }> };

describe('tenant migration 5: an escalation level named after a model is named as a level', () => {
  it('each level named after a model takes `level-<place>`, plugin and options kept; other names and sections stay', () => {
    const raw = at4({
      version: 1,
      escalationLevels: [
        { name: 'opus', plugin: 'claude-cli', options: { machine: 'local', model: 'opus' } },
        { name: 'quick', plugin: 'anthropic-api', options: { model: 'haiku' } },
        { name: 'fable', plugin: 'claude-cli', options: { machine: 'local', model: 'sonnet' } },
        { name: 'claude-opus-4-5', plugin: 'claude-cli', options: {} },
      ],
      executors: [{ name: 'opus', plugin: 'test' }],
    });
    migrateTenant(raw, 5);
    expect(plugins(raw)).toEqual({
      version: 1,
      escalationLevels: [
        { name: 'level-1', plugin: 'claude-cli', options: { machine: 'local', model: 'opus' } },
        { name: 'quick', plugin: 'anthropic-api', options: { model: 'haiku' } },
        { name: 'level-3', plugin: 'claude-cli', options: { machine: 'local', model: 'sonnet' } },
        { name: 'level-4', plugin: 'claude-cli', options: {} },
      ],
      executors: [{ name: 'opus', plugin: 'test' }],
    });
    raw.close();
  });

  it('a level named after its own model option is renamed too; a taken name is not reused', () => {
    const raw = at4({
      version: 1,
      escalationLevels: [
        { name: 'level-2', plugin: 'claude-cli', options: { model: 'opus' } },
        { name: 'my-model', plugin: 'anthropic-api', options: { model: 'my-model' } },
      ],
    });
    migrateTenant(raw, 5);
    expect((plugins(raw).escalationLevels as Array<{ name: string }>).map((l) => l.name)).toEqual(['level-2', 'level-2-2']);
    raw.close();
  });

  it('an open question at a renamed level moves to its new name; its trail and closed questions stay', () => {
    const raw = at4(
      { version: 1, escalationLevels: [{ name: 'opus', plugin: 'claude-cli' }, { name: 'fable', plugin: 'claude-cli', options: { model: 'sonnet' } }] },
      [{ id: 'q1', status: 'open', tier: 'fable' }, { id: 'q2', status: 'answered', tier: 'fable' }, { id: 'q3', status: 'open', tier: 'human' }],
    );
    migrateTenant(raw, 5);
    expect(question(raw, 'q1').tier).toBe('level-2');
    expect(question(raw, 'q1').attempts[0]!.tier).toBe('fable');
    expect(question(raw, 'q2').tier).toBe('fable');
    expect(question(raw, 'q3').tier).toBe('human');
    raw.close();
  });

  it('no plugins record, or no escalationLevels section: nothing changes', () => {
    const none = at4();
    migrateTenant(none, 5);
    expect(none.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    none.close();
    const raw = at4({ version: 1, notifiers: [] });
    migrateTenant(raw, 5);
    expect(plugins(raw)).toEqual({ version: 1, notifiers: [] });
    raw.close();
  });
});
