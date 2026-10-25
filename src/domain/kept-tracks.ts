// Kept delivery tracks and deployment records (issue #2775, design.md "Kept delivery tracks"): each job's delivery track,
// kept from its `job.queued` on, with every step it started and ended, the step it is in, since when and what it waits
// on; it closes only with its one deployment record — `deploy` once the change is delivered, `none` once the job ended
// with no change to deliver, or a person's no-deploy mark. A person flips its deployment expectation (deploy or none) any
// number of times, each flip kept, until a deployment completes: a `deploy` record is locked, a `none` one never is
// (part 2). Each edit of its item's text a sync saw is a text edit on it, at the step it was in (part 3). The fold is incremental: a pass gives it the kept marks and
// the events after its cursor, and the same event folded twice changes nothing (each mark is the first one). Pure.
import { scheduledActuals } from './delivery-forecast.ts';
import type { DeliveryRepo } from './delivery-settings.ts';
import { DEFAULT_BLOCKER, type Blocker, type DeliveryStep } from './delivery-steps.ts';
import { pullRequestRef } from './delivery-history.ts';
import type { StepActual } from './forecast-accuracy.ts';
import { promotionSetOf } from './promotion-sets.ts';
import type { DomainEvent, Job, JobStatus } from './types.ts';

/** The events a kept track is folded from: the delivery track's, and a pull request closed with no merge. */
export const KEPT_TRACK_EVENTS = [
  'job.queued', 'job.started', 'job.finished', 'job.pull_request_followed', 'job.pull_request_merged', 'job.pull_request_closed',
  'github_proxy.done', 'landing_batch.started', 'landing_batch.promoted', 'item.changed_since_snapshot', 'item.edit_seen',
] as const;

/**
 * An edit of a job's item text a sync saw (issue #2775 part 3): `item.changed_since_snapshot` while the job waits,
 * `item.edit_seen` once it started; when, at which step, the item's key, the hashes before and after, and who edited it.
 * The track records it only: it tells the job nothing.
 */
export interface TextEdit {
  seq: number; at: string; step: DeliveryStep; event: 'item.changed_since_snapshot' | 'item.edit_seen';
  key: string; fromHash: string; toHash: string; editors: string[];
}

/** What a track's events said so far: each the first one. `batches`: the batch runs (`owner/name#n`) that carried its pull request. */
export interface TrackMarks {
  repo?: string; issue?: string; source?: string;
  queued: string; started?: string; finished?: string; pr?: string; merged?: string; prClosed?: string; prClosedWhy?: string; landed?: string;
  batches?: string[];
  /** Every text edit, in order. */
  textEdits?: TextEdit[];
}

/** Why a job's deployment record expects no deployment: its job ended with no change, or a person marked it. */
/** `note`: a person's, with their mark; for a pull request the hopper closed, why it closed it (`job.pull_request_closed`'s `superseded`). */
export interface NoDeployOutcome { status: JobStatus | 'pull_request_closed' | 'marked'; report?: 'research' | 'proposal'; by?: string; note?: string }

/** A person's flip of a track's deployment expectation (issue #2775 part 2): `deploy` or `none`, by whom, when, and why. */
export interface DeploymentExpectation { expect: 'deploy' | 'none'; by: string; at: string; note?: string }

/**
 * A job's one deployment record, made when its kept track closes (issue #2775). A `deploy` record is locked: its deployment
 * completed. A `none` record stays open: a person can flip it to deploy at any later time. `expectations`: every flip, in order.
 */
export type DeploymentRecord = {
  jobId: string; repo?: string; at: string; expectations?: DeploymentExpectation[];
} & (
  | {
    kind: 'deploy';
    /** What was delivered: its pull request (the commit is the merge's). */
    artifact: { pullRequest: string };
    target: 'production';
    expected: 'delivered';
    /** The observed state at each hop: every delivery step it went through, with its start and end. */
    observed: StepActual[];
  }
  | {
    kind: 'none';
    /** Where the job came from: its issue (`owner/name#n`), else its source's name. */
    source: string;
    outcome: NoDeployOutcome;
  }
);

