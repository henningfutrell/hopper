// Migration 31 (issue #581): a recorded access decision names its requester — a job, a machine or a user — where the
// decisions of #559 named only a job. Each one recorded before names its job as the requester; a trial stays a trial.
import { describe, expect, it } from 'vitest';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();
const ASSET = { kind: 'cluster', name: 'x' };

describe('migration 31: an access decision names its requester', () => {
  it('a decision for a job names the job as its requester; a trial is left as it was', () => {
    const url = t.url();
    const raw = t.at(url, 30);
    const job = { id: 'd1', at: '2026-10-09T10:00:00.000Z', allowed: true, reason: 'ok', job: { userId: 'admin', jobId: 'j1' }, template: 'kube', operation: 'read', asset: ASSET };
    const trial = { id: 'd2', at: '2026-10-09T10:01:00.000Z', allowed: false, reason: 'no', trial: { by: 'admin' }, template: 'kube', operation: 'write', asset: ASSET };
    for (const d of [job, trial]) raw.run('INSERT INTO access_decisions (id, at, body) VALUES (?, ?, ?)', d.id, d.at, JSON.stringify(d));
    raw.close();

    const instance = openInstanceStore({ url, clock: fixedClock() });
    const after = instance.access.decisions(10);
    instance.close();
    const { job: _job, ...rest } = job;
    expect(after).toEqual([trial, { ...rest, requester: { kind: 'job', userId: 'admin', jobId: 'j1' } }]);
  });
});
