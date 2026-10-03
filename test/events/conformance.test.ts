import { describe, expect, it } from 'vitest';
import type { DomainEvent, EventType } from '../../src/domain/types.ts';
import { EVENT_SCHEMA_VERSIONS } from '../../src/domain/types.ts';
import { assertAllConform, trackConformance } from '../support/conformance.ts';

function fakeLog() {
  const listeners = new Set<(e: DomainEvent) => void>();
  return {
    events: { subscribe(l: (e: DomainEvent) => void) { listeners.add(l); return () => listeners.delete(l); } },
    emit(type: EventType, data: Record<string, unknown>) {
      const e: DomainEvent = { schemaVersion: EVENT_SCHEMA_VERSIONS[type], seq: 1, id: crypto.randomUUID(), type, at: new Date().toISOString(), data };
      for (const l of listeners) l(e);
    },
    listeners,
  };
}

describe('conformance helper', () => {
  it('passes when every event conforms', () => {
    const log = fakeLog();
    const t = trackConformance(log);
    log.emit('job.held', { reason: 'r' });
    expect(() => assertAllConform(t)).not.toThrow();
  });

  it('throws listing the issues of a nonconforming event, and stops listening on stop()', () => {
    const log = fakeLog();
    const t = trackConformance(log);
    log.emit('job.held', { why: 'r' });
    expect(() => assertAllConform(t)).toThrow(/job\.held/);
    t.stop();
    expect(log.listeners.size).toBe(0);
  });
});
