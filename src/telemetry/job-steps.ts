// A job step (issue #1486 part 7, design.md "Telemetry: job steps"): work the hopper does for one job outside its events —
// the job's worktree on its machine, a follow of its pull request (the hopper's merge, a person's Merge now or Close PR),
// the base merge, the start of a tend — as a span of the job's trace: a child of its run span, else its pull request
// span, else its root (an ended root too, while the hopper remembers the job). The span active when the step began (a sync, a request, the outbox) is a
// link, so the step's GitHub calls stay in the job's trace and the sync still points to it. A job no trace holds (ended
// and forgotten, telemetry off) gets its step as a child of the active span. The attributes are the job's id, the step
// and its outcome, enums only; an error records only its kind. The duration is a metric, and the telemetry summary keeps
// it with the job spans, telemetry on or off.
import { context, SpanStatusCode, trace, type Attributes, type Link } from '@opentelemetry/api';
import type { FollowUp } from '../domain/types.ts';
import { instrument, tracer } from './instruments.ts';
import { jobStepParent } from './jobs.ts';
import { telemetrySummary } from './summary.ts';

export type JobStep = 'worktree' | 'follow' | 'base_merge' | 'tend';

const stepDuration = instrument((m) => m.createHistogram('hopper.job.step.duration', { unit: 's', description: 'How long each step the hopper did for a job took, by step and outcome.' }));

/** Only an enum goes out: a word of letters, digits, `_` and `-`. */
const enumOf = (v: string): string => (/^[\w-]{1,40}$/.test(v) ? v : 'other');

/** How a follow ended: the pull request merged by the hopper, merged, closed, …; `unchanged`: nothing new was seen. */
export const followOutcome = (r: FollowUp | undefined): string => (!r ? 'unchanged' : r.outcome === 'merged' && r.byHopper ? 'merged_by_hopper' : r.outcome);

/**
 * Runs `run` as the job's step `step`; `outcome` names how it ended (an enum). `attributes`: more enums of the step, as
 * the act of a follow. A throw ends it with outcome `error` and is thrown again.
 */
export async function traceJobStep<T>(jobId: string, step: JobStep, run: () => Promise<T>, outcome: (out: T) => string, attributes: Attributes = {}): Promise<T> {
  const parent = jobStepParent(jobId);
  const active = trace.getActiveSpan()?.spanContext();
  const links: Link[] = parent && active && trace.isSpanContextValid(active) ? [{ context: active }] : [];
  const parentContext = parent ? trace.setSpan(context.active(), parent) : context.active();
  const span = tracer().startSpan(`hopper.job.${step}`, { links, attributes: { 'hopper.job.id': jobId, 'hopper.job.step': step, ...attributes } }, parentContext);
  const from = performance.now();
  let ended = 'error';
  try {
    const out = await context.with(trace.setSpan(parentContext, span), run);
    ended = enumOf(outcome(out));
    return out;
  } catch (e) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', e instanceof Error ? e.name : 'Error');
    throw e;
  } finally {
    span.setAttribute('hopper.job.step.outcome', ended);
    span.end();
    const ms = performance.now() - from;
    stepDuration().record(ms / 1000, { 'hopper.job.step': step, 'hopper.job.step.outcome': ended });
    telemetrySummary.jobSpan(step, ms);
  }
}
