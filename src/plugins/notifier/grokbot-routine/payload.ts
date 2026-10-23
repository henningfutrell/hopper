// The Grok Bot routine's JSON bodies (design.md "Grok Bot routine webhook"). A question's body carries
// what the job already knows (issue #378), so the receiver can route and rank it without calling back
// into the hopper: the machine (its id and name) and lane that raised it (issue #485: the question's own
// snapshot, not where its job is now), the priority and whether it is high priority (issue #535), the issue's labels, repo and number, what
// detected the question, and how long it has been open. The question is the agent's Markdown source (issue #569), led by
// its TL;DR when it is long. A login (issue #698) carries what asks and what waits, never its URL or code.
// A direct job's notice (issue #901) names the direct job and its submitter, the person who submitted it, so the receiver
// tells that person.
import { DIRECT_SOURCE } from '../../../domain/direct-jobs.ts';
import { BLOCKED_WORDS, type BlockedCause } from '../../../domain/item-lifecycle.ts';
import type { DomainEvent, InfraPlanNotice, Job, Question } from '../../sdk.ts';

/** A direct job's id and submitter; nothing for a job of any other source. */
const directOf = (job: Job | undefined) => {
  const s = job?.source;
  if (s?.kind !== DIRECT_SOURCE || !s.key.startsWith(`${DIRECT_SOURCE}:`)) return {};
  return { directJob: s.key.slice(DIRECT_SOURCE.length + 1), submitter: s.author ?? null };
};

const base = (kind: string, at: string, job: Job | undefined, jobId: string | undefined) => ({
  source: 'hopper', kind, at, jobId: jobId ?? null, ...directOf(job), issueTitle: job?.source?.title ?? null, issueUrl: job?.source?.url ?? null,
});

export interface QuestionBody {
  question: Question;
  job: Job | undefined;
  answerUrl: string | undefined;
  at: string;
  now: Date;
  /** True: sent from the open questions (when the routine became configured, or Send open questions), not as it escalated. */
  offered: boolean;
  /** The high-priority threshold (issue #535); absent: not known, and `high` is null. */
  highPriority?: number | undefined;
  /** What the body leads with (issue #569): the question's TL;DR, else the agent's own summary; absent: none (a short question). */
  tldr?: string | undefined;
}

/** A question that reached the human. */
export function questionPayload(b: QuestionBody): Record<string, unknown> {
  const { question: q, job } = b;
  const raised = q.raisedBy;
  return {
    ...base('question.escalated_to_human', b.at, job, q.jobId),
    // Plain text, one or two sentences (issue #569): the receiver shows it first, the question behind it.
    ...(b.tldr ? { tldr: b.tldr } : {}),
    // The agent's text as written, Markdown (issue #569): the receiver renders it as the UI does.
    question: q.text, questionFormat: 'markdown', questionId: q.id, ...(b.answerUrl ? { answerUrl: b.answerUrl } : {}),
    machineId: raised?.machineId ?? null, machineName: raised?.name ?? null, laneId: raised?.laneId ?? null, priority: job?.priority ?? null,
    high: job && b.highPriority !== undefined ? job.priority >= b.highPriority : null,
    labels: job?.source?.labels ?? null, repo: job?.source?.repo ?? null, issueNumber: job?.source?.number ?? null,
    detectedBy: q.detectedBy, askedAt: q.createdAt, escalatedAt: q.escalatedToHumanAt ?? null,
    openSeconds: Math.max(0, Math.floor((b.now.getTime() - Date.parse(q.createdAt)) / 1000)),
    offered: b.offered,
    // Issue #376: a dialog the agent denies by itself at this time, unless it is answered first.
    ...(q.lapsesAt ? { lapsesAt: q.lapsesAt } : {}),
  };
}

/**
 * A stop of intake (issue #358), a request card waiting for approval (issue #798), a blocked work item (issue #1891), an out-of-band change (issue #871), a machine low on free memory (issue #868), or a machine over its disk budget (issue #1203). `source` is the sender (the hopper):
 * the job source's name goes as `sourceName`.
 */
