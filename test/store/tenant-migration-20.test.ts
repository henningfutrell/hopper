// Tenant migration 20 (issue #485): a question stored before the raising machine was recorded gets it
// where it can be known — the lane of its `question.asked` event, else its job's `resumeOn`, else its
// job's machine pin — and the name from the machines config while that machine is still in it. A
// question with no source stays without one (the UI says "machine unknown"). Only the field is added;
// nothing else in the body changes, a snapshot already there is kept, and a second run changes nothing.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { raisedByBackfill } from '../../src/store/migration-raised-by.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();

const PLUGINS = {
  version: 1,
  machines: [
    { name: 'desk', plugin: 'ssh', options: { ssh: 'desk', label: 'Desk tower' } },
    { name: 'here', plugin: 'local', options: { lanes: 2 } },
  ],
};

function job(raw: Db, id: string, extra: Record<string, unknown> = {}, pin?: string): void {
  const body = { id, status: 'finished', spec: { executor: 'test', payload: {}, ...(pin ? { machineId: pin } : {}) }, ...extra };
  raw.run('INSERT INTO jobs (id, status, created_at, body) VALUES (?, ?, ?, ?)', id, 'finished', '2026-10-01T00:00:00.000Z', JSON.stringify(body));
}

function question(raw: Db, id: string, jobId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const body = {
    id, jobId, text: `q ${id}`, recentOutput: 'line', detectedBy: 'marker', status: 'answered', tier: 'human',
    attempts: [{ tier: 'human', role: 'human', startedAt: 'x', answer: 'a', outcome: 'accepted' }], answer: 'a', notifyCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra,
  };
  raw.run('INSERT INTO questions (id, job_id, status, created_at, body) VALUES (?, ?, ?, ?, ?)', id, jobId, 'answered', body.createdAt, JSON.stringify(body));
  return body;
}

function asked(raw: Db, questionId: string, jobId: string, laneId: string | null): void {
  raw.run(
    'INSERT INTO events (id, type, at, job_id, lane_id, machine_id, decision_id, data, question_id, schema_version) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1)',
    `e-${questionId}`, 'question.asked', '2026-10-01T00:00:00.000Z', jobId, laneId, JSON.stringify({ questionId, text: 'x', detectedBy: 'marker' }), questionId,
  );
}

const body = (raw: Db, id: string) => JSON.parse(String(raw.get('SELECT body FROM questions WHERE id = ?', id)!.body)) as Record<string, unknown>;

function seeded(): { raw: Db; before: Record<string, Record<string, unknown>> } {
  const raw = t.tenantAt(t.url(), 19);
  raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(PLUGINS));
  const before: Record<string, Record<string, unknown>> = {};
  // The asking lane wins over the job's resumeOn and pin.
  job(raw, 'j1', { resumeOn: 'here' }, 'here');
  before.q1 = question(raw, 'q1', 'j1');
  asked(raw, 'q1', 'j1', 'desk/lane-2');
  // No lane on the event: the job's resumeOn, a machine no longer configured (no name).
  job(raw, 'j2', { resumeOn: 'gone' }, 'desk');
  before.q2 = question(raw, 'q2', 'j2');
  asked(raw, 'q2', 'j2', null);
  // No event, no resumeOn: the pin; a local machine's name is its label option, else its instance name.
  job(raw, 'j3', {}, 'here');
  before.q3 = question(raw, 'q3', 'j3');
  // Nothing to go on.
  job(raw, 'j4');
  before.q4 = question(raw, 'q4', 'j4');
  // Its job is gone too.
  before.q5 = question(raw, 'q5', 'missing');
  // Already recorded: kept as it is.
  job(raw, 'j6', { resumeOn: 'here' });
  before.q6 = question(raw, 'q6', 'j6', { raisedBy: { machineId: 'old', name: 'Old box', laneId: 'old/lane-1' } });
  return { raw, before };
}

describe('tenant migration 20: the raising machine is filled where it can be known', () => {
  it('the asked lane, then resumeOn, then the pin; the name from the machines config; nothing else changes', () => {
    const { raw, before } = seeded();
    migrateTenant(raw, 20);
    expect(body(raw, 'q1')).toEqual({ ...before.q1, raisedBy: { machineId: 'desk', name: 'Desk tower', laneId: 'desk/lane-2' } });
    expect(body(raw, 'q2')).toEqual({ ...before.q2, raisedBy: { machineId: 'gone' } });
    expect(body(raw, 'q3')).toEqual({ ...before.q3, raisedBy: { machineId: 'here', name: 'here' } });
    expect(body(raw, 'q4')).toEqual(before.q4);
    expect(body(raw, 'q5')).toEqual(before.q5);
    expect(body(raw, 'q6')).toEqual(before.q6);
    raw.close();
  });

  it('a second run changes nothing', () => {
    const { raw } = seeded();
    migrateTenant(raw, 20);
    const once = raw.all('SELECT id, body FROM questions ORDER BY id');
    raisedByBackfill(raw);
    expect(raw.all('SELECT id, body FROM questions ORDER BY id')).toEqual(once);
    raw.close();
  });

  it('no plugins config: machines get no name, the id is still filled', () => {
    const raw = t.tenantAt(t.url(), 19);
    job(raw, 'j1', { resumeOn: 'desk' });
    const q = question(raw, 'q1', 'j1');
    migrateTenant(raw, 20);
    expect(body(raw, 'q1')).toEqual({ ...q, raisedBy: { machineId: 'desk' } });
    raw.close();
  });
});