/** One job's kept track: its marks, every step it started and ended, where it is now, and its deployment record once closed. */
export interface KeptTrack {
  jobId: string;
  repo?: string;
  issue?: string;
  pullRequest?: string;
  marks: TrackMarks;
  /** Every step it started, with its end once it ended: the transitions, in order. */
  steps: StepActual[];
  /** The step it is in, since when, what holds it, and what it waits on, in plain words. Kept as it was at the close. */
  current: { step: DeliveryStep; since: string; blocker: Blocker; waitingOn: string };
  state: 'open' | 'closed';
  closedAt?: string;
  /** Its deployment record: once it closed, and kept when a person reopens it by a flip to deploy. */
  deployment?: DeploymentRecord;
  /** Every flip of its deployment expectation, in order; the last one holds. */
  expectations?: DeploymentExpectation[];
  /** Every text edit of its item, in order: its marks'. */
  textEdits?: TextEdit[];
}

/** A track whose deployment completed: its record is final, and no flip changes it. */
export const lockedOf = (t: Pick<KeptTrack, 'deployment'>): boolean => t.deployment?.kind === 'deploy';

const first = <K extends keyof TrackMarks>(m: TrackMarks, k: K, v: TrackMarks[K]): void => { m[k] ??= v; };

/**
 * Folds the events into the marks of each job's track. `marks` holds the open tracks' kept marks; a `job.queued` of a job
 * it does not hold, and not in `closed`, starts one. Events of a job it holds no track of are not its. Answers the jobs whose
 * marks changed.
 */
export function foldTrackEvents(marks: Map<string, TrackMarks>, events: readonly DomainEvent[], closed: ReadonlySet<string> = new Set()): Set<string> {
  const changed = new Set<string>();
  const set = (jobId: string, m: TrackMarks, apply: () => void) => {
    const before = JSON.stringify(m);
    apply();
    if (JSON.stringify(m) !== before) changed.add(jobId);
  };
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const d = e.data as Record<string, unknown>;
    if (e.type === 'landing_batch.started') {
      const repo = String(d.repo).toLowerCase();
      const merges = new Set((d.merges as number[] | undefined) ?? []);
      for (const [jobId, m] of marks) {
        const ref = m.pr ? pullRequestRef(m.pr) : undefined;
        const batch = `${repo}#${String(d.pullRequest)}`;
        if (ref?.repo === repo && merges.has(ref.number) && !m.batches?.includes(batch)) set(jobId, m, () => { m.batches = [...m.batches ?? [], batch]; });
      }
      continue;
    }
    if (e.type === 'landing_batch.promoted') {
      const batch = `${String(d.repo).toLowerCase()}#${String(d.pullRequest)}`;
      for (const [jobId, m] of marks) if (m.batches?.includes(batch)) set(jobId, m, () => first(m, 'landed', e.at));
      continue;
    }
    if (!e.jobId) continue;
    if (e.type === 'job.queued') {
      if (marks.has(e.jobId) || closed.has(e.jobId)) continue;
      const s = d.source as { source?: string; repo?: string; number?: number } | undefined;
      marks.set(e.jobId, {
        queued: e.at,
        ...(s?.repo ? { repo: s.repo.toLowerCase() } : {}),
        ...(s?.repo && s.number !== undefined ? { issue: `${s.repo.toLowerCase()}#${s.number}` } : {}),
        ...(s?.source ? { source: s.source } : {}),
      });
      changed.add(e.jobId);
      continue;
    }
    const m = marks.get(e.jobId);
    if (!m) continue;
    set(e.jobId, m, () => {
      if (e.type === 'job.started') first(m, 'started', e.at);
      else if (e.type === 'job.finished') first(m, 'finished', e.at);
      else if (e.type === 'github_proxy.done' && d.op === 'pr.create' && typeof d.url === 'string') first(m, 'pr', d.url);
      else if ((e.type === 'item.changed_since_snapshot' || e.type === 'item.edit_seen') && !m.textEdits?.some((x) => x.seq === e.seq)) {
        const snap = e.type === 'item.changed_since_snapshot';
        m.textEdits = [...m.textEdits ?? [], {
          seq: e.seq, at: e.at, step: measuredOf(m).current.step, event: e.type, key: String(d.key),
          fromHash: String(snap ? d.snapshotHash : d.fromHash), toHash: String(snap ? d.liveHash : d.toHash), editors: (d.editors as string[] | undefined) ?? [],
        }];
      } else if (e.type === 'job.pull_request_followed') first(m, 'pr', String(d.pullRequest));
      else if (e.type === 'job.pull_request_merged') { first(m, 'pr', String(d.pullRequest)); first(m, 'merged', e.at); }
      else if (e.type === 'job.pull_request_closed' && (m.pr === undefined || m.pr === String(d.pullRequest))) {
        first(m, 'prClosed', e.at);
        // The hopper closed it as nothing was left to land: why, so the record says the change may be on its base already.
        if (typeof d.superseded === 'string') first(m, 'prClosedWhy', d.superseded);
      }
    });
  }
  return changed;
}

