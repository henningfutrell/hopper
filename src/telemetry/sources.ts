// The GitHub outbox and the sync as telemetry (issue #1486 part 5, design.md "Telemetry: the outbox and the sync"). Each
// outbox flush and each sync is a root span of its own trace, linked to the action that asked for it — the span active
// when it was asked for, the request of a person's act —, so a sync's work is never a child of a request that answered
// long before. The GitHub calls it makes, conditional reads included, are its children. A sync is never linked to the
// sync before it: that one only set its timer. The outbox's batches are metrics: the rows due, the calls sent by result,
// and the rows that needed no call of their own. The attributes are the source's name, counts and enums only.
import { context, ROOT_CONTEXT, SpanStatusCode, trace, type Link, type Span } from '@opentelemetry/api';
import { instrument, tracer } from './instruments.ts';

/** The action that asked for a flush or a sync: the span active when it asked. */
export type Cause = Link;

const syncDuration = instrument((m) => m.createHistogram('hopper.source.sync.duration', { unit: 's', description: 'How long each sync of a job source took, by outcome.' }));
const batchSize = instrument((m) => m.createHistogram('hopper.outbox.batch.size', { description: 'The GitHub outbox rows due in each batch it sent.' }));
const outboxCalls = instrument((m) => m.createCounter('hopper.outbox.calls', { description: 'GitHub calls the outbox made, by result.' }));
const coalesced = instrument((m) => m.createCounter('hopper.outbox.rows.coalesced', { description: 'Outbox rows sent with no call of their own: coalesced or cancelled.' }));

/** Our own sync spans: a sync asked for while one runs (its timer, the sync after a merge) is not caused by it. */
const syncSpans = new WeakSet<Span>();

/** The span active now, as the cause of what it asks for; none when no span is active, or it is a sync. */
export function causeNow(): Cause | undefined {
  const span = trace.getActiveSpan();
  if (!span || syncSpans.has(span)) return undefined;
  const ctx = span.spanContext();
  return trace.isSpanContextValid(ctx) ? { context: ctx } : undefined;
}

function rootSpan(name: string, source: string, causes: readonly Cause[]): Span {
  return tracer().startSpan(name, { root: true, links: [...causes], attributes: { 'hopper.job.source': source } });
}

/** One outbox flush of `source`, a root span linked to `causes`; `run`'s GitHub calls are its children. */
export async function traceOutboxFlush<T extends { due: number }>(source: string, causes: readonly Cause[], run: () => Promise<T>): Promise<T> {
  const span = rootSpan('hopper.outbox.flush', source, causes);
  try {
    const out = await context.with(trace.setSpan(ROOT_CONTEXT, span), run);
    span.setAttribute('hopper.outbox.due', out.due);
    return out;
  } catch (e) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', e instanceof Error ? e.name : 'Error');
    throw e;
  } finally {
    span.end();
  }
}

/** One sync of `source`, a root span linked to `causes`; `run`'s GitHub calls are its children. `run` answers whether it went through. */
export async function traceSync(source: string, asked: boolean, causes: readonly Cause[], run: () => Promise<boolean>): Promise<void> {
  const span = rootSpan('hopper.source.sync', source, causes);
  syncSpans.add(span);
  span.setAttribute('hopper.sync.asked', asked);
  const from = performance.now();
  let outcome = 'error';
  try {
    outcome = (await context.with(trace.setSpan(ROOT_CONTEXT, span), run)) ? 'ok' : 'error';
  } finally {
    span.setAttribute('hopper.sync.outcome', outcome);
    if (outcome !== 'ok') span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    syncDuration().record((performance.now() - from) / 1000, { 'hopper.job.source': source, 'hopper.sync.outcome': outcome });
  }
}

/** A batch the outbox sends: `due` rows in `calls` calls. The rows over the calls needed none of their own. */
export function outboxBatch(due: number, calls: number): void {
  if (due === 0) return;
  batchSize().record(due);
  if (due > calls) coalesced().add(due - calls);
  trace.getActiveSpan()?.setAttribute('hopper.outbox.calls', calls);
}

/** One call the outbox made, sent or failed. */
export function outboxCall(result: 'sent' | 'failed'): void {
  outboxCalls().add(1, { 'hopper.outbox.result': result });
}
