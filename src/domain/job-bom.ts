// A job's parts list, its BOM (issue #935, design.md "A job's parts list"): everything one job touched or made, grouped —
// what was asked, the work, the code, the outputs, the infra, the decisions, the machines —, each part with its status
// and the page it opens. A header in plain words (what was asked, where it stands, what is next), a one-line summary, and
// the job's events, newest first, for its timeline. What waits on the person comes first. Pure: no I/O, no clock — the
// route reads the job, its events, questions, hand-off, artifacts and the jobs that ran it again, and passes `now` in.
import type { Artifact } from './artifacts.ts';
import type { Handoff } from './failures.ts';
import { issueNodeId, jobNodeId, pullRequestNodeId, pullRequestOf, stageOf } from './job-graph.ts';
import { nextWords, stageWords, waitsOnYou, type Worded } from './job-words.ts';
import { phaseOf } from './phase.ts';
import type { Question } from './questions.ts';
import type { DomainEvent, Job } from './types.ts';

/** The groups of a parts list, in the order it shows them. */
export const BOM_GROUPS = ['asked', 'work', 'code', 'outputs', 'infra', 'decisions', 'machines'] as const;
export type BomGroup = typeof BOM_GROUPS[number];

/** Where a part stands: it waits on the person, it runs, it is open, done, failed, cancelled, or only a record. */
export const BOM_STATUSES = ['waiting_on_you', 'running', 'open', 'done', 'failed', 'cancelled', 'recorded'] as const;
export type BomStatus = typeof BOM_STATUSES[number];

/** One part of a job: what it is, where it stands, and the page it opens (`href`, in the UI) or its place on GitHub (`url`). */
export interface BomPart {
  /** Stable within the job: `issue:<owner/name>#<n>`, `pr:<url>`, `question:<id>`, `artifact:<id>`, `run:<n>`, `tasks`… */
  id: string;
  group: BomGroup;
  kind: string;
  label: string;
  status: BomStatus;
  detail?: string;
  at?: string;
  href?: string;
  url?: string;
}

export interface JobBom {
  jobId: string;
  header: { asked: string; stands: string; next: string };
  summary: string;
  parts: BomPart[];
  /** The job's events, newest first: its timeline. */
  events: DomainEvent[];
}

export interface JobBomInput {
  job: Job;
  /** The job's events, in any order. Infra plan approvals of its plans may come with no job. */
  events: readonly DomainEvent[];
  questions: readonly Question[];
  handoff?: Handoff;
  artifacts: readonly Artifact[];
  /** The jobs that ran this one again, or forked from it. */
  related: readonly Job[];
  now: string;
}

type Data = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const assetText = (a: unknown): string => { const x = (a ?? {}) as Data; return [str(x.kind), str(x.name)].filter(Boolean).join(' ') || 'an asset'; };
const PR_NUMBER = /\/pull\/(\d+)/;

