// Failure assessment (issue #509, design.md "Failure assessment"): the assessor's vocabulary. A failed job is
// assessed — its error normalised to a signature, matched to a known cause, and decided: run again (transient),
// grouped into a problem (a shared cause, held or redirected), or handed to a person (job-specific).

/** What the assessor decides for a failed job. */
export const FAILURE_DECISIONS = ['retry', 'hold', 'redirect', 'person'] as const;
export type FailureDecision = typeof FAILURE_DECISIONS[number];

/** The kind of a failure's cause: a hiccup, a cause many jobs share, or one of this job's own. */
export const FAILURE_CLASSES = ['transient', 'shared', 'job'] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];

/**
 * What became of a decision. `retried`, `redirected`, `released`: its job ran again (`nextJobId`). `held`: it
 * waits on its problem. `surfaced`: it waits on a person. `not_retried`: running it again was refused (`note`).
 * `superseded` (issue #517): a newer job of its item exists (`nextJobId`) — a person's Run again, or anything
 * else — so nothing is left to do for this one. `item_closed` (issue #529): its item is closed at its source, so
 * nothing waits on it either. `resolved` (issue #551): a person resolved its hand-off without running it again — done
 * by hand, or won't do (`note`).
 */
export const FAILURE_OUTCOMES = ['retried', 'redirected', 'released', 'held', 'surfaced', 'not_retried', 'superseded', 'item_closed', 'resolved'] as const;
export type FailureOutcome = typeof FAILURE_OUTCOMES[number];

/** A run again the assessor will make when due: a retry after its backoff, a redirect now, a release of a held job. */
export type PendingRun = 'retry' | 'redirect' | 'release';

/** Where a problem applies: a machine, an executor on it, or (neither) every machine. */
export interface ProblemScope { machineId?: string; executor?: string }

/** What a failed job looked like when it failed. */
export interface FailureEvidence {
  error: string;
  /** The pane or output tail at failure, when its executor gave one. */
  tail?: string;
  /** The job's last progress line. */
  lastProgress?: string;
  machineId?: string;
  executor: string;
  model?: string;
  repo?: string;
  source?: string;
  /** Its run in its chain of retries: 1 = the first. */
  attempt: number;
  /** How long it ran, from its start to its failure. */
  ranMs?: number;
  /** Other items failed with the same signature within the grouping window. */
  sameSignature: number;
}

/** One classified failure record. */
export interface FailureRecord {
  id: string;
  jobId: string;
  at: string;
  /** Hash of `normalised`: one per cause. */
  signature: string;
  /** The error text with ids, paths, numbers and times stripped. */
  normalised: string;
  cls: FailureClass;
  causeId?: string;
  causeName?: string;
  decision: FailureDecision;
  reasons: string[];
  summary: string;
  /** False when the decision's automatic action is off in the settings: it waits for a person. */
  auto: boolean;
  evidence: FailureEvidence;
  problemId?: string;
  /** A retry: when it runs again. */
  retryAt?: string;
  /** A run again the assessor makes at `pendingAt`; absent once made or refused. */
  pending?: PendingRun;
  pendingAt?: string;
  outcome?: FailureOutcome;
  outcomeAt?: string;
  note?: string;
  nextJobId?: string;
  /** The hand-off it opened (issue #516): set once, so it is never handed off twice. */
  handoffId?: string;
}

/** A shared cause: the failures of one signature grouped, shown once with the jobs it hit. */
export interface Problem {
  id: string;
  signature: string;
  title: string;
  causeId?: string;
  /** Redirect: a job that may run elsewhere does; hold: it waits. */
  decision: 'hold' | 'redirect';
  scope: ProblemScope;
  status: 'open' | 'resolved';
  openedAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: 'user' | 'check';
  /** Flagged by recurrence: no known cause, the same signature on enough jobs. */
  general: boolean;
  /** The failed jobs grouped in it, first first. */
  jobIds: string[];
  /** A check (machine online, disk free) saw the cause present: once it passes, the problem resolves by itself. */
  checkSawCause?: boolean;
}

/** What the decider reads of an open problem. */
export interface ProblemBlock { id: string; title: string; machineId?: string; executor?: string }

/** A known cause: built in, matched by its text, or named by a person for a signature. */
export interface KnownCause {
  id: string;
  name: string;
  description: string;
  cls: FailureClass;
  decision: FailureDecision;
  /** Where its problem applies: the job's machine, its executor on that machine, or every machine. */
  scope: 'machine' | 'executor' | 'all';
  /** The check that resolves its problem by itself. */
  check?: 'online' | 'disk';
  builtin: boolean;
}

