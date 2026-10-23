// Delivery history (issue #2554 part 2, design.md "Delivery forecasts"): each job's way through the delivery steps, read
// from its events, and the measured durations of each step per repository. A step's start and end are events:
// `queued` from `job.queued` to the first `job.started`; `coding` to the first `job.finished`; `pr_checks` to
// `job.pull_request_merged` (the checks and the wait for the merge: no event ends a pull request's checks); `landing` is
// the merge itself, so it takes no time; `landing_checks` from the merge to the `landing_batch.promoted` of the first
// batch run that carried the pull request (`landing_batch.started`'s `merges`). The scheduled steps after it are the
// promotion sets'. Pure.
import { DELIVERY_STEPS, type DeliveryStep } from './delivery-steps.ts';
import type { StepActual } from './forecast-accuracy.ts';
import type { DomainEvent } from './types.ts';

/** The events a delivery track is read from. */
export const TRACK_EVENTS = [
  'job.queued', 'job.started', 'job.finished', 'job.pull_request_followed', 'job.pull_request_merged', 'github_proxy.done',
  'landing_batch.started', 'landing_batch.promoted',
] as const;

/** One job's way so far: its repository, its pull request, each step it started or ended, and the step it is in. */
export interface DeliveryTrack {
  jobId: string;
  repo?: string;
  /** owner/name#n of the job's issue. */
  issue?: string;
  pullRequest?: string;
  actuals: StepActual[];
  /** The step it is in, since when: after its landing checks, `promotion_set`. */
  current: { step: DeliveryStep; since: string };
}

const PR_URL = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)$/;

/** owner/name and number of a pull request URL. */
export function pullRequestRef(url: string): { repo: string; number: number } | undefined {
  const m = PR_URL.exec(url);
  return m ? { repo: m[1]!.toLowerCase(), number: Number(m[2]) } : undefined;
}

interface Marks { repo?: string; issue?: string; queued?: string; started?: string; finished?: string; pr?: string; merged?: string }

/** Every job's track that the events name with a `job.queued`, oldest event first. */
export function deliveryTracks(events: readonly DomainEvent[]): Map<string, DeliveryTrack> {
  const marks = new Map<string, Marks>();
  // A batch run's pull request number → its repository and the pull requests it carries; then, per carried pull request, its first promotion.
  const batches = new Map<string, number[]>();
  const promoted = new Map<string, string>();
  const first = (m: Marks, k: 'queued' | 'started' | 'finished' | 'merged', at: string) => { m[k] ??= at; };
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const d = e.data as Record<string, unknown>;
    if (e.type === 'landing_batch.started') {
      batches.set(`${String(d.repo).toLowerCase()}#${String(d.pullRequest)}`, (d.merges as number[] | undefined) ?? []);
      continue;
    }
    if (e.type === 'landing_batch.promoted') {
      const repo = String(d.repo).toLowerCase();
      for (const n of batches.get(`${repo}#${String(d.pullRequest)}`) ?? []) if (!promoted.has(`${repo}#${n}`)) promoted.set(`${repo}#${n}`, e.at);
      continue;
    }
    if (!e.jobId) continue;
    if (e.type === 'job.queued') {
      const s = d.source as { repo?: string; number?: number } | undefined;
      const m: Marks = marks.get(e.jobId) ?? {};
      if (s?.repo) Object.assign(m, { repo: s.repo, ...(s.number !== undefined ? { issue: `${s.repo}#${s.number}` } : {}) });
      first(m, 'queued', e.at);
      marks.set(e.jobId, m);
      continue;
    }
    const m = marks.get(e.jobId);
    if (!m) continue;
    if (e.type === 'job.started') first(m, 'started', e.at);
    else if (e.type === 'job.finished') first(m, 'finished', e.at);
    else if (e.type === 'github_proxy.done' && d.op === 'pr.create' && typeof d.url === 'string') m.pr ??= d.url;
    else if (e.type === 'job.pull_request_followed') m.pr ??= String(d.pullRequest);
    else if (e.type === 'job.pull_request_merged') {
      m.pr ??= String(d.pullRequest);
      first(m, 'merged', e.at);
    }
  }
  const tracks = new Map<string, DeliveryTrack>();
  for (const [jobId, m] of marks) {
    const ref = m.pr ? pullRequestRef(m.pr) : undefined;
    const landed = m.merged && ref ? promoted.get(`${ref.repo}#${ref.number}`) : undefined;
    // Each step's start and end, in order; a step ends where the next one starts.
    const bounds: [DeliveryStep, string | undefined][] = [
      ['queued', m.queued], ['coding', m.started], ['pr_checks', m.finished], ['landing', m.merged], ['landing_checks', m.merged], ['promotion_set', landed],
    ];
    const actuals: StepActual[] = [];
    let current: DeliveryTrack['current'] = { step: 'queued', since: m.queued! };
    for (let i = 0; i < bounds.length - 1; i++) {
      const [step, start] = bounds[i]!;
      if (start === undefined) break;
      const end = bounds[i + 1]![1];
      actuals.push({ step, start, ...(end === undefined ? {} : { end }) });
      current = end === undefined ? { step, since: start } : { step: bounds[i + 1]![0], since: end };
    }
    tracks.set(jobId, {
      jobId, ...(m.repo ? { repo: m.repo } : {}), ...(m.issue ? { issue: m.issue } : {}), ...(m.pr ? { pullRequest: m.pr } : {}), actuals, current,
    });
  }
  return tracks;
}

/** The measured durations in ms of each step that ended, of the tracks of repository `repo`. */
export function stepHistory(tracks: Iterable<DeliveryTrack>, repo: string): Partial<Record<DeliveryStep, number[]>> {
  const out: Partial<Record<DeliveryStep, number[]>> = {};
  for (const t of tracks) {
    if (t.repo?.toLowerCase() !== repo.toLowerCase()) continue;
    for (const a of t.actuals) if (a.end !== undefined) (out[a.step] ??= []).push(Date.parse(a.end) - Date.parse(a.start));
  }
  return Object.fromEntries(DELIVERY_STEPS.flatMap((s) => (out[s] ? [[s, out[s]]] : [])));
}