export function intakePayload(e: DomainEvent, job: Job | undefined, infraUrl?: string): Record<string, unknown> {
  const b = base(e.type, e.at, job, e.jobId);
  if (e.type === 'source.stalled') return { ...b, sourceName: e.data.source, error: e.data.error, since: e.data.since };
  if (e.type === 'connected_account.expired') return { ...b, provider: e.data.provider, account: e.data.account, reason: e.data.reason };
  if (e.type === 'source.request_opened') return { ...b, sourceName: e.data.source, issueUrl: e.data.key, author: e.data.author, why: e.data.why };
  // A blocked work item that waits on a person (issue #1891): why, in plain words, and the pull request it names.
  if (e.type === 'work_item.person_asked') {
    const d = e.data as { key: string; cause: BlockedCause; pullRequest?: string };
    return { ...b, issueUrl: d.key, cause: d.cause, waitingOn: BLOCKED_WORDS[d.cause], pullRequest: d.pullRequest ?? null };
  }
  // An out-of-band infrastructure change (issue #871): never silent. `signal` is where it was found; `source` stays the sender;
  // `infraUrl` is the Infra page, where a person marks it.
  if (e.type === 'infra.out_of_band_recorded') {
    const d = e.data as { change: string; source: string; target: string; what: string; who?: string; at: string };
    return { ...b, change: d.change, signal: d.source, target: d.target, what: d.what, who: d.who ?? null, happenedAt: d.at, ...(infraUrl ? { infraUrl } : {}) };
  }
  // A machine low on free memory, and back (issue #868): its free memory, whose (`windows` or `machine`), the threshold.
  if (e.type === 'machine.memory_low' || e.type === 'machine.memory_recovered') {
    const d = e.data as { machineId: string; of: string; freeBytes: number; totalBytes: number; thresholdBytes: number; since?: string };
    return { ...b, machineId: d.machineId, of: d.of, freeBytes: d.freeBytes, totalBytes: d.totalBytes, thresholdBytes: d.thresholdBytes, ...(d.since ? { since: d.since } : {}) };
  }
  // The hopper's own disk use on a machine over the disk budget, and back within it (issue #1203): what it uses, the budget, and
  // for an over the places that use it.
  if (e.type === 'machine.disk_over_budget' || e.type === 'machine.disk_within_budget') {
    const d = e.data as { machineId: string; usedBytes: number; budgetBytes: number; paths?: { path: string; bytes: number }[] };
    return { ...b, machineId: d.machineId, usedBytes: d.usedBytes, budgetBytes: d.budgetBytes, ...(d.paths ? { paths: d.paths } : {}) };
  }
  // A machine offline for two minutes, and back (issue #1497): its id, its name, since when it is offline.
  if (e.type === 'machine.offline' || e.type === 'machine.back_online') {
    const d = e.data as { machineId: string; label: string; since: string };
    return { ...b, machineId: d.machineId, label: d.label, since: d.since };
  }
  // A drained machine idle with a backlog (issue #2499): the drain's end and reason, its free lanes, the jobs queued.
  if (e.type === 'machine.drained_idle') {
    const d = e.data as { machineId: string; label: string; since: string; drainedAt: string; until: string; reason?: string; freeLanes: number; queued: number };
    return { ...b, machineId: d.machineId, label: d.label, since: d.since, drainedAt: d.drainedAt, until: d.until, ...(d.reason ? { reason: d.reason } : {}), freeLanes: d.freeLanes, queued: d.queued };
  }
  return b;
}

/**
 * A plan of an infrastructure change (issue #870 part 4): kept (`infra.plan_recorded`), approved (`infra.plan_approved`),
 * or applied (`infra.plan_applied`, from a `vault.minted` that names it). What it changes, where, its risk, who approves
 * it, and `watchers`, the names the receiver tells: the watchers of the plan's environments. Never the plan's text or
 * file, and never the credential or the machine of an apply. `infraUrl` is the Infra page.
 */
export function planPayload(e: DomainEvent, job: Job | undefined, notice: InfraPlanNotice | undefined, infraUrl: string | undefined): Record<string, unknown> {
  const kind = e.type === 'vault.minted' ? 'infra.plan_applied' : e.type;
  const d = e.data as { plan: string; by?: string; auto?: true; operation?: string; expiresAt?: string };
  const { approval: _approval, issue: _issue, ...plan } = notice ?? { plan: d.plan, risks: [], environments: [], watchers: [] };
  return {
    ...base(kind, e.at, job, e.jobId), ...plan,
    ...(e.type === 'infra.plan_approved' ? { approvedBy: d.by ?? null, ...(d.auto ? { auto: true } : {}) } : {}),
    ...(e.type === 'vault.minted' ? { operation: d.operation, expiresAt: d.expiresAt } : {}),
    ...(infraUrl ? { infraUrl } : {}),
  };
}

/** A new artifact (issue #673): what a job made for the person to see, and where they open it. */
export function artifactPayload(e: DomainEvent, job: Job | undefined, url: string | undefined): Record<string, unknown> {
  const d = e.data as { artifact: string; title: string; type: string; size: number; issue?: string };
  return {
    ...base(e.type, e.at, job, e.jobId), artifactId: d.artifact, title: d.title, type: d.type, size: d.size,
    ...(d.issue ? { issueUrl: d.issue } : {}), ...(url ? { url } : {}),
  };
}

