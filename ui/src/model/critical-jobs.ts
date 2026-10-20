// The critical job tracker (issue #2203): every **critical job** — its priority at or above the critical priority the queue
// answers (`HOPPER_CRITICAL_PRIORITY`, default 100; 0: off), or its critical flag a person set (part 2) — in one widget
// pinned on every page, until the job ended and a person dismissed it (a dismissal is kept per browser, model/dismissed.ts).
// For each: where it runs, its current step in plain words and since when, its last few actions, and every wait that is a
// person's — each one an entry of its one home (Questions, Access requests, Proposals, Research, Needs a person, Logins, the
// queue), never a copy, so acting in either place clears both. Pure.
import { heldAtGate } from './blast-radius.ts';
import type { CredentialRequest, DomainEvent, FailuresView, HandoffView, Job, LoginView, QuestionView, ReviewItemView, ReviewKind, RunCardView, VaultView } from './wire.ts';

type VaultGrantAsk = NonNullable<VaultView['grantAsks']>[number];

/** At or above the critical priority. None is while the queue has answered none, or 0 (off). */
export const atCriticalPriority = (job: Pick<Job, 'priority'>, critical: number | null): boolean =>
  critical !== null && critical > 0 && job.priority >= critical;

/** Critical: the critical flag a person set (part 2), whatever its priority and the critical priority, or at the critical priority. */
export const isCriticalJob = (job: Pick<Job, 'priority' | 'critical'>, critical: number | null): boolean =>
  job.critical === true || atCriticalPriority(job, critical);

/** Why the job is a critical job, or `no`, as the job view says it. The flag first: it holds whatever the priority. */
export const criticalText = (job: Pick<Job, 'priority' | 'critical'>, critical: number | null): string =>
  job.critical === true ? 'yes: a person marked it critical'
    : atCriticalPriority(job, critical) ? `yes: its priority is at or above ${critical}` : 'no';

const ENDED: ReadonlySet<string> = new Set(['finished', 'failed', 'cancelled', 'rejected']);
export const hasEnded = (job: Pick<Job, 'status'>): boolean => ENDED.has(job.status);

/** A tracked job's dismissal, kept with the dismissed notices: one per job. */
export const trackerKey = (jobId: string): string => `critical:${jobId}`;

/**
 * The jobs the tracker shows: the critical jobs among `jobs`, each once; an ended one until it is dismissed. A job that has
 * not ended shows whatever was dismissed. The ones that have not ended first, then the oldest first.
 */
export function trackedJobs(jobs: Iterable<Job>, critical: number | null, dismissed: readonly string[]): Job[] {
  const byId = new Map<string, Job>();
  for (const j of jobs) if (isCriticalJob(j, critical) && !byId.has(j.id)) byId.set(j.id, j);
  return [...byId.values()]
    .filter((j) => !hasEnded(j) || !dismissed.includes(trackerKey(j.id)))
    .sort((a, b) => Number(hasEnded(a)) - Number(hasEnded(b)) || a.createdAt.localeCompare(b.createdAt));
}

/** A wait of a job that is a person's to act on, with the entry of its one home. */
export type TrackerWait =
  | { kind: 'question'; question: QuestionView }
  | { kind: 'run'; card: RunCardView }
  | { kind: 'grant'; ask: VaultGrantAsk }
  | { kind: 'credential'; request: CredentialRequest }
  | { kind: 'review'; review: ReviewKind; item: ReviewItemView }
  | { kind: 'handoff'; handoff: HandoffView }
  | { kind: 'login'; login: LoginView }
  /** Held at the blast-radius gate (issue #542): a person lets it through. */
  | { kind: 'gate' }
  /** Held by the decider for a person's approval. */
  | { kind: 'hold' }
  /** Its item's text changed since it started (issue #662). */
  | { kind: 'text-change' }
  /** At the queue gate, not yet accepted (issue #159). */
  | { kind: 'accept' }
  /** Its item's origin waits as a request card in Intake (issue #652). */
  | { kind: 'origin' }
  /** Its own wait (issue #483) on something only a person or the outside world does: a person ends it. */
  | { kind: 'wait' };

/** What the UI holds that a job's waits are read from. */
export interface WaitSources {
  questions: readonly QuestionView[];
  vault: VaultView | null;
  reviews: Readonly<Record<ReviewKind, { items: readonly ReviewItemView[] }>>;
  failures: FailuresView | null;
  logins: readonly LoginView[];
}

/** Each wait of `job` that is a person's, in the order a person acts: its decisions first, then its holds. */
export function waitsOf(job: Job, from: WaitSources): TrackerWait[] {
  const id = job.id;
  const waits: TrackerWait[] = [];
  for (const question of from.questions) if (question.jobId === id && question.status === 'open' && question.tier === 'human') waits.push({ kind: 'question', question });
  for (const card of from.vault?.runs ?? []) if (card.jobId === id) waits.push({ kind: 'run', card });
  for (const ask of from.vault?.grantAsks ?? []) if (ask.job === id) waits.push({ kind: 'grant', ask });
  for (const request of from.vault?.requests ?? []) if (request.asked.some((a) => a.job === id)) waits.push({ kind: 'credential', request });
  for (const review of ['proposal', 'research'] as const) {
    for (const item of from.reviews[review].items) if (item.jobId === id && item.status === 'open' && item.stage === 'human') waits.push({ kind: 'review', review, item });
  }
  for (const handoff of from.failures?.handoffs ?? []) if (handoff.jobId === id && handoff.status === 'open') waits.push({ kind: 'handoff', handoff });
  for (const login of from.logins) if (login.jobId === id && login.status === 'pending') waits.push({ kind: 'login', login });
  if (job.textChange) waits.push({ kind: 'text-change' });
  if (job.originPending) waits.push({ kind: 'origin' });
  if (job.accepted === false) waits.push({ kind: 'accept' });
  if (job.status === 'held' && heldAtGate(job)) waits.push({ kind: 'gate' });
  else if (job.status === 'held' && !job.approved && job.accepted !== false && !job.textChange && !job.originPending) waits.push({ kind: 'hold' });
  if (job.status === 'waiting_on' && job.wait && !job.wait.ownCommand) waits.push({ kind: 'wait' });
  return waits;
}