/** A span in hours and minutes: `2h`, `1h 5m`, `12m`, `under a minute`. */
export function spanText(fromIso: string, toIso: string): string {
  const min = Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  if (min < 1) return 'under a minute';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

const JOB_STATUS: Record<ReturnType<typeof stageOf>, BomStatus> = {
  queued: 'open', running: 'running', waiting: 'open', pr_open: 'open', partly_done: 'open', done: 'done', failed: 'failed', cancelled: 'cancelled', no_job: 'open',
};

/** What was asked: the issue, the follow-ups the job filed, rework and a changed spec. */
function asked(job: Job, events: readonly DomainEvent[]): BomPart[] {
  const out: BomPart[] = [];
  const s = job.source;
  if (s?.repo && s.number !== undefined) {
    out.push({ id: issueNodeId(s.repo, s.number), group: 'asked', kind: 'issue', label: s.title || job.spec.goal || `${s.repo}#${s.number}`, status: 'recorded', detail: `${s.repo}#${s.number}`, ...(s.url ? { url: s.url } : {}) });
  }
  for (const e of events) {
    const d = e.data as Data;
    if (e.type === 'job.child_issue_filed') {
      const c = (d.child ?? {}) as Data;
      if (typeof c.repo !== 'string' || typeof c.number !== 'number') continue;
      out.push({ id: issueNodeId(c.repo, c.number), group: 'asked', kind: 'follow_up', label: `${d.required ? 'Required part' : 'Follow-up'} ${c.repo}#${c.number}`, status: 'recorded', at: e.at, ...(str(c.url) ? { url: str(c.url)! } : {}) });
    } else if (e.type === 'job.rework_requested') {
      out.push({ id: `scope:${e.seq}`, group: 'asked', kind: 'scope', label: 'Rework asked', status: 'recorded', at: e.at, ...(str(d.notes) ? { detail: str(d.notes)! } : {}) });
    } else if (e.type === 'job.respecified') {
      out.push({ id: `scope:${e.seq}`, group: 'asked', kind: 'scope', label: 'What it does was changed', status: 'recorded', at: e.at });
    }
  }
  return out;
}

/** The work: each run, the task list, the lane, the time it took, the runs after it; and the machines it ran on. */
function work(job: Job, events: readonly DomainEvent[], related: readonly Job[], now: string): BomPart[] {
  const out: BomPart[] = [];
  const stage = stageOf(job);
  const starts = events.filter((e) => e.type === 'job.started');
  starts.forEach((e, i) => {
    const n = typeof (e.data as Data).attempts === 'number' ? (e.data as Data).attempts as number : i + 1;
    const last = i === starts.length - 1;
    out.push({ id: `run:${n}`, group: 'work', kind: 'run', label: `Run ${n}`, status: last ? JOB_STATUS[stage] : 'done', at: e.at });
  });
  out.reverse();
  if (job.tasks) out.push({ id: 'tasks', group: 'work', kind: 'tasks', label: `${job.tasks.done} of ${job.tasks.total} tasks done`, status: job.tasks.done >= job.tasks.total ? 'done' : stage === 'running' ? 'running' : JOB_STATUS[stage] });
  if (job.laneId) out.push({ id: 'lane', group: 'work', kind: 'lane', label: job.laneId, status: 'recorded' });
  if (job.startedAt) {
    const ended = job.finishedAt;
    out.push({ id: 'time', group: 'work', kind: 'time', label: ended ? `Took ${spanText(job.startedAt, ended)}` : `${spanText(job.startedAt, now)} running so far`, status: 'recorded' });
  }
  for (const r of [...related].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const kind = r.rerunOf === job.id ? (job.partlyDone ? 'next_part' : 'rerun') : 'fork';
    const label = kind === 'next_part' ? 'Next part' : kind === 'rerun' ? 'Run again' : 'Branched off';
    out.push({ id: jobNodeId(r.id), group: 'work', kind, label: `${label}: ${r.spec.goal || r.id}`, status: JOB_STATUS[stageOf(r)], at: r.createdAt, href: `#job/${encodeURIComponent(r.id)}` });
  }
  const machines = new Map<string, number>();
  for (const e of events) if (e.type === 'job.claimed' && e.machineId) machines.set(e.machineId, (machines.get(e.machineId) ?? 0) + 1);
  for (const [m, runs] of machines) out.push({ id: `machine:${m}`, group: 'machines', kind: 'machine', label: m, status: 'recorded', detail: `${runs} ${runs === 1 ? 'run' : 'runs'}`, href: '#machines' });
  for (const e of events) {
    const d = e.data as Data;
    if (e.type === 'step.started') out.push({ id: `step:${str(d.step) ?? e.seq}`, group: 'machines', kind: 'step', label: `Windows step on ${str(d.host) ?? 'a host'}`, status: 'recorded', at: e.at, ...(str(d.command) ? { detail: str(d.command)! } : {}) });
  }
  return out;
}

/** The code: the pull request, its checks, its branch and its merge. */
function code(job: Job, events: readonly DomainEvent[]): BomPart[] {
  const out: BomPart[] = [];
  const pr = pullRequestOf(job);
  if (pr) {
    const n = PR_NUMBER.exec(pr.url)?.[1];
    const status: BomStatus = pr.state === 'merged' ? 'done' : pr.state === 'closed' || pr.state === 'abandoned' ? 'cancelled' : 'open';
    out.push({ id: pullRequestNodeId(pr.url), group: 'code', kind: 'pull_request', label: n ? `Pull request #${n}` : 'Pull request', status, detail: stageWords({ kind: 'pull_request', stage: 'pr_open', pullRequest: { url: pr.url, state: pr.state, ...(pr.draft ? { draft: true } : {}), ...(pr.conflicting ? { conflicting: true } : {}) } }), url: pr.url, href: '#pull-requests' });
    if (pr.checks) {
      const ch = pr.checks;
      out.push({ id: 'checks', group: 'code', kind: 'checks', label: ch === 'none' ? 'No checks' : `Checks ${ch}`, status: ch === 'passing' ? 'done' : ch === 'failing' ? 'failed' : ch === 'none' ? 'recorded' : 'running' });
    }
    if (pr.headRef) out.push({ id: 'branch', group: 'code', kind: 'branch', label: pr.headRef, status: 'recorded', ...(pr.base ? { detail: `into ${pr.base}` } : {}) });
  }
  for (const e of events) {
    const d = e.data as Data;
    if (e.type === 'job.pull_request_merged') out.push({ id: `merge:${e.seq}`, group: 'code', kind: 'merge', label: d.byHopper ? 'Merged by the hopper' : 'Merged', status: 'done', at: e.at, ...(str(d.pullRequest) ? { url: str(d.pullRequest)! } : {}) });
    if (e.type === 'job.pull_request_closed') out.push({ id: `merge:${e.seq}`, group: 'code', kind: 'merge', label: 'Closed without a merge', status: 'cancelled', at: e.at });
  }
  return out;
}

/** The outputs: artifacts and their revisions, and its proposal or research report. */
function outputs(job: Job, events: readonly DomainEvent[], artifacts: readonly Artifact[]): BomPart[] {
  const out: BomPart[] = [];
  for (const a of artifacts) {
    const rev = (a as Artifact & { revision?: number }).revision;
    out.push({ id: `artifact:${a.id}`, group: 'outputs', kind: 'artifact', label: a.title, status: 'done', at: a.createdAt, href: `#artifacts/${a.id}`, ...(rev ? { detail: `revision ${rev}` } : {}) });
  }
  for (const e of events) {
    const d = e.data as Data;
    if (e.type !== 'artifact.revised' || typeof d.revision !== 'number' || typeof d.artifact !== 'string') continue;
    out.push({ id: `artifact:${d.artifact}/${d.revision}`, group: 'outputs', kind: 'revision', label: `${str(d.title) ?? 'Artifact'}: revision ${d.revision}`, status: 'done', at: e.at, href: `#artifacts/${d.artifact}/${d.revision}`, ...(str(d.note) ? { detail: str(d.note)! } : {}) });
  }
  const waiting = job.status === 'waiting_answer' && !job.questionId;
  if (job.proposalId) out.push({ id: `proposal:${job.proposalId}`, group: 'outputs', kind: 'report', label: 'Plan', status: waiting ? 'waiting_on_you' : 'done', href: '#proposals', ...(waiting ? { detail: 'waits for you to approve it' } : {}) });
  if (job.researchId) out.push({ id: `research:${job.researchId}`, group: 'outputs', kind: 'report', label: 'Research report', status: waiting ? 'waiting_on_you' : 'done', href: '#research', ...(waiting ? { detail: 'waits for you to accept it' } : {}) });
  return out;
}

/** The infra: plans and their approvals, minted credentials with their scopes, drift it found, vault grants it asked for. */
function infra(events: readonly DomainEvent[]): BomPart[] {
  const out: BomPart[] = [];
  const approved = new Map(events.filter((e) => e.type === 'infra.plan_approved').map((e) => [str((e.data as Data).plan), e]));
  const granted = events.some((e) => e.type === 'vault.granted');
  for (const e of events) {
    const d = e.data as Data;
    if (e.type === 'infra.plan_recorded') {
      const ok = approved.get(str(d.plan));
      out.push({ id: `plan:${str(d.plan)}`, group: 'infra', kind: 'plan', label: `${str(d.tool) ?? 'infra'} plan for ${str(d.target) ?? assetText(d.asset)}`, status: ok ? 'done' : 'waiting_on_you', detail: ok ? 'approved' : 'waits for an admin to approve it', at: e.at, href: '#infra' });
    } else if (e.type === 'vault.minted') {
      out.push({ id: `credential:${str(d.credential) ?? e.seq}`, group: 'infra', kind: 'credential', label: `${str(d.operation) ?? 'a'} credential for ${assetText(d.asset)}`, status: 'recorded', at: e.at, ...(str(d.expiresAt) ? { detail: `until ${str(d.expiresAt)}` } : {}) });
    } else if (e.type === 'infra.out_of_band_recorded') {
      out.push({ id: `drift:${str(d.change) ?? e.seq}`, group: 'infra', kind: 'drift', label: `Drift: ${str(d.target) ?? 'infrastructure'}`, status: 'open', at: e.at, href: '#infra', ...(str(d.what) ? { detail: str(d.what)! } : {}) });
    } else if (e.type === 'vault.grant_asked') {
      out.push({ id: 'grant', group: 'infra', kind: 'grant', label: 'Vault grant asked', status: granted ? 'done' : 'waiting_on_you', at: e.at, href: '#settings/vault', ...(str(d.name) ? { detail: str(d.name)! } : {}) });
    }
  }
  return out;
}

/** The decisions: each question and who answered it, the overrides of a minor decision, the hand-off. */
function decisions(questions: readonly Question[], events: readonly DomainEvent[], handoff: Handoff | undefined): BomPart[] {
  const out: BomPart[] = [];
  for (const q of [...questions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const open = q.status === 'open';
    const by = q.answeredBy === 'human' ? 'a person' : q.answeredBy;
    out.push({
      id: `question:${q.id}`, group: 'decisions', kind: 'question', label: q.text, at: q.createdAt, href: open ? '#questions' : '#questions/history',
      status: open ? 'waiting_on_you' : q.status === 'answered' ? 'done' : 'cancelled',
      ...(q.answer !== undefined && by ? { detail: `answered by ${by}: ${q.answer}` } : !open ? { detail: q.status } : {}),
    });
  }
  for (const e of events) {
    const d = e.data as Data;
    if (e.type === 'minor_decision.overridden') out.push({ id: `override:${e.seq}`, group: 'decisions', kind: 'override', label: `Override: ${str(d.point) ?? 'a decision'}`, status: 'recorded', at: e.at, detail: `${str(d.pick) ?? '?'} → ${str(d.actual) ?? '?'}`, href: '#decisions' });
  }
  if (handoff) out.push({ id: `handoff:${handoff.id}`, group: 'decisions', kind: 'handoff', label: handoff.summary, status: handoff.status === 'open' ? 'waiting_on_you' : 'done', at: handoff.openedAt, href: '#failures' });
  return out;
}

const RANK = new Map<BomGroup, number>(BOM_GROUPS.map((g, i) => [g, i]));

/** The job's parts list. Deterministic: the same input gives the same parts, in the same order. */
export function jobBom(input: JobBomInput): JobBom {
  const { job, now } = input;
  const events = [...input.events].sort((a, b) => a.seq - b.seq);
  const own = events.filter((e) => e.jobId === job.id || e.jobId === undefined);
  const parts = [
    ...asked(job, own), ...work(job, own, input.related, now), ...code(job, own), ...outputs(job, own, input.artifacts),
    ...infra(own), ...decisions(input.questions, own, input.handoff),
  ];
  const ordered = parts.map((p, i) => ({ p, i }))
    .sort((a, b) => Number(b.p.status === 'waiting_on_you') - Number(a.p.status === 'waiting_on_you') || RANK.get(a.p.group)! - RANK.get(b.p.group)! || a.i - b.i)
    .map(({ p }) => p);
  const stage = stageOf(job);
  const phase = phaseOf(job);
  const pr = pullRequestOf(job);
  const worded: Worded = { kind: 'job', stage, status: job.status, ...(phase !== 'work' ? { phase } : {}), ...(pr ? { pullRequest: pr } : {}) };
  const s = job.source;
  const title = s?.title || job.spec.goal || job.id;
  return {
    jobId: job.id,
    header: { asked: s?.repo && s.number !== undefined ? `${title} (${s.repo}#${s.number})` : title, stands: stageWords(worded), next: nextWords(worded, job.tasks) },
    summary: summaryOf(ordered, waitsOnYou(worded)),
    parts: ordered,
    events: events.filter((e) => e.jobId === job.id).reverse(),
  };
}

/** The parts list in one line: "3 of 5 parts done, 1 running, 1 waiting on you." Records are not counted. */
function summaryOf(parts: readonly BomPart[], jobWaits: boolean): string {
  const counted = parts.filter((p) => p.status !== 'recorded');
  const n = (s: BomStatus) => counted.filter((p) => p.status === s).length;
  const waiting = Math.max(n('waiting_on_you'), jobWaits ? 1 : 0);
  const bits = [`${n('done')} of ${counted.length} parts done`];
  if (n('running')) bits.push(`${n('running')} running`);
  if (n('failed')) bits.push(`${n('failed')} failed`);
  bits.push(waiting ? `${waiting} waiting on you` : 'nothing waiting on you');
  return `${bits.join(', ')}.`;
}
