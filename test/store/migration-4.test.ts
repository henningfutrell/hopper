// Migration 4 (Jev → router renames) against a store written by job-hopper 005762d — the last
// pre-plugin release — through its own repositories: test/store/fixtures/pre-plugins.sqlite
// (schema v3; jobs with jevAdvice from jev-router, fake and fallback, a held job, an
// unclassified one, settings.jevMode = active, a decision with Jev divergences, and v1 events).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { validateEvent } from '../../src/events/index.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const FIXTURE = join(import.meta.dirname, 'fixtures', 'pre-plugins.sqlite');
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function copyFixture(): string {
  const path = t.path();
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(FIXTURE, path);
  return path;
}

function rawJobs(path: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path);
  const rows = db.prepare('SELECT body FROM jobs ORDER BY seq').all().map((r) => JSON.parse(r.body as string) as Record<string, unknown>);
  db.close();
  return rows;
}

describe('migration 4 (router renames) on a pre-plugin store', () => {
  it('the fixture is a v3 store with Jev-named rows', () => {
    const path = copyFixture();
    const db = new DatabaseSync(path);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
    expect(db.prepare('SELECT key, value FROM settings').all().map((r) => ({ ...r }))).toEqual([{ key: 'jevMode', value: 'active' }]);
    db.close();
    expect(rawJobs(path).filter((j) => 'jevAdvice' in j)).toHaveLength(3);
  });

  it('renames jevAdvice → advice and jevUsed → details.jevUsed on every job, losing nothing', () => {
    const path = copyFixture();
    const before = rawJobs(path);
    const s = t.open(path);
    const jobs = [1, 2, 3, 4].map((n) => s.jobs.get(id(n))!);
    expect(jobs[0]!.advice).toEqual({
      action: 'proceed_full', reason: 'because proceed_full', details: { intent: 'build', jevUsed: false },
      source: 'jev-router', at: '2026-10-03T09:00:00.000Z',
    });
    expect(jobs[1]!.advice).toEqual({
      action: 'ask_human', reason: 'because ask_human', details: { jevUsed: true }, source: 'fake', at: '2026-10-03T09:00:00.000Z',
    });
    expect(jobs[2]!.advice).toMatchObject({ action: 'chat_only', source: 'fallback', details: { jevUsed: false } });
    expect(jobs[3]!.advice).toBeUndefined();
    for (const [i, j] of jobs.entries()) {
      expect(j).not.toHaveProperty('jevAdvice');
      // Every other field is the row as it was.
      const { jevAdvice: _gone, ...rest } = before[i] as Record<string, unknown>;
      const { advice: _new, ...after } = j as unknown as Record<string, unknown>;
      expect(after).toEqual(rest);
    }
    expect(jobs[0]!.source).toEqual({ source: 'github', kind: 'github', key: 'https://github.com/o/r/issues/1' });
    expect(jobs[1]).toMatchObject({ status: 'held', holdReason: 'jev ask_human: awaiting approval' });
    s.close();
  });

  it('settings.jevMode → routerMode, value kept', () => {
    const s = t.open(copyFixture());
    expect(s.settings.getRouterMode()).toBe('active');
    s.close();
  });

  it('decisions: jevMode → routerMode, jev[] → advice[] with withAdvice, inputs and policy renamed', () => {
    const s = t.open(copyFixture());
    const d = s.decisions.get('decision-1')!;
    expect(d).not.toHaveProperty('jev');
    expect(d).not.toHaveProperty('jevMode');
    expect(d.routerMode).toBe('active');
    expect(d.advice).toEqual([
      { jobId: id(2), advice: 'ask_human', native: 'start', withAdvice: 'hold', note: 'jev ask_human: awaiting approval' },
      { jobId: id(3), advice: 'chat_only', native: 'start', withAdvice: 'start', note: 'jev chat_only: priority +10' },
    ]);
    expect(d.inputs).not.toHaveProperty('jevMode');
    expect(d.inputs.routerMode).toBe('active');
    expect(d.inputs.policy).toEqual({ softLimit: 0.7, hardLimit: 0.95, routerCheapBoost: 10, laneIdleGraceMs: 5000, resumeBoost: 20 });
    expect(d.inputs.waiting.map((j) => j.advice?.action)).toEqual(['ask_human', 'chat_only', undefined]);
    expect(d.inputs.waiting.every((j) => !('jevAdvice' in j))).toBe(true);
    expect(d.start.map((x) => x.jobId)).toEqual([id(3)]);
    expect(d.reasons).toHaveLength(4);
    s.close();
  });

  it('stored events are not rewritten, and still validate against their own (v1) schemas', () => {
    const s = t.open(copyFixture());
    const events = s.events.since(0);
    expect(events.map((e) => [e.type, e.schemaVersion])).toEqual([['job.prioritized', 1], ['jev.mode_changed', 1], ['decision.made', 1]]);
    expect(events[0]!.data).toMatchObject({ advice: { jevUsed: false } });
    expect(events[2]!.data).toMatchObject({ jevMode: 'active', divergences: [{ withJev: 'hold' }, { withJev: 'start' }] });
    for (const e of events) expect(validateEvent(e), e.type).toEqual({ ok: true });
    s.close();
  });

  it('records user_version 4; reopening does not migrate twice', () => {
    const path = copyFixture();
    t.open(path).close();
    const s = t.open(path);
    expect(s.jobs.get(id(1))!.advice!.details).toEqual({ intent: 'build', jevUsed: false });
    s.close();
    const db = new DatabaseSync(path);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 });
    db.close();
  });
});
