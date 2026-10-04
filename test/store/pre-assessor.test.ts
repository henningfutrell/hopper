// Slice 2 (answerer + assessor) changes no question row: `tier` and `answeredBy` widen from
// opus | fable | human to instance names, `risky` leaves the answerer contract but stays on stored
// attempts. A store written by job-hopper 7d9d4e0 — the last release before the assessor —
// through its own repositories (test/store/fixtures/pre-assessor.sqlite: open questions at opus,
// fable and human, one answered by fable, and v1 question events) must read and validate as is.
import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { validateEvent } from '../../src/events/index.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const FIXTURE = join(import.meta.dirname, 'fixtures', 'pre-assessor.sqlite');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function copyFixture(): string {
  const path = t.path();
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(FIXTURE, path);
  return path;
}

describe('a store written before the assessor', () => {
  it('the fixture is a v4 store with questions at opus, fable and human', () => {
    const db = new DatabaseSync(copyFixture());
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 });
    const tiers = db.prepare("SELECT json_extract(body, '$.tier') AS tier, status FROM questions ORDER BY seq").all().map((r) => [r.tier, r.status]);
    expect(tiers).toEqual([['opus', 'open'], ['fable', 'open'], ['human', 'open'], ['fable', 'answered']]);
    db.close();
  });

  it('questions read unchanged: old tiers, attempts with risky, answeredBy fable', () => {
    const s = t.open(copyFixture());
    expect(s.questions.list({ status: ['open'] }).map((q) => q.tier).sort()).toEqual(['fable', 'human', 'opus']);
    const human = s.questions.get(id(11))!;
    expect(human.attempts.map((a) => [a.tier, a.risky, a.outcome])).toEqual([['opus', false, 'escalated'], ['fable', true, 'escalated']]);
    expect(human.attempts.every((a) => a.role === undefined)).toBe(true);
    expect(s.questions.get(id(16))).toMatchObject({ status: 'answered', answeredBy: 'fable', answer: 'red' });
    s.close();
  });

  it('its v1 question events validate against their own version', () => {
    const s = t.open(copyFixture());
    const events = s.events.since(0);
    expect(events.map((e) => [e.type, e.schemaVersion])).toContainEqual(['question.escalated', 1]);
    expect(events.map((e) => [e.type, e.schemaVersion])).toContainEqual(['question.answered', 1]);
    for (const e of events) expect(validateEvent(e), `#${e.seq} ${e.type}`).toEqual({ ok: true });
    s.close();
  });

  it('opening it writes nothing: no migration for slice 2', () => {
    const path = copyFixture();
    t.open(path).close();
    const db = new DatabaseSync(path);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION });
    db.close();
  });
});