/** A wait's key: a new wait of the same job is a new attention, and notifies again. */
export function waitKey(jobId: string, w: TrackerWait): string {
  const of = (): string => {
    switch (w.kind) {
      case 'question': return w.question.id;
      case 'run': return `${w.card.template}@${w.card.askedAt}`;
      case 'grant': return `${w.ask.key}@${w.ask.askedAt}`;
      case 'credential': return w.request.id;
      case 'review': return w.item.id;
      case 'handoff': return w.handoff.id;
      case 'login': return w.login.id;
      default: return '';
    }
  };
  return `${jobId}:${w.kind}:${of()}`;
}

/** What each wait is, in plain words, and the action that settles it. */
export function waitText(w: TrackerWait): { what: string; act: string } {
  switch (w.kind) {
    case 'question': return { what: `Question: ${firstLine(w.question.text)}`, act: 'Answer' };
    case 'run': return { what: `Sandbox run on ${w.card.template}${w.card.waits.template ? ', with its template' : ''} waits for approval`, act: 'Approve' };
    case 'grant': return { what: `Vault grant: ${w.ask.names.join(', ') || 'the vault'}`, act: 'Grant' };
    case 'credential': return { what: `Credential: ${w.request.title}`, act: 'Give' };
    case 'review': return { what: w.review === 'proposal' ? 'Proposal: pick a path' : 'Research report: accept or steer it', act: w.review === 'proposal' ? 'Pick a path' : 'Decide' };
    case 'handoff': return { what: `Handed off to a person: ${firstLine(w.handoff.card.whatHappened)}`, act: 'Resolve' };
    case 'login': return { what: `Login: ${w.login.tool}`, act: 'Log in' };
    case 'gate': return { what: 'Held at the blast-radius gate', act: 'Let through' };
    case 'hold': return { what: 'Held for a person to approve', act: 'Approve' };
    case 'text-change': return { what: 'Its issue text changed since it started', act: 'Decide' };
    case 'accept': return { what: 'Waits at the queue gate to be accepted', act: 'Accept in Queue' };
    case 'origin': return { what: 'Its issue waits as a request card in Intake', act: 'Approve in Intake' };
    case 'wait': return { what: 'Waits on something a person does', act: 'Continue' };
  }
}

const firstLine = (text: string): string => {
  const line = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

/** The job's events, newest first: the newest `n`. */
export const lastActions = (events: readonly DomainEvent[], jobId: string, n = 4): DomainEvent[] =>
  events.filter((e) => e.jobId === jobId).sort((a, b) => b.seq - a.seq).slice(0, n);

/**
 * The job's current step in plain words, and since when (ISO). What it waits on when it waits; why it is held when it is
 * held; its newest event, said by `describe`, while it works; how it ended when it ended.
 */
export function currentStep(job: Job, events: readonly DomainEvent[], describe: (e: DomainEvent) => string, question?: QuestionView): { text: string; since: string } {
  const newest = lastActions(events, job.id, 1)[0];
  if (hasEnded(job)) return { text: job.status === 'failed' && job.error ? `failed: ${firstLine(job.error)}` : job.status, since: job.finishedAt ?? job.updatedAt };
  if (job.status === 'waiting_answer' && question) return { text: `asks: ${firstLine(question.text)}`, since: question.createdAt };
  if (job.status === 'waiting_on' && job.wait) return { text: `waits for ${firstLine(job.wait.for)}`, since: job.wait.since };
  if (job.status === 'held') return { text: job.holdReason ? `held: ${firstLine(job.holdReason)}` : 'held', since: job.updatedAt };
  if (job.status === 'queued') return { text: job.waitReason ? firstLine(job.waitReason) : 'waits in the queue', since: job.createdAt };
  if (job.status === 'parked') return { text: 'parked', since: job.parked?.at ?? job.updatedAt };
  if (newest) return { text: describe(newest), since: newest.at };
  return { text: job.progressMessage ? firstLine(job.progressMessage) : job.status === 'claimed' ? 'starting' : job.status, since: job.startedAt ?? job.updatedAt };
}

/** The sandboxes the job runs on: the templates of its sandbox requests that a person or a policy approved. */
export const sandboxesOf = (job: Pick<Job, 'id'>, vault: VaultView | null): string[] =>
  [...new Set((vault?.sandboxRequests ?? []).filter((r) => r.jobId === job.id && r.state === 'approved').map((r) => r.template))];

/** The browser notification for a job that needs a person: its title, and what it waits on. */
export const attentionNotice = (title: string, waits: readonly TrackerWait[]): { title: string; body: string } => ({
  title: `Critical job needs you: ${title}`,
  body: waits.map((w) => waitText(w).what).join('\n'),
});
