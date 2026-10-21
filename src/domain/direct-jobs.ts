// Direct jobs (issue #901, design.md "Direct jobs"): a job a person submits straight to the hopper — through the UI
// session, an API token or the operator CLI — with no GitHub issue behind it. Its brief and its results stay in the
// hopper's database; nothing about it goes to GitHub unless its work opens a pull request on purpose. The submission is
// kept as a record, the job is made from it by the `direct` job source, and the record reads back with its job. Pure.
import type { ActingPerson } from './failures.ts';
import { promotionOffer, type PromotionArtifact, type PromotionView } from './promotions.ts';
import type { FollowsPullRequests } from './pull-requests.ts';
import type { DomainEvent, Job, JobStatus } from './types.ts';

/** The name and kind of the job source that makes a direct job's job: its jobs are keyed by it. */
export const DIRECT_SOURCE = 'direct';

/** The source key of a direct job's item. */
export const directKey = (id: string): string => `${DIRECT_SOURCE}:${id}`;

/**
 * How the `direct` source follows a direct job's own pull request (issue #1068): with the GitHub connection of the user
 * whose direct job it is — the one its job opened the pull request with through the hopper. Absent: nothing is followed.
 * The ends of the pull requests and items its jobs' waits name are read with it too (issue #1721): no other source lists a
 * direct job, so the sync asks the direct source.
 */
export type DirectPullRequests = Required<Pick<FollowsPullRequests, 'follow' | 'mergesOnReady' | 'tendStarted' | 'checkLogs' | 'endedPullRequests' | 'endedWatched' | 'waitedChecks' | 'waitedReviews'>>;

/**
 * The pull request a direct job opened on its repository `repo` through the hopper's GitHub proxy (issue #1068): the
 * newest `github_proxy.done` of op `pr.create` among `events`, the job's own. Undefined: it opened none there.
 */
export function openedPullRequest(events: readonly DomainEvent[], repo: string): string | undefined {
  const opened = events
    .filter((e) => e.type === 'github_proxy.done' && e.data.op === 'pr.create' && typeof e.data.url === 'string'
      && typeof e.data.repo === 'string' && e.data.repo.toLowerCase() === repo.toLowerCase())
    .sort((a, b) => b.seq - a.seq);
  return opened[0]?.data.url as string | undefined;
}

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
  /** Offer its promotion to GitHub once it finished (issue #946): never posted without a person's confirmed preview. */
  promoteWhenDone?: boolean;
  /** It is a direct query (issue #2184): a question its job answers by looking only. Absent: a direct job of any work. */
  query?: DirectQuery;
}

/**
 * A direct query (issue #2184, design.md "Direct queries"): a question a caller asks the hopper straight, with no GitHub
 * issue. Its job only looks: it changes no code, infrastructure or secret, and the hopper refuses its GitHub writes and
 * its pushes. Its answer is the job's result, kept in the hopper, and sent to its callback.
 */
export interface DirectQuery {
  /** The caller's own id of the request: the same id again answers the query kept, and makes nothing new. */
  requestId: string;
  /**
   * The webhook subscription its callback goes to, by name: a person made it through the UI session, with its URL and its
   * signing secret, kept sealed in the vault. Absent: no callback; the caller reads the query back.
   */
  callback?: string;
  /** Where to look first, in the caller's words: hints for the job, which allow nothing. */
  repos?: string[];
  clusters?: string[];
}

/** What a caller asks (issue #2184): the question, and the query's own fields. */
export interface DirectQueryInput extends DirectQuery {
  question: string;
  /** More routing labels beside `DIRECT_QUERY_LABEL`. */
  labels?: string[];
  executor?: string;
  priority?: number;
}

/** A direct query as it reads back: its record and its newest job, with where it stands. */
export type DirectQueryView = DirectJobView & { query: DirectQuery; state: DirectQueryState };