/** The measured steps from the marks, as `deliveryTracks` reads them: each step ends where the next one starts. */
export function measuredOf(m: TrackMarks): { steps: StepActual[]; current: { step: DeliveryStep; since: string } } {
  const landed = m.merged ? m.landed : undefined;
  const bounds: [DeliveryStep, string | undefined][] = [
    ['queued', m.queued], ['coding', m.started], ['pr_checks', m.finished], ['landing', m.merged], ['landing_checks', m.merged], ['promotion_set', landed],
  ];
  const steps: StepActual[] = [];
  let current = { step: 'queued' as DeliveryStep, since: m.queued };
  for (let i = 0; i < bounds.length - 1; i++) {
    const [step, start] = bounds[i]!;
    if (start === undefined) break;
    const end = bounds[i + 1]![1];
    steps.push({ step, start, ...(end === undefined ? {} : { end }) });
    current = end === undefined ? { step, since: start } : { step: bounds[i + 1]![0], since: end };
  }
  return { steps, current };
}

/** What the step a change is in waits on, in plain words. */
export function waitingOnOf(step: DeliveryStep, since: string, d: DeliveryRepo): { blocker: Blocker; waitingOn: string } {
  const gate = d.gates[step];
  if (gate) return { blocker: 'human_gate', waitingOn: `a gate clearance by ${gate.owner}` };
  const blocker = DEFAULT_BLOCKER[step];
  switch (step) {
    case 'queued': return { blocker, waitingOn: 'a lane to start the job' };
    case 'coding': return { blocker, waitingOn: 'the job to finish its work' };
    case 'pr_checks': return { blocker, waitingOn: 'the checks and the merge of its pull request' };
    case 'landing': return { blocker, waitingOn: 'the merge onto the landing branch' };
    case 'landing_checks': return { blocker, waitingOn: 'a green run of the checks on the landing branch that carries it (a batch run for the hopper)' };
    case 'promotion_set': {
      if (!d.schedule) return { blocker, waitingOn: 'a promotion set schedule: the delivery settings name none for its repository' };
      const set = promotionSetOf(d.schedule, since);
      return { blocker, waitingOn: set ? `the cutoff of promotion set ${set.set} at ${set.cutoffAt}` : 'the next cutoff of its promotion set schedule' };
    }
    case 'test_gate': return { blocker, waitingOn: 'the end of the test gate' };
    case 'production': return { blocker, waitingOn: 'the release to production' };
  }
}

/** A job ended so, with no merged pull request, carries no change. */
const ENDED_NO_CHANGE = new Set<JobStatus>(['failed', 'cancelled', 'rejected']);

/** What the pass knows of a track's job and its repository at `now`. */
export interface TrackContext {
  now: string;
  /** Its job, when the store still holds it. */
  job?: Pick<Job, 'status'> & Partial<Pick<Job, 'researchId' | 'proposalId'>>;
  delivery: DeliveryRepo;
  /** When each gate of the promotion set the change is in was cleared. */
  cleared: Partial<Record<DeliveryStep, string>>;
}

const sourceOf = (m: TrackMarks): string => m.issue ?? m.source ?? 'unknown';

/**
 * The track of `jobId` from its marks at `now`. A track kept closed stays as it was: only a person's flip opens it again
 * (`expectOf`). It closes with its deployment record: `deploy` once its production step ended, whatever a person said;
 * `none` once its job ended with no change (failed, cancelled or rejected before a merge; finished with no pull request;
 * its pull request closed with no merge), unless a person's last flip expects a deployment.
 */
