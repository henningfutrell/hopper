// Pointed jobs (issue #425, tracking issue #424, design.md "Pointed jobs"): a record that points at work in a GitHub
// repository — an issue or a pull request — with what to do there, the lane that works it, and a status that moves only
// along the allowed transitions. A job the hopper already has, of a repository and an issue, reads as one (`pointedJobOf`):
// its status follows its job, so it is never moved through the pointed job API. Pure.
import type { Job, JobStatus, LaneId } from './types.ts';

export const POINTED_JOB_STATUSES = ['queued', 'running', 'awaiting_review', 'merged', 'abandoned'] as const;
export type PointedJobStatus = (typeof POINTED_JOB_STATUSES)[number];

/** The statuses each status may move to. Merged and abandoned are ends: nothing moves out of them. */
export const TRANSITIONS: Readonly<Record<PointedJobStatus, readonly PointedJobStatus[]>> = {
  queued: ['running', 'abandoned'],
  running: ['awaiting_review', 'queued', 'abandoned'],
  awaiting_review: ['merged', 'running', 'abandoned'],
  merged: [],
  abandoned: [],
};

export const canMove = (from: PointedJobStatus, to: PointedJobStatus): boolean => TRANSITIONS[from].includes(to);

export const POINTER_KINDS = ['issue', 'pull_request'] as const;

/** The work a pointed job points at: an issue or a pull request of its repository. */
export interface Pointer { kind: (typeof POINTER_KINDS)[number]; number: number; url: string }

export interface PointedJob {
  id: string;
  /** The target repository, `owner/name`. Owned or not, the same. */
  repo: string;
  pointer: Pointer;
  /** What to do there. */
  directive: string;
  /** The lane that works it, while it runs. */
  lane?: LaneId;
  status: PointedJobStatus;
  /** What made it: `api` for a person or an API token, else the job source of its job. */
  source: string;
  /** Set when it is a job the hopper already has, read as a pointed job: its status follows that job. */
  jobId?: string;
  createdAt: string;
  updatedAt: string;
}

/** A follow of a pull request (src/domain/pull-requests.ts) that still waits on a person or a tend job. */
const WAITS_ON_REVIEW = ['open', 'tended', 'reworked'];

const STATUS_OF_JOB: Readonly<Record<JobStatus, PointedJobStatus>> = {
  queued: 'queued', held: 'queued', parked: 'queued',
  claimed: 'running', running: 'running', waiting_answer: 'running', waiting_on: 'running', operator_led: 'running',
  // A finished job that follows no pull request ended done: its work is in.
  finished: 'merged', failed: 'abandoned', cancelled: 'abandoned', rejected: 'abandoned',
};

/** A job's status as a pointed job's: its pull request, once followed, decides it, whatever the job's end. */
function statusOf(job: Job): PointedJobStatus {
  const follow = (job.sourceState?.source as { follow?: unknown } | undefined)?.follow;
  if (follow === 'merged') return 'merged';
  if (follow === 'closed') return 'abandoned';
  if (typeof follow === 'string' && WAITS_ON_REVIEW.includes(follow)) return 'awaiting_review';
  return STATUS_OF_JOB[job.status];
}

/** The job as a pointed job on its issue; undefined when its item names no repository, number and URL. */
export function pointedJobOf(job: Job): PointedJob | undefined {
  const s = job.source;
  if (!s?.repo || s.number === undefined || !s.url) return undefined;
  return {
    id: job.id, jobId: job.id, repo: s.repo, pointer: { kind: 'issue', number: s.number, url: s.url },
    directive: job.spec.goal ?? s.title ?? '', ...(job.laneId ? { lane: job.laneId } : {}), status: statusOf(job), source: s.source,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

/** The pointed jobs' store (tenant migration 42). */
export interface PointedJobRepository {
  add(input: Omit<PointedJob, 'id' | 'jobId'>): PointedJob;
  get(id: string): PointedJob | undefined;
  /** Newest first. */
  list(): PointedJob[];
  /** Replace it whole; bumps nothing itself. */
  put(job: PointedJob): PointedJob;
}