/** A cause a person named for a signature, with its default decision. */
export interface NamedCause { signature: string; name: string; description: string; decision: FailureDecision }

export interface FailureSettings {
  /** Retries per job, its chain of runs again. 0: none. */
  maxAttempts: number;
  /** The first retry's wait; each next one `backoffFactor` times longer, at most `backoffMaxSec`. */
  backoffSec: number;
  backoffFactor: number;
  backoffMaxSec: number;
  /** This many items failed with one signature within `groupWindowMin` minutes flag it as a general cause. */
  groupThreshold: number;
  groupWindowMin: number;
  /** Whether each decision acts by itself; off, it waits for a person. */
  auto: { retry: boolean; hold: boolean; redirect: boolean };
  /** Failure records and resolved problems older than this are deleted. */
  retentionDays: number;
  /** Closed hand-offs older than this are deleted; an open one never is. */
  handoffRetentionDays: number;
  /** Whether a job handed off to a person tells the webhooks (`handoff.opened`'s `notify`). */
  handoffNotify: boolean;
}

export const DEFAULT_FAILURE_SETTINGS: FailureSettings = {
  maxAttempts: 3, backoffSec: 60, backoffFactor: 2, backoffMaxSec: 1800, groupThreshold: 3, groupWindowMin: 60,
  auto: { retry: true, hold: true, redirect: true }, retentionDays: 90,
  handoffRetentionDays: 30, handoffNotify: true,
};

export const FAILURE_SETTING_BOUNDS = {
  maxAttempts: { min: 0, max: 10 }, backoffSec: { min: 1, max: 3600 }, backoffFactor: { min: 1, max: 10 }, backoffMaxSec: { min: 1, max: 86400 },
  groupThreshold: { min: 2, max: 50 }, groupWindowMin: { min: 1, max: 10080 }, retentionDays: { min: 1, max: 3650 },
  handoffRetentionDays: { min: 1, max: 3650 },
} as const;

/** The assessment a failed job carries (`Job.assessment`): what the Queue and Overview show beside its error. */
export interface JobAssessment {
  recordId: string;
  at: string;
  class: FailureClass;
  decision: FailureDecision;
  summary: string;
  reasons: string[];
  problemId?: string;
  problemTitle?: string;
  retryAt?: string;
}

/**
 * Why a failed job was handed off to a person (issue #516): its retries used up, a job-specific failure, its
 * decision's automatic action off, its run again refused, or its locked entry dismissed with nothing else to end it.
 */
export const HANDOFF_REASONS = ['retry_limit', 'person', 'auto_off', 'not_retried', 'dismissed'] as const;
export type HandoffReason = typeof HANDOFF_REASONS[number];

/**
 * How a hand-off ended: its item ran again (`nextJobId`), its job went on in its own agent session (`continued`, issue
 * #551), a person did the work by hand (`done_by_hand`) or decided it is not to be done (`wont_do`), or its job ended
 * finished. `cleared`: closed by the build before #551, with no resolution. Or, found stale by the sweep or at start
 * (issue #529): a newer job of its item exists (`superseded`), its item is closed at its source (`item_closed`), or
 * its job is gone (`job_gone`).
 */
export const HANDOFF_ENDS = ['run_again', 'continued', 'done_by_hand', 'wont_do', 'cleared', 'finished', 'superseded', 'item_closed', 'job_gone'] as const;
export type HandoffEnd = typeof HANDOFF_ENDS[number];

/**
 * What a person did about a hand-off (issue #551). `continue`: the job goes on with their note — in its own agent
 * session and work tree when it can resume, else a new job of its item told the failure and the note. `fixed`: they
 * fixed the cause (its environment, credentials, repository); its item runs again, told the note. `done_by_hand`:
 * they did the work themselves (a link to it, optional); its job ends finished. `wont_do`: it is not to be done, or it
 * was no real failure (the note says why); its job leaves the queue.
 */
export const HANDOFF_RESOLUTIONS = ['continue', 'fixed', 'done_by_hand', 'wont_do'] as const;
export type HandoffResolutionAction = typeof HANDOFF_RESOLUTIONS[number];

