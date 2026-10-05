// Migration 16 (issue #134): the question path is escalation levels. A stored plugins.yaml's
// `answerer` and `assessor` sections become `escalationLevels`, lowest first, with the meaning they
// had: the answerer, then the assessor, then the owner. A stored question's trail names every model
// attempt a `level`; a draft that went on to the assessor escalated.
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

/** Store `plugins` and `questions` at version 15, migrate, and read them back. */
function migrateFrom15(o: { plugins?: string; questions?: unknown[] }): { plugins: string | undefined; questions: unknown[] } {
  const url = t.url();
  t.at(url, 16).close();
  const raw = openDb(url);
  if (o.plugins !== undefined) raw.run("INSERT INTO config_documents (name, text, updated_at) VALUES ('plugins.yaml', ?, 'x')", o.plugins);
  for (const [i, q] of (o.questions ?? []).entries()) {
    raw.run("INSERT INTO questions (id, job_id, status, created_at, body) VALUES (?, 'j', 'answered', ?, ?)", `q${i}`, `2026-10-0${i + 1}`, JSON.stringify(q));
  }
  raw.run('UPDATE schema_version SET version = 15');
  raw.close();
  t.at(url, 16).close();
  const after = openDb(url);
  const row = after.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'");
  const questions = after.all('SELECT body FROM questions ORDER BY created_at').map((r) => JSON.parse(String(r.body)) as unknown);
  after.close();
  return { plugins: row ? String(row.text) : undefined, questions };
}

const plugins = (text: string) => parse(migrateFrom15({ plugins: text }).plugins!) as Record<string, unknown>;

describe('migration 16: plugins.yaml answerer and assessor → escalationLevels', () => {
  it('the answerer, then the assessor, as levels; options, comments and other sections kept', () => {
    const before = [
      '# my plugins',
      'version: 1',
      'queueSorter: { name: priority, plugin: priority }',
      'answerer: { name: opus, plugin: claude-cli, options: { bin: claude, timeoutMs: 180000, model: opus, effort: high } }',
      'assessor: { name: fable, plugin: claude-cli-assessor, options: { bin: claude, timeoutMs: 180000, model: fable } }',
      'machines: [ { name: local, plugin: local, options: { lanes: 2 } } ]',
      '',
    ].join('\n');
    const after = migrateFrom15({ plugins: before }).plugins!;
    expect(after).toContain('# my plugins');
    expect(parse(after)).toEqual({
      version: 1,
      queueSorter: { name: 'priority', plugin: 'priority' },
      escalationLevels: [
        { name: 'opus', plugin: 'claude-cli', options: { bin: 'claude', timeoutMs: 180000, model: 'opus', effort: 'high' } },
        { name: 'fable', plugin: 'claude-cli', options: { bin: 'claude', timeoutMs: 180000, model: 'fable' } },
      ],
      machines: [{ name: 'local', plugin: 'local', options: { lanes: 2 } }],
    });
  });

  it('no answerer (null): the assessor is the one level', () => {
    expect(plugins('version: 1\nanswerer: null\nassessor: { name: fable, plugin: claude-cli-assessor }\n')).toEqual({
      version: 1, escalationLevels: [{ name: 'fable', plugin: 'claude-cli' }],
    });
  });

  it('a section left out meant the built-in one: it is written in its place', () => {
    expect(plugins('version: 1\nassessor: { name: judge, plugin: claude-cli-assessor, options: { model: sonnet } }\n').escalationLevels).toEqual([
      { name: 'opus', plugin: 'claude-cli', options: { model: 'opus' } },
      { name: 'judge', plugin: 'claude-cli', options: { model: 'sonnet' } },
    ]);
    expect(plugins('version: 1\nanswerer: { name: quick, plugin: claude-cli, options: { model: haiku } }\n').escalationLevels).toEqual([
      { name: 'quick', plugin: 'claude-cli', options: { model: 'haiku' } },
      { name: 'fable', plugin: 'claude-cli', options: { model: 'fable' } },
    ]);
  });

  it('assessor always-escalate meant the owner decides every question: no levels', () => {
    expect(plugins('version: 1\nanswerer: { name: opus, plugin: claude-cli }\nassessor: { name: a, plugin: always-escalate }\n')).toEqual({
      version: 1, escalationLevels: [],
    });
  });

  it('a custom plugin keeps its id (it now loads only if it is an escalation-level plugin)', () => {
    expect(plugins('version: 1\nanswerer: { name: canned, plugin: canned-answer }\nassessor: { name: fable, plugin: claude-cli-assessor }\n').escalationLevels).toEqual([
      { name: 'canned', plugin: 'canned-answer' },
      { name: 'fable', plugin: 'claude-cli' },
    ]);
  });

  it('leaves a plugins.yaml with neither section, one that does not parse, and a store without one as they are', () => {
    const text = 'version: 1\nmachines: [ { name: local, plugin: local } ]\n';
    expect(migrateFrom15({ plugins: text }).plugins).toBe(text);
    expect(migrateFrom15({ plugins: 'version: 1\nanswerer: [\n' }).plugins).toBe('version: 1\nanswerer: [\n');
    expect(migrateFrom15({}).plugins).toBeUndefined();
  });
});

describe('migration 16: a question trail names every model attempt a level', () => {
  it('answerer and assessor attempts are level attempts; a draft passed on escalated; the human stays', () => {
    const q = {
      id: 'q0', tier: 'fable', answeredBy: 'opus', attempts: [
        { tier: 'opus', role: 'answerer', startedAt: 'a', answer: 'use postgres', confident: false, reason: 'unsure', outcome: 'drafted' },
        { tier: 'fable', role: 'assessor', startedAt: 'b', escalate: false, reason: 'fine', riskRules: [], outcome: 'accepted' },
        { tier: 'human', role: 'human', startedAt: 'c', answer: 'x', outcome: 'accepted' },
      ],
    };
    const [after] = migrateFrom15({ questions: [q] }).questions as Array<typeof q>;
    expect(after!.attempts).toEqual([
      { tier: 'opus', role: 'level', startedAt: 'a', answer: 'use postgres', confident: false, escalate: true, reason: 'unsure', outcome: 'escalated' },
      { tier: 'fable', role: 'level', startedAt: 'b', escalate: false, reason: 'fine', riskRules: [], outcome: 'accepted' },
      { tier: 'human', role: 'human', startedAt: 'c', answer: 'x', outcome: 'accepted' },
    ]);
    expect(after).toMatchObject({ id: 'q0', tier: 'fable', answeredBy: 'opus' });
  });

  it('an attempt from before roles: the human\'s is human, every other a level', () => {
    const q = { id: 'q0', attempts: [
      { tier: 'opus', startedAt: 'a', answer: 'a', confident: false, risky: false, outcome: 'escalated' },
      { tier: 'human', startedAt: 'b', answer: 'b', outcome: 'accepted' },
    ] };
    const [after] = migrateFrom15({ questions: [q] }).questions as Array<{ attempts: Array<{ role: string }> }>;
    expect(after!.attempts.map((a) => a.role)).toEqual(['level', 'human']);
  });
});