/** The routing label of every direct query's job: a routing rule sends it to the seat or sandbox box it names. */
export const DIRECT_QUERY_LABEL = 'direct:query';
/** The job's variable that names its direct query: the GitHub proxy and the git proxy read it as look-only. */
export const DIRECT_QUERY_ENV = 'HOPPER_DIRECT_QUERY';

/** Why a direct query's job may not write: what the proxies answer when it tries. */
export const LOOK_ONLY = 'a direct query only looks: it changes nothing on GitHub and pushes nothing. When the question needs a change, end failed and say what a person must file as an issue';

/** Whether the job is a direct query's, so looks only (issue #2184). */
export const isDirectQuery = (job: Pick<Job, 'spec'>): boolean => {
  // A job read back partly (a test's, an older row's) may have no spec: it is no direct query's.
  const env = (job.spec as Partial<Job['spec']> | undefined)?.payload?.env as Record<string, unknown> | undefined;
  return typeof env?.[DIRECT_QUERY_ENV] === 'string';
};

/** Where a direct query stands, from its newest job: what a caller polls. */
export type DirectQueryState = 'accepted' | 'running' | 'waiting' | 'answered' | 'failed' | 'cancelled';

export function directQueryState(job: DirectJobView['job']): DirectQueryState {
  if (!job) return 'accepted';
  if (job.status === 'finished') return 'answered';
  if (job.status === 'failed' || job.status === 'rejected') return 'failed';
  if (job.status === 'cancelled') return 'cancelled';
  if (job.questions.length > 0 || job.status === 'waiting_answer' || job.status === 'waiting_on') return 'waiting';
  return job.status === 'running' || job.status === 'claimed' ? 'running' : 'accepted';
}

/** A submitted direct job, as kept. */
export interface DirectJob extends DirectJobInput {
  id: string;
  /** Who submitted it, and the way: the UI, an API token or the operator CLI. Who authorized what it lists. */
  submittedBy: ActingPerson;
  submittedAt: string;
}

/**
 * The authorization that grants the direct job's item the vault (design.md "Direct jobs", part 3): the submitter's own
 * vault grant, made at submit after Access, as a person's Grant on Vault.
 */
export const VAULT_AUTHORIZATION = 'vault';

/** Whether the submission authorizes the vault. */
export const authorizesVault = (d: Pick<DirectJobInput, 'authorizations'>): boolean => d.authorizations.includes(VAULT_AUTHORIZATION);

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
  /** Its job's artifacts (issue #946): its outputs, private in the hopper, newest first. */
  artifacts: PromotionArtifact[];
  /** Its live promotion to GitHub (issue #946), with the artifacts changed since. */
  promotion?: PromotionView;
  /** Whether it is offered for promotion now: asked at submit, or suggested by its artifacts. */
  offer?: 'asked' | 'suggested';
}

/** What a direct job reads back with besides its job (issue #946): its artifacts and its live promotion. */
export interface DirectJobOutputs { artifacts: PromotionArtifact[]; promotion?: PromotionView }

/** The view of a direct job, given its newest job, that job's open questions, and its outputs. */
export function directJobView(d: DirectJob, job: Job | undefined, questions: DirectJobQuestion[], outputs: DirectJobOutputs = { artifacts: [] }): DirectJobView {
  const base = { ...d, artifacts: outputs.artifacts, ...(outputs.promotion ? { promotion: outputs.promotion } : {}) };
  if (!job) return base;
  const v: DirectJobView = {
    ...base,
    job: {
      id: job.id, status: job.status,
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      questions,
    },
  };
  const offer = promotionOffer(v);
  return offer ? { ...v, offer } : v;
}

/** The direct jobs' store. */
export interface DirectJobRepository {
  /** Keeps it under `id`; absent: a new id. */
  add(input: Omit<DirectJob, 'id'>, id?: string): DirectJob;
  get(id: string): DirectJob | undefined;
  /** Newest first. */
  list(): DirectJob[];
}
