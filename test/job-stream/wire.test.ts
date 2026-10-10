// Issue #613: a stream event goes out whole when it is small, else as a pointer to the result; one builder decides,
// so the event and the result fetched are one object. Each emitter registers the types it emits, under its own name.
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../../src/domain/job-stream.ts';
import { createStreamTypes, RESULT_PATH, resultOf, sseFrame, wireEvent } from '../../src/job-stream/index.ts';

const event = (payload: unknown): StreamEvent => ({ seq: 7, type: 'skill.loaded', request: 'r1', phase: 'done', at: '2026-10-09T00:00:00.000Z', payload });

describe('the wire form of a stream event', () => {
  it('a small event carries its payload inline: the result fetched is the same object, in the same bytes', () => {
    const e = event('kube-diagnostics: a read-only link.\n');
    const wire = wireEvent(e, 4096);
    expect(wire).toEqual(e);
    expect(JSON.stringify(wire)).toBe(resultOf(e));
  });

  it('a large event is a pointer to its result: the fetch gives the object the event describes, its size said', () => {
    const e = event('x'.repeat(5000));
    const wire = wireEvent(e, 4096);
    expect(wire).toEqual({ seq: 7, type: 'skill.loaded', request: 'r1', phase: 'done', at: e.at, ref: { url: `${RESULT_PATH}/7`, bytes: Buffer.byteLength(resultOf(e)) } });
    expect(JSON.parse(resultOf(e))).toEqual(e);
  });

  it('the payload is the last field, so a shell reader finds it at the end of the line', () => {
    expect(JSON.stringify(wireEvent(event('a "quoted"\nline'), 4096))).toMatch(/,"payload":"a \\"quoted\\"\\nline"}$/);
  });

  it('an SSE frame: the seq as its id, the type as its event, the wire form as its data', () => {
    expect(sseFrame(event('ok'), 4096)).toBe(`id: 7\nevent: skill.loaded\ndata: ${JSON.stringify(event('ok'))}\n\n`);
  });
});

describe('the stream types', () => {
  it('each emitter registers the types it emits, each with its phase', () => {
    const types = createStreamTypes();
    types.register('skill', { 'skill.waiting': 'waiting', 'skill.loaded': 'done' });
    expect(types.phaseOf('skill.loaded')).toBe('done');
    expect(types.phaseOf('skill.waiting')).toBe('waiting');
    expect(types.phaseOf('skill.nothing')).toBeUndefined();
  });

  it('a type outside the emitter\'s own name, one registered twice, or an unknown phase is refused', () => {
    const types = createStreamTypes();
    types.register('skill', { 'skill.loaded': 'done' });
    expect(() => types.register('vault', { 'skill.given': 'done' })).toThrow(/vault\./);
    expect(() => types.register('skill', { 'skill.loaded': 'done' })).toThrow(/already/);
    expect(() => types.register('kube', { 'kube.tick': 'ticking' as never })).toThrow(/phase/);
  });
});
