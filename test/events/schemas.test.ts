import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMA_VERSIONS, EVENT_TYPES, type DomainEvent, type EventType } from '../../src/domain/types.ts';
import { ENVELOPE_SCHEMA, EVENT_SCHEMAS, LEGACY_EVENT_SCHEMAS, exportJsonSchemas, validateEvent } from '../../src/events/index.ts';
import { INVALID_DATA, VALID_DATA } from './samples.ts';

const APP = join(import.meta.dirname, '..', '..');

function event(type: EventType, data: Record<string, unknown>, over: Partial<DomainEvent> = {}): DomainEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSIONS[type], seq: 1, id: '6f1c0e0e-2d0b-4f7e-9a53-0d9d3a1b2c3d', type,
    at: '2026-10-02T00:00:00.000Z', data, ...over,
  };
}

describe('event schemas', () => {
  it('every event type has a schema and a version', () => {
    for (const t of EVENT_TYPES) {
      expect(EVENT_SCHEMAS[t], t).toBeDefined();
      expect(EVENT_SCHEMA_VERSIONS[t], t).toBeGreaterThanOrEqual(1);
      expect(VALID_DATA[t], `sample for ${t}`).toBeDefined();
    }
    expect(Object.keys(EVENT_SCHEMAS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it.each(EVENT_TYPES)('%s: valid sample passes', (t) => {
    expect(validateEvent(event(t, VALID_DATA[t]!))).toEqual({ ok: true });
  });

  it.each(EVENT_TYPES)('%s: unknown key in data fails (strict)', (t) => {
    const r = validateEvent(event(t, { ...VALID_DATA[t]!, undeclared: 1 }));
    expect(r.ok).toBe(false);
  });

  it.each(EVENT_TYPES.filter((t) => INVALID_DATA[t]))('%s: invalid sample fails', (t) => {
    const r = validateEvent(event(t, INVALID_DATA[t]!));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
  });

  it('envelope: optional subject ids pass, bad ones fail', () => {
    const ok = event('job.held', { reason: 'r' }, { jobId: 'j', laneId: 'l', machineId: 'm', decisionId: 'd', questionId: 'q' });
    expect(validateEvent(ok)).toEqual({ ok: true });
    expect(ENVELOPE_SCHEMA.safeParse({ ...ok, id: 'not-a-uuid' }).success).toBe(false);
    expect(validateEvent(event('job.held', { reason: 'r' }, { at: 'yesterday' })).ok).toBe(false);
    expect(validateEvent(event('job.held', { reason: 'r' }, { jobId: 5 as unknown as string })).ok).toBe(false);
  });

  it('envelope: schemaVersion must equal the type version', () => {
    const r = validateEvent(event('job.held', { reason: 'r' }, { schemaVersion: 2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toMatch(/schemaVersion/);
  });

  it('unknown type fails', () => {
    expect(validateEvent({ ...event('job.held', { reason: 'r' }), type: 'job.nope' as EventType }).ok).toBe(false);
  });

  it('job.progressed accepts message undefined (in-memory emitters)', () => {
    expect(validateEvent(event('job.progressed', { progress: 1, message: undefined })).ok).toBe(true);
  });
});

describe('superseded payload versions (stored events are never rewritten)', () => {
  const v1Advice = { action: 'proceed_full', reason: 'ok', jevUsed: true, details: {}, source: 'fake', at: '2026-10-02T00:00:00.000Z' };
  const old = (type: string, data: Record<string, unknown>) => ({ ...event('job.held', data), type: type as EventType, schemaVersion: 1 });

  it('the renamed router payloads are v2 and router.mode_changed is v1', () => {
    expect(EVENT_SCHEMA_VERSIONS['job.prioritized']).toBe(2);
    expect(EVENT_SCHEMA_VERSIONS['decision.made']).toBe(2);
    expect(EVENT_SCHEMA_VERSIONS['router.mode_changed']).toBe(1);
    expect(EVENT_TYPES).not.toContain('jev.mode_changed');
    expect(Object.keys(LEGACY_EVENT_SCHEMAS).sort()).toEqual(['decision.made.v1', 'jev.mode_changed.v1', 'job.prioritized.v1']);
  });

  it('a stored v1 job.prioritized, decision.made and jev.mode_changed validate against their v1 schemas', () => {
    expect(validateEvent(old('job.prioritized', { advice: v1Advice, mode: 'shadow', statusAtAdvice: 'queued' }))).toEqual({ ok: true });
    expect(validateEvent(old('decision.made', {
      decisionId: 'd', trigger: 't', jevMode: 'active', starts: [], holds: [], lanes: [],
      divergences: [{ jobId: 'j', advice: 'ask_human', native: 'start', withJev: 'hold', note: 'n' }],
    }))).toEqual({ ok: true });
    expect(validateEvent(old('jev.mode_changed', { from: 'shadow', to: 'active' }))).toEqual({ ok: true });
  });

  it('a v1 payload under the current version, or a v2 payload under v1, fails', () => {
    expect(validateEvent({ ...old('job.prioritized', { advice: v1Advice, mode: 'shadow', statusAtAdvice: 'queued' }), schemaVersion: 2 }).ok).toBe(false);
    expect(validateEvent(old('job.prioritized', { advice: { ...v1Advice, jevUsed: undefined }, mode: 'shadow', statusAtAdvice: 'queued' })).ok).toBe(false);
    expect(validateEvent({ ...old('jev.mode_changed', { from: 'shadow', to: 'active' }), schemaVersion: 2 }).ok).toBe(false);
  });
});

describe('exported JSON Schema', () => {
  const fresh = exportJsonSchemas();

  it('has the envelope and one file per type at its version', () => {
    const want = [
      'envelope.v1.json', ...EVENT_TYPES.map((t) => `${t}.v${EVENT_SCHEMA_VERSIONS[t]}.json`),
      ...Object.keys(LEGACY_EVENT_SCHEMAS).map((k) => `${k}.json`),
    ];
    expect(Object.keys(fresh).sort()).toEqual(want.sort());
  });

  it('committed docs/schemas files equal a fresh export (run `npm run schemas`)', () => {
    for (const [name, schema] of Object.entries(fresh)) {
      const file = join(APP, 'docs', 'schemas', name);
      expect(existsSync(file), name).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8')), name).toEqual(JSON.parse(JSON.stringify(schema)));
    }
  });

  it('docs/events.md mentions every type and the pre-phase-3 note', () => {
    const md = readFileSync(join(APP, 'docs', 'events.md'), 'utf8');
    for (const t of EVENT_TYPES) expect(md, t).toContain(`\`${t}\``);
    expect(md).toMatch(/before phase 3/i);
  });
});