/** A job's end (issue #795): what it came to, so Grok Bot is woken by it instead of polling. */
export function jobPayload(e: DomainEvent, job: Job | undefined): Record<string, unknown> {
  const d = e.data as { result?: unknown; partlyDone?: string; error?: string };
  return {
    ...base(e.type, e.at, job, e.jobId), repo: job?.source?.repo ?? null, issueNumber: job?.source?.number ?? null, priority: job?.priority ?? null,
    ...(e.type === 'job.failed' ? { error: d.error ?? null } : { result: d.result ?? null, ...(d.partlyDone ? { partlyDone: d.partlyDone } : {}) }),
  };
}

/**
 * Where the hopper is reached from outside (issues #795, #880): the remote access URL while the tunnel is up, where an agent
 * exchanges its sign-in for an API token there, and where it trades a grant's refresh token (issue #881). `reason`: start,
 * change (a new URL), recovery (up again after down), heartbeat. Sent
 * again every `heartbeatSeconds`: a receiver that hears none for longer holds the URL as stale.
 */
export function reachablePayload(url: string, reason: 'start' | 'change' | 'recovery' | 'heartbeat', at: string, heartbeatMs: number): Record<string, unknown> {
  return { source: 'hopper', kind: 'hopper.reachable', at, reason, url, apiTokenUrl: `${url}/ui/auth/api-token`, tokenRefreshUrl: `${url}/ui/auth/token/refresh`, heartbeatSeconds: heartbeatMs / 1000 };
}

/**
 * Send test event (issue #378): marked `test: true`, so a receiver can tell it from a question. Its kind is a
 * question's (issue #481), so the receiver's routing takes the same path as for a real one.
 */
export function testPayload(at: string): Record<string, unknown> {
  return { source: 'hopper', kind: 'question.escalated_to_human', test: true, at, message: 'Test event from the hopper: the routine URL and key work.' };
}

/**
 * A login a job or run waits on (issue #698): `auth.pending` (a new code too) or `auth.expired`. What asks — the tool
 * and the host of its page —, what waits — the job and its issue, the machine and lane —, and when the code runs out,
 * with the Logins view's link. Never the URL to open or the code: they stay in the hopper, for a UI session of the user.
 */
export function loginPayload(e: DomainEvent, job: Job | undefined, now: Date, loginsUrl: string | undefined): Record<string, unknown> {
  const d = e.data as { loginId: string; tool: string; host?: string; run?: string; expiresAt: string; renewed?: boolean; questionId?: string; priority?: number; high?: boolean };
  return {
    ...base(e.type, e.at, job, e.jobId), loginId: d.loginId, tool: d.tool, ...(d.host ? { host: d.host } : {}), ...(d.run ? { run: d.run } : {}),
    ...(d.questionId ? { questionId: d.questionId } : {}), ...(d.renewed ? { renewed: true } : {}),
    machineId: e.machineId ?? null, laneId: e.laneId ?? null, priority: d.priority ?? job?.priority ?? null, high: d.high ?? null,
    repo: job?.source?.repo ?? null, issueNumber: job?.source?.number ?? null,
    expiresAt: d.expiresAt, expiresInSeconds: Math.max(0, Math.floor((Date.parse(d.expiresAt) - now.getTime()) / 1000)),
    ...(loginsUrl ? { loginsUrl } : {}),
  };
}

/**
 * A new run card (issue #2197 part 2): a job's sandbox run, or its ask that waits on a template, waits for one approval
 * of a person. The job and why it asks, what the approval approves (`waits`), the job's priority and whether it is high
 * (so the receiver ranks it), and the Access requests link. Never the template's secrets, profiles or plan.
 */
export function runCardPayload(e: DomainEvent, job: Job | undefined, highPriority: number | undefined, accessUrl: string | undefined): Record<string, unknown> {
  const d = e.data as { template: string; waits: { template: boolean; run: boolean }; purpose?: string };
  return {
    ...base(e.type, e.at, job, e.jobId), repo: job?.source?.repo ?? null, issueNumber: job?.source?.number ?? null, priority: job?.priority ?? null,
    high: job && highPriority !== undefined ? job.priority >= highPriority : null,
    template: d.template, waits: d.waits, ...(d.purpose ? { purpose: d.purpose } : {}), ...(accessUrl ? { accessUrl } : {}),
  };
}
