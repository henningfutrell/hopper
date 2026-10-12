// The Grok Bot routine's JSON bodies (design.md "Grok Bot routine webhook"). A question's body carries
// what the job already knows (issue #378), so the receiver can route and rank it without calling back
// into the hopper: the machine (its id and name) and lane that raised it (issue #485: the question's own
// snapshot, not where its job is now), the priority and whether it is high priority (issue #535), the issue's labels, repo and number, what
// detected the question, and how long it has been open. The question is the agent's Markdown source (issue #569), led by
// its TL;DR when it is long. A login (issue #698) carries what asks and what waits, never its URL or code.
import type { DomainEvent, Job, Question } from '../../sdk.ts';

const base = (kind: string, at: string, job: Job | undefined, jobId: string | undefined) => ({
  source: 'hopper', kind, at, jobId: jobId ?? null, issueTitle: job?.source?.title ?? null, issueUrl: job?.source?.url ?? null,
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
 * A stop of intake (issue #358), a request card waiting for approval (issue #798), or an out-of-band change (issue #871). `source` is the sender (the hopper):
 * the job source's name goes as `sourceName`.
 */
export function intakePayload(e: DomainEvent, job: Job | undefined, infraUrl?: string): Record<string, unknown> {
  const b = base(e.type, e.at, job, e.jobId);
  if (e.type === 'source.stalled') return { ...b, sourceName: e.data.source, error: e.data.error, since: e.data.since };
  if (e.type === 'connected_account.expired') return { ...b, provider: e.data.provider, account: e.data.account, reason: e.data.reason };
  if (e.type === 'source.request_opened') return { ...b, sourceName: e.data.source, issueUrl: e.data.key, author: e.data.author, why: e.data.why };
  // An out-of-band infrastructure change (issue #871): never silent. `signal` is where it was found; `source` stays the sender;
  // `infraUrl` is the Infra page, where a person marks it.
  if (e.type === 'infra.out_of_band_recorded') {
    const d = e.data as { change: string; source: string; target: string; what: string; who?: string; at: string };
    return { ...b, change: d.change, signal: d.source, target: d.target, what: d.what, who: d.who ?? null, happenedAt: d.at, ...(infraUrl ? { infraUrl } : {}) };
  }
  return b;
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
