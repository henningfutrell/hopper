// Direct jobs (issue #901, design.md "Direct jobs"): a job a person submits straight to the hopper — through the UI
// session, an API token or the operator CLI — with no GitHub issue behind it. Its brief and its results stay in the
// hopper's database; nothing about it goes to GitHub unless its work opens a pull request on purpose. The submission is
// kept as a record, the job is made from it by the `direct` job source, and the record reads back with its job. Pure.
import type { ActingPerson } from './failures.ts';
import type { Job, JobStatus } from './types.ts';

/** The name and kind of the job source that makes a direct job's job: its jobs are keyed by it. */
export const DIRECT_SOURCE = 'direct';

/** The source key of a direct job's item. */
export const directKey = (id: string): string => `${DIRECT_SOURCE}:${id}`;

/** What a person submits. */
export interface DirectJobInput {
  title: string;
  /** What to do: private to the hopper. */
  brief: string;
  /** Routing labels (`sme:identity`): the routing rules match them, as an issue's labels. */
  labels: string[];
  /** What the submitter authorized the job to do or reach, each in their words (`keycloak:otp-reset`). */
  authorizations: string[];
  /** The repository (`owner/name`) its work may open a pull request on; absent: none. */
  repo?: string;
  /** The executor that runs it; absent: the default. */
  executor?: string;
  /** 0–100; absent: the default. */
  priority?: number;
}

/** A submitted direct job, as kept. */
export interface DirectJob extends DirectJobInput {
  id: string;
  /** Who submitted it, and the way: the UI, an API token or the operator CLI. Who authorized what it lists. */
  submittedBy: ActingPerson;
  submittedAt: string;
}

/** The executor a direct job runs on when it names none: the GitHub source's default too. */
export const DEFAULT_DIRECT_EXECUTOR = 'herdr-claude';
export const DEFAULT_DIRECT_PRIORITY = 50;

/** An open question of the job, as the requester reads it back. */
export interface DirectJobQuestion { id: string; text: string; tier: string; askedAt: string }

/** What a direct job reads back as: the record, and its newest job as it stands now. */
export interface DirectJobView extends DirectJob {
  job?: {
    id: string; status: JobStatus; result?: unknown; error?: string; finishedAt?: string;
    /** Its questions still open: answer one through `POST /ui/api/questions/:id/answer`. */
    questions: DirectJobQuestion[];
  };
}

/** The view of a direct job, given its newest job and that job's open questions. */
export function directJobView(d: DirectJob, job: Job | undefined, questions: DirectJobQuestion[]): DirectJobView {
  if (!job) return d;
  return {
    ...d,
    job: {
      id: job.id, status: job.status,
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      questions,
    },
  };
}

/** The direct jobs' store. */
export interface DirectJobRepository {
  add(input: Omit<DirectJob, 'id'>): DirectJob;
  get(id: string): DirectJob | undefined;
  /** Newest first. */
  list(): DirectJob[];
}