/**
 * A hand-off's resolution (issue #551): who resolved it, when, how, with their note and link. It goes back to the
 * job's item at its source (`writeBack`): on GitHub, one comment and the end label. `pending` is tried again at each
 * sync of the job's source, with the last error; `failed`: the source refused it for good (`writeBackError`); `none`:
 * the job has no source to tell, or its source takes no resolution.
 */
export interface HandoffResolution {
  action: HandoffResolutionAction;
  /** Who resolved it: the name of the person the UI session signed in. Never written to the source. */
  by: string;
  at: string;
  note?: string;
  link?: string;
  /** Continue only: true when the job's own agent session resumed, false when a new job ran instead. */
  resumed?: boolean;
  writeBack: 'pending' | 'written' | 'failed' | 'none';
  writeBackError?: string;
}

/**
 * A hand-off (issue #516): a failed job automatic handling ended for, waiting on a person — Failures, Needs a person.
 * Open until a person resolves it (issue #551) or its item runs again; never dropped by age. It keeps what the assessment said, so it
 * outlives the failure record's retention.
 */
export interface Handoff {
  id: string;
  jobId: string;
  /** The failure record it came from; absent for a failed job never assessed. */
  recordId?: string;
  status: 'open' | 'closed';
  reason: HandoffReason;
  openedAt: string;
  decision?: FailureDecision;
  class?: FailureClass;
  summary: string;
  reasons: string[];
  error: string;
  problemId?: string;
  closedAt?: string;
  end?: HandoffEnd;
  /** Run again, superseded or continued: the job that follows — for `continued`, its own job, going on. */
  nextJobId?: string;
  /** What a person did about it (issue #551); absent for one closed by anything else. */
  resolution?: HandoffResolution;
}

/** Whether the daemon takes an action now, and why not. */
export type Allowed = { ok: true } | { ok: false; why: string };

export interface ProblemView extends Problem {
  /** The jobs that wait on its release. */
  held: string[];
  actions: { resolve: Allowed; release: Allowed };
}

/**
 * `priority`, `high` (issue #535): its job's live priority, and whether it is high priority; absent with its job gone.
 * `actions` (issue #551): whether each resolution is taken now, and why not. `continueResumes`: Continue resumes the
 * job's own agent session; false, it runs a new job. `signature`, `causeName`: its failure record's, while the
 * record is kept, so a person can name its cause from the card.
 */
export interface HandoffView extends Handoff {
  actions: { continue: Allowed; fixed: Allowed; doneByHand: Allowed; wontDo: Allowed };
  continueResumes: boolean;
  signature?: string;
  causeName?: string;
  priority?: number;
  high?: boolean;
}

export interface FailureRecordView extends FailureRecord {
  actions: { retry: Allowed };
  priority?: number;
  high?: boolean;
}

export interface ProfileCount { key: string; count: number }

export interface SignatureStat {
  signature: string;
  /** Its cause's name, else its normalised text. */
  name: string;
  cls: FailureClass;
  count: number;
  /** Distinct jobs, and machines. */
  jobs: number;
  machines: number;
  lastAt: string;
  /** Recurs across jobs: on at least the grouping threshold of them. */
  general: boolean;
  /** Per day, oldest first, as `FailureProfile.days`. */
  trend: number[];
}

export interface FailureProfile {
  days: { day: string; count: number }[];
  signatures: SignatureStat[];
  byMachine: ProfileCount[];
  byRepo: ProfileCount[];
  byExecutor: ProfileCount[];
}

/** How many failed jobs are left (issue #517): both zero, every failure is processed and none needs a person. */
export interface FailureCounts {
  /** Failed jobs the assessor has not assessed yet. */
  unassessed: number;
  /** Open hand-offs: Needs a person. */
  needsPerson: number;
}

/** GET /api/failures. */
export interface FailuresView {
  now: string;
  counts: FailureCounts;
  settings: FailureSettings;
  causes: KnownCause[];
  /**
   * Every open hand-off (issue #516), oldest first, then those closed in the last day. Needs a person shows the open
   * ones; Ended the closed ones (issue #618).
   */
  handoffs: HandoffView[];
  /** Open problems, then those resolved in the last day. */
  problems: ProblemView[];
  /** The newest assessed failures still open: none that ended (issue #618). */
  recent: FailureRecordView[];
  /**
   * The failures that ended in the last day (issue #618): run again, settled, their hand-off closed or their job
   * finished. History: out of the open failures and the counts.
   */
  ended: FailureRecordView[];
  profile: FailureProfile;
}
