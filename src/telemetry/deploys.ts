// Deploy spans (issue #1486 part 9, design.md "Telemetry: deploys"): a job's change reaches people through a landing
// batch run (issue #1073): the batch of `main`'s merges is tested, then merged into `dev`, or it fails. A batch run is a
// span `hopper.landing_batch` of its own trace, from `landing_batch.started` to its end; for each job whose pull request
// is in the batch, a span `hopper.job.deploy` in that job's trace (a child of its pull request span, else its root, while
// the hopper remembers the job), with a link to the batch run. Both end with the batch's outcome: `promoted`, `failed`
// or `restarted`. Only ids, numbers and enums go out: the repository's name, the pull request numbers, the outcome.
import { context, trace, type Span } from '@opentelemetry/api';
import type { DomainEvent, Job } from '../domain/types.ts';
import { instrument, tracer } from './instruments.ts';
import { jobStepParent } from './jobs.ts';
import { telemetrySummary } from './summary.ts';

const deployDuration = instrument((m) => m.createHistogram('hopper.landing_batch.duration', { unit: 's', description: 'How long each landing batch run took, from its start to its end, by outcome.' }));

/** A pull request's repository and number, from its URL, else the job's repository and the number. */
function pullRequestOf(data: unknown, job: Job | undefined): string | undefined {
  const pr = (data as { pullRequest?: unknown } | undefined)?.pullRequest;
  if (typeof pr === 'string') {
    const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(pr);
    return m ? `${m[1]}#${m[2]}` : undefined;
  }
  return typeof pr === 'number' && job?.source?.repo ? `${job.source.repo}#${pr}` : undefined;
}

interface Batch { span: Span; from: number; deploys: Span[] }

export interface TraceDeploysOptions {
  subscribe(listener: (event: DomainEvent) => void): () => void;
  job(id: string): Job | undefined;
  /** The most pull requests of jobs remembered; the oldest past it is forgotten. */
  max?: number;
}

/** Follows one user's event log; the returned function stops it and ends every open batch run as `restarted`. */
export function traceDeploys(o: TraceDeploysOptions): () => void {
  const max = o.max ?? 2000;
  /** Each job's pull request, `owner/name#N` → job id. */
  const jobOf = new Map<string, string>();
  const batches = new Map<string, Batch>();

  const end = (key: string, outcome: string, at: number): void => {
    const b = batches.get(key);
    if (!b) return;
    batches.delete(key);
    for (const d of b.deploys) { d.setAttribute('hopper.landing_batch.outcome', outcome); d.end(at); }
    b.span.setAttribute('hopper.landing_batch.outcome', outcome);
    b.span.end(at);
    const ms = Math.max(0, at - b.from);
    deployDuration().record(ms / 1000, { 'hopper.landing_batch.outcome': outcome });
    telemetrySummary.jobSpan('deploy', ms);
  };

  const onEvent = (e: DomainEvent): void => {
    const at = Date.parse(e.at);
    const d = (e.data ?? {}) as { repo?: unknown; pullRequest?: unknown; merges?: unknown };
    if (e.jobId) {
      const pr = pullRequestOf(e.data, o.job(e.jobId));
      if (!pr) return;
      jobOf.delete(pr);
      jobOf.set(pr, e.jobId);
      while (jobOf.size > max) jobOf.delete(jobOf.keys().next().value!);
      return;
    }
    if (typeof d.repo !== 'string') return;
    const key = `${d.repo}#${String(d.pullRequest)}`;
    switch (e.type) {
      case 'landing_batch.started': {
        if (batches.has(key) || typeof d.pullRequest !== 'number') return;
        const merges = Array.isArray(d.merges) ? d.merges.filter((n): n is number => typeof n === 'number') : [];
        const span = tracer().startSpan('hopper.landing_batch', {
          root: true, startTime: at,
          attributes: { 'hopper.repo': d.repo, 'hopper.pull_request.number': d.pullRequest, 'hopper.landing_batch.merges': merges.length },
        });
        const deploys: Span[] = [];
        for (const n of merges) {
          const jobId = jobOf.get(`${d.repo}#${n}`), parent = jobId ? jobStepParent(jobId) : undefined;
          if (!jobId || !parent) continue;
          deploys.push(tracer().startSpan('hopper.job.deploy', {
            startTime: at, links: [{ context: span.spanContext() }],
            attributes: { 'hopper.job.id': jobId, 'hopper.repo': d.repo, 'hopper.pull_request.number': n },
          }, trace.setSpan(context.active(), parent)));
        }
        batches.set(key, { span, from: at, deploys });
        return;
      }
      case 'landing_batch.promoted': end(key, 'promoted', at); return;
      case 'landing_batch.failed': end(key, 'failed', at); return;
      case 'landing_batch.restarted':
        for (const k of [...batches.keys()]) if (k.startsWith(`${d.repo}#`)) end(k, 'restarted', at);
    }
  };

  const unsubscribe = o.subscribe(onEvent);
  return () => {
    unsubscribe();
    const now = Date.now();
    for (const key of [...batches.keys()]) end(key, 'restarted', now);
  };
}
