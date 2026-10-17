// How work goes, as metrics (issue #1486, design.md "Telemetry"), read off one user's event log as it appends: the
// assessor's judgement of each failure (its class and decision), retries, a question's escalation to each level, the
// hand-offs to a person, sandbox requests by outcome and how long an approved one took to start its box, and landing
// batches passed and failed. Each attribute is an enum, a level or a status, picked by name: no event text goes out.
import type { DomainEvent } from '../domain/types.ts';
import { instrument } from './instruments.ts';

const assessed = instrument((m) => m.createCounter('hopper.job.assessed', { description: 'Failed jobs the assessor judged, by failure class and decision.' }));
const retries = instrument((m) => m.createCounter('hopper.job.retries', { description: 'Jobs queued again: requeued (by the status it left) or run again (by who).' }));
const escalations = instrument((m) => m.createCounter('hopper.question.escalations', { description: 'Questions escalated, by the level they reached.' }));
const handoffs = instrument((m) => m.createCounter('hopper.handoffs', { description: 'Failed jobs handed off to a person, by reason.' }));
const sandboxes = instrument((m) => m.createCounter('hopper.sandbox.requests', { description: 'Sandbox requests that ended, by outcome.' }));
const spinUp = instrument((m) => m.createHistogram('hopper.sandbox.spin_up.duration', { unit: 's', description: 'From a sandbox request\'s approval to its box started or failed.' }));
const batches = instrument((m) => m.createCounter('hopper.landing_batch.ended', { description: 'Landing batch runs that ended, by outcome.' }));

/** A short word of event data, or `other`: a level's instance name or a status, never text. */
function word(v: unknown): string {
  return typeof v === 'string' && /^[\w.-]{1,40}$/.test(v) ? v : 'other';
}

const SANDBOX_ENDS: Partial<Record<DomainEvent['type'], string>> = {
  'vault.sandbox_started': 'started', 'vault.sandbox_failed': 'failed', 'vault.sandbox_declined': 'declined',
};

export interface RecordOutcomesOptions {
  subscribe(listener: (event: DomainEvent) => void): () => void;
  /** The most approved sandbox requests waiting for their box that are remembered; the oldest past it is forgotten. */
  max?: number;
}

/** Follows one user's event log; the returned function stops it. */
export function recordOutcomes(o: RecordOutcomesOptions): () => void {
  const max = o.max ?? 2000;
  /** Approved sandbox requests, by id: when each was approved. */
  const approved = new Map<string, number>();

  const onEvent = (e: DomainEvent): void => {
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case 'job.assessed':
        assessed().add(1, { 'hopper.failure.class': word(d.class), 'hopper.assessor.decision': word(d.decision), 'hopper.assessor.auto': d.auto === true });
        return;
      case 'job.requeued': retries().add(1, { 'hopper.retry.kind': 'requeued', 'hopper.retry.by': word(d.from) }); return;
      case 'job.rerun': retries().add(1, { 'hopper.retry.kind': 'rerun', 'hopper.retry.by': word(d.by) }); return;
      case 'question.escalated': if (d.renotify !== true) escalations().add(1, { 'hopper.question.target': word(d.target) }); return;
      case 'handoff.opened': handoffs().add(1, { 'hopper.handoff.reason': word(d.reason) }); return;
      case 'landing_batch.promoted': batches().add(1, { 'hopper.landing_batch.outcome': 'promoted' }); return;
      case 'landing_batch.failed': batches().add(1, { 'hopper.landing_batch.outcome': 'failed' }); return;
      case 'vault.sandbox_approved': {
        const id = String(d.request);
        approved.delete(id);
        approved.set(id, Date.parse(e.at));
        while (approved.size > max) approved.delete(approved.keys().next().value!);
        return;
      }
    }
    const outcome = SANDBOX_ENDS[e.type];
    if (!outcome) return;
    sandboxes().add(1, { 'hopper.sandbox.outcome': outcome });
    const id = String(d.request), from = approved.get(id);
    approved.delete(id);
    if (from !== undefined && outcome !== 'declined') spinUp().record(Math.max(0, Date.parse(e.at) - from) / 1000, { 'hopper.sandbox.outcome': outcome });
  };

  return o.subscribe(onEvent);
}
