// Direct jobs (issue #901, design.md "Direct jobs"): a job a person submits straight to the hopper — through the UI
// session, an API token or the operator CLI — with no GitHub issue behind it. Its brief and its results stay in the
// hopper's database; nothing about it goes to GitHub unless its work opens a pull request on purpose. The submission is
// kept as a record, the job is made from it by the `direct` job source, and the record reads back with its job. Pure.
import type { ActingPerson } from './failures.ts';
import { promotionOffer, type PromotionArtifact, type PromotionView } from './promotions.ts';
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
  /** Offer its promotion to GitHub once it finished (issue #946): never posted without a person's confirmed preview. */
  promoteWhenDone?: boolean;
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
 * vault grant, made at submit after Access, as a person's Grant on Settings → Vault.
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
