// Issue #1154: a store call blocks the event loop for as long as it takes. The slow ones are kept, named by their
// statement's verb and table only — never a literal or a parameter —, so the watchdog can say what held the loop.
import { describe, expect, it } from 'vitest';
import { createSlowCalls, statementOf } from '../../src/store/slow-calls.ts';

describe('statementOf', () => {
  it('names a statement by its verb and its first table, never a value', () => {
    expect(statementOf('SELECT * FROM jobs WHERE id = ?')).toBe('SELECT jobs');
    expect(statementOf('  insert into "checkpoints" (job_id, patch) values (?, ?)')).toBe('INSERT checkpoints');
    expect(statementOf('UPDATE jobs SET status = \'running\' WHERE id = ?')).toBe('UPDATE jobs');
    expect(statementOf('DELETE FROM events WHERE seq < ?')).toBe('DELETE events');
    expect(statementOf('WITH x AS (SELECT seq FROM events) SELECT * FROM x')).toBe('WITH events');
    expect(statementOf('BEGIN')).toBe('BEGIN');
    expect(statementOf('SET search_path TO "secret-schema"')).toBe('SET');
  });
});

describe('the slow store calls', () => {
  it('keeps the calls that took at least the slow time, and answers those that ended since a time', () => {
    const slow = createSlowCalls({ slowMs: 100, kept: 3 });
    slow.record(0, 50, 'SELECT jobs');
    slow.record(100, 300, 'SELECT jobs');
    slow.record(400, 900, 'INSERT checkpoints');
    expect(slow.since(0)).toEqual([{ from: 100, to: 300, what: 'SELECT jobs' }, { from: 400, to: 900, what: 'INSERT checkpoints' }]);
    expect(slow.since(500)).toEqual([{ from: 400, to: 900, what: 'INSERT checkpoints' }]);
  });

  it('keeps only the latest ones', () => {
    const slow = createSlowCalls({ slowMs: 1, kept: 2 });
    for (let i = 0; i < 5; i++) slow.record(i * 10, i * 10 + 5, `SELECT t${i}`);
    expect(slow.since(0).map((c) => c.what)).toEqual(['SELECT t3', 'SELECT t4']);
  });

  it('counts every call by its statement, slow or not', () => {
    const slow = createSlowCalls({ slowMs: 100 });
    slow.record(0, 1, 'SELECT jobs');
    slow.record(0, 500, 'SELECT jobs');
    slow.record(0, 1, 'UPDATE jobs');
    expect(slow.count('SELECT jobs')).toBe(2);
    expect(slow.count('UPDATE jobs')).toBe(1);
    expect(slow.count('SELECT settings')).toBe(0);
  });
});
