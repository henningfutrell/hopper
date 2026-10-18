// A poison failure (issue #1961): a failed job whose own data makes the assessment throw. It is handed to a person
// with the reason, in one transaction, as any job-specific failure is, and never assessed again: the sweep goes on
// to the other failures. A poison failure whose hand-off throws too is left, said once; it never blocks the others.
// A store that fails (a StoreError: a lock wait past its time, a dropped connection) is not poison: the job stays
// unassessed and is not left, so the next sweep assesses it.
import type { UserStore } from '../domain/ports.ts';
import type { FailureRecord } from '../domain/types.ts';
import { StoreError } from '../domain/store-error.ts';
import { signatureOf } from './signature.ts';

export interface PoisonDeps {
  store: UserStore;
  now(): Date;
  /** Its job's latest run has a record already. */
  assessedRun(jobId: string): boolean;
  /** Opens the record's hand-off (`Handoffs.afterRecord`). */
  afterRecord(record: FailureRecord): void;
  logger: { warn(line: string): void };
}

const firstLine = (text: string): string => (text.trim().split('\n', 1)[0] ?? '').slice(0, 200).replace(/\.+$/, '');

/** `handOff(jobId, e)`: the job's failure handed to a person, as `e` stopped its assessment; `skips(jobId)`: one left. */
export function createPoison(d: PoisonDeps): { handOff(jobId: string, e: unknown): void; skips(jobId: string): boolean } {
  const left = new Set<string>();
  return {
    skips: (jobId) => left.has(jobId),
    handOff(jobId, e) {
      const message = firstLine(e instanceof Error ? e.message : String(e)) || 'an error with no message';
      if (e instanceof StoreError) {
        d.logger.warn(`hopper: the assessment of job ${jobId} failed in the store: ${message}; the sweep tries again`);
        return;
      }
      d.logger.warn(`hopper: the assessment of job ${jobId} failed: ${message}; it is handed to a person`);
      try {
        d.store.tx(() => {
          const job = d.store.jobs.get(jobId);
          if (!job || job.status !== 'failed' || job.assessment || d.assessedRun(jobId)) return;
          const at = d.now().toISOString();
          const error = typeof job.error === 'string' && job.error !== '' ? job.error : 'failed without a reason';
          const { normalised, signature } = signatureOf(error);
          const reasons = [`the hopper could not assess this failure: ${message}`];
          const summary = `Needs a person. The hopper could not assess this failure: ${message}. Failed: ${firstLine(error)}.`;
          const executor = typeof job.spec?.executor === 'string' ? job.spec.executor : 'unknown';
          const record = d.store.failures.create({
            jobId, at, signature, normalised, cls: 'job', decision: 'person', reasons, summary, auto: true,
            evidence: { error, executor, attempt: 1, sameSignature: 0 }, outcome: 'surfaced', outcomeAt: at,
          });
          d.afterRecord(record);
          d.store.jobs.update(jobId, { assessment: { recordId: record.id, at, class: 'job', decision: 'person', summary, reasons } });
          d.store.events.append({
            type: 'job.assessed', jobId,
            data: { recordId: record.id, signature, class: 'job', decision: 'person', reasons, summary, attempt: 1, auto: true },
          });
        });
      } catch (again) {
        if (again instanceof StoreError) return void d.logger.warn(`hopper: job ${jobId} could not be handed to a person: ${again.message}; the sweep tries again`);
        left.add(jobId);
        d.logger.warn(`hopper: job ${jobId} could not be handed to a person either: ${again instanceof Error ? again.message : String(again)}; the assessor leaves it`);
      }
    },
  };
}
