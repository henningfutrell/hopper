// A failed end the hopper fixes itself (issue #1230): reported once assessed, as one it fixes while its Continue is pending,
// and told again, as failed, once a person has it.
import { describe, expect, it } from 'vitest';
import type { DomainEvent, FailureRecord, Job } from '../../src/domain/types.ts';
import { createFixingReports } from '../../src/sources/fixing-reports.ts';
import type { SyncFlags } from '../../src/sources/sync-signals.ts';

const RED = 'not complete: the issue https://github.com/o/r/issues/1 is open, and PR #7: checks failed: test';
const job = (over: Partial<Job> = {}): Job => ({ id: 'j1', status: 'failed', error: RED, ...over }) as Job;

function reports(o: { pending?: FailureRecord['pending']; flags?: SyncFlags; jobs?: Job[] } = {}) {
  const again: string[] = [];
  const records = new Map([['f1', { id: 'f1', ...(o.pending ? { pending: o.pending } : {}) } as FailureRecord]]);
  const r = createFixingReports({
    store: { jobs: { get: (id: string) => (o.jobs ?? []).find((j) => j.id === id) }, failures: { get: (id: string) => records.get(id) } } as never,
    flagsOf: () => o.flags ?? {}, reportAgain: (id) => { again.push(id); },
  });
  return { r, again };
}

describe('fixing reports (issue #1230)', () => {
  const assessed = { recordId: 'f1', at: '', class: 'transient', decision: 'continue', summary: '', reasons: [] } as NonNullable<Job['assessment']>;

  it('a red-checks failure waits on its assessment; any other failure does not', () => {
    const { r } = reports();
    expect(r.waits(job())).toBe(true);
    expect(r.waits(job({ assessment: assessed }))).toBe(false);
    expect(r.waits(job({ error: 'not complete: the issue is open, and no pull request in o/r closes or references it' }))).toBe(false);
  });

  it('fixing while its Continue is pending; not once it is made, refused or never was', () => {
    expect(reports({ pending: 'continue' }).r.fixing(job({ assessment: assessed }))).toBe(true);
    expect(reports().r.fixing(job({ assessment: assessed }))).toBe(false);
    expect(reports({ pending: 'continue' }).r.fixing(job({ status: 'finished', assessment: assessed }))).toBe(false);
  });

  it('a hand-off opened for a failure told as fixing: told again; any other event or job: not', async () => {
    const opened = { type: 'handoff.opened', jobId: 'j1', data: {} } as unknown as DomainEvent;
    const told = reports({ flags: { finalReported: true, fixingReported: true }, jobs: [job()] });
    expect(told.r.follows(opened)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(told.again).toEqual(['j1']);
    const plain = reports({ flags: { finalReported: true }, jobs: [job()] });
    expect(plain.r.follows(opened)).toBe(false);
    expect(plain.r.follows({ ...opened, type: 'job.failed' } as DomainEvent)).toBe(false);
  });
});
