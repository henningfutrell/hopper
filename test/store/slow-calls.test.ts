// Issue #1154: a store call blocks the event loop for as long as it takes. Every call is totalled by its statement's verb
// and table only — never a literal or a parameter —, so the watchdog can say what held the loop (issue #1383).
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

describe('the store calls', () => {
  // Issue #1383: a stall of many fast calls said "no slow store call in it". Every call counts, so the watchdog can say
  // how much of a stall the store held, however short each call was.
  it('totals every call\'s time by statement, slow or not, and a total read is not changed by later calls', () => {
    const calls = createSlowCalls();
    calls.record(0, 5, 'SELECT jobs');
    calls.record(10, 510, 'SELECT jobs');
    calls.record(0, 2, 'UPDATE jobs');
    const before = calls.totals();
    expect(Object.fromEntries(before)).toEqual({ 'SELECT jobs': { ms: 505, count: 2 }, 'UPDATE jobs': { ms: 2, count: 1 } });
    calls.record(0, 1, 'SELECT jobs');
    expect(before.get('SELECT jobs')).toEqual({ ms: 505, count: 2 });
    expect(calls.totals().get('SELECT jobs')).toEqual({ ms: 506, count: 3 });
  });

  it('counts every call by its statement', () => {
    const calls = createSlowCalls();
    calls.record(0, 1, 'SELECT jobs');
    calls.record(0, 500, 'SELECT jobs');
    calls.record(0, 1, 'UPDATE jobs');
    expect(calls.count('SELECT jobs')).toBe(2);
    expect(calls.count('UPDATE jobs')).toBe(1);
    expect(calls.count('SELECT settings')).toBe(0);
  });
});
