// The schema-drift check (issue #1958) on its own: it names the event kind or the field the fake prints and the real
// CLI does not.
import { describe, expect, it } from 'vitest';
import { driftOf, kindOf, pathsOf } from './event-drift.ts';

const lines = (...events: object[]): string => events.map((e) => JSON.stringify(e)).join('\n');

describe('the schema-drift check', () => {
  it('a kind is the type with its item\'s or part\'s type', () => {
    expect(kindOf({ type: 'item.completed', item: { type: 'agent_message' } })).toBe('item.completed/agent_message');
    expect(kindOf({ type: 'text', part: { type: 'text' } })).toBe('text/text');
    expect(kindOf({ result: 'x' })).toBe('(no type)');
  });

  it('a path names each field, with [] for an array\'s elements', () => {
    expect(pathsOf({ a: { b: 1 }, m: [{ c: 1 }, { d: [{ e: 1 }] }] })).toEqual(['a', 'a.b', 'm', 'm[].c', 'm[].d', 'm[].d[].e']);
  });

  it('no drift when the fake prints a part of what the real CLI prints', () => {
    const real = lines({ type: 'thread.started', thread_id: 't' }, { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'x' } });
    const fake = lines({ type: 'item.completed', item: { type: 'agent_message', text: 'x' } });
    expect(driftOf(fake, real)).toEqual([]);
  });

  it('names a field the real CLI no longer prints', () => {
    const real = lines({ type: 'item.completed', item: { type: 'agent_message', message: 'x' } });
    const fake = lines({ type: 'item.completed', item: { type: 'agent_message', text: 'x' } });
    expect(driftOf(fake, real)).toEqual(['event item.completed/agent_message: field item.text is not in the real CLI\'s']);
  });

  it('names an event kind the real CLI does not print', () => {
    expect(driftOf(lines({ type: 'turn.done' }), lines({ type: 'turn.completed' }))).toEqual(['event turn.done: the real CLI prints none']);
  });

  it('reads one result over several lines, as a CLI that prints one JSON result', () => {
    const real = JSON.stringify({ type: 'result', result: 'x', session_id: 's' }, null, 2);
    expect(driftOf(JSON.stringify({ type: 'result', result: 'x', is_error: false }), real)).toEqual(['event result: field is_error is not in the real CLI\'s']);
  });
});