export function trackOf(jobId: string, marks: TrackMarks, c: TrackContext, kept?: KeptTrack): KeptTrack {
  if (kept?.state === 'closed') return kept;
  const expectations = kept?.expectations ?? [];
  const measured = measuredOf(marks);
  const steps = [...measured.steps];
  let current = measured.current;
  let deliveredAt: string | undefined;
  if (current.step === 'promotion_set') {
    const scheduled = scheduledActuals(c.delivery.schedule, current, c.delivery.gates, c.now, c.cleared);
    steps.push(...scheduled);
    const last = scheduled.at(-1)!;
    if (last.end !== undefined) deliveredAt = last.end;
    current = { step: last.step, since: last.start };
  }
  const track: KeptTrack = {
    jobId, ...(marks.repo ? { repo: marks.repo } : {}), ...(marks.issue ? { issue: marks.issue } : {}), ...(marks.pr ? { pullRequest: marks.pr } : {}),
    marks, steps, current: { ...current, ...waitingOnOf(current.step, current.since, c.delivery) }, state: 'open',
    ...(kept?.deployment ? { deployment: kept.deployment } : {}), ...(expectations.length > 0 ? { expectations } : {}),
    ...(marks.textEdits ? { textEdits: marks.textEdits } : {}),
  };
  const close = (at: string, deployment: DeploymentRecord): KeptTrack => ({ ...track, state: 'closed', closedAt: at, deployment });
  const base = { jobId, ...(marks.repo ? { repo: marks.repo } : {}), ...(expectations.length > 0 ? { expectations } : {}) };
  if (deliveredAt !== undefined && marks.pr) {
    return close(deliveredAt, { ...base, at: deliveredAt, kind: 'deploy', artifact: { pullRequest: marks.pr }, target: 'production', expected: 'delivered', observed: steps });
  }
  const none = (at: string, outcome: NoDeployOutcome) => close(at, { ...base, at, kind: 'none', source: sourceOf(marks), outcome });
  if (marks.merged || expectations.at(-1)?.expect === 'deploy') return track;
  // A job the store no longer holds: its events say how it ended.
  const status = c.job?.status ?? (marks.finished ? 'finished' : undefined);
  const report: Partial<NoDeployOutcome> = c.job?.researchId ? { report: 'research' } : c.job?.proposalId ? { report: 'proposal' } : {};
  if (marks.prClosed) return none(marks.prClosed, { status: 'pull_request_closed', ...report, ...(marks.prClosedWhy ? { note: marks.prClosedWhy } : {}) });
  if (status && ENDED_NO_CHANGE.has(status)) return none(c.now, { status, ...report });
  if (status === 'finished' && !marks.pr) return none(marks.finished ?? c.now, { status, ...report });
  return track;
}

/**
 * A person's flip of a track's deployment expectation (`POST /ui/api/delivery-tracks/no-deploy|deploy`), kept after the
 * flips before it. `none` closes the track with a `none` record, outcome `marked`; `deploy` opens it again, its record kept,
 * so the kept-track pass judges it again and closes it only once its deployment completes. A locked track throws: its
 * deployment completed, and a change goes to a new job.
 */
export function expectOf(t: KeptTrack, flip: DeploymentExpectation): KeptTrack {
  if (lockedOf(t)) throw new Error(`the deployment of job ${t.jobId} completed: its record is locked`);
  const expectations = [...t.expectations ?? [], flip];
  if (flip.expect === 'none') {
    return {
      ...t, expectations, state: 'closed', closedAt: flip.at,
      deployment: {
        jobId: t.jobId, ...(t.repo ? { repo: t.repo } : {}), at: flip.at, expectations, kind: 'none', source: sourceOf(t.marks),
        outcome: { status: 'marked', by: flip.by, ...(flip.note ? { note: flip.note } : {}) },
      },
    };
  }
  const { closedAt: _closed, ...open } = t;
  return { ...open, expectations, state: 'open', ...(t.deployment ? { deployment: { ...t.deployment, expectations } } : {}) };
}

/** What the last flip of a track asks, if a person flipped it. */
export const expectationOf = (t: Pick<KeptTrack, 'expectations'>): DeploymentExpectation['expect'] | undefined => t.expectations?.at(-1)?.expect;

/** GET /api/delivery-tracks's answer, and GET /api/deployments's. */
export interface DeliveryTracksView { tracks: KeptTrack[] }
export interface DeploymentsView { deployments: DeploymentRecord[] }

/** The kept tracks and deployment records (tenant migration 101): a locked track, and its `deploy` record, never change. */
export interface KeptTrackRepository {
  /** The newest event seq the pass folded; none before its first pass. */
  cursor(): number | undefined;
  /** Every open track. */
  open(): KeptTrack[];
  /** Which of these jobs have a closed track. */
  closedOf(jobIds: readonly string[]): Set<string>;
  get(jobId: string): KeptTrack | undefined;
  /** Keeps each track, and its deployment record, and the cursor, in one transaction. A locked track and its record are not written over. */
  save(tracks: readonly KeptTrack[], cursor?: number): void;
  /** Newest first, by the time of its first step. */
  list(q?: { job?: string; repo?: string; state?: KeptTrack['state']; limit?: number }): KeptTrack[];
  /** Newest first. */
  deployments(q?: { job?: string; repo?: string; target?: string; kind?: DeploymentRecord['kind']; limit?: number }): DeploymentRecord[];
}
