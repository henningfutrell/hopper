// The engine's side of review sections (issues #537, #543, design.md "Sections"). A job whose agent comes back with a
// proposal or a research report waits on it (waiting_answer, no question), as on a question: it holds no lane, its
// pane stays, it can be parked. Sent back, the job is re-queued with what to do next, and its next document is the
// next version. Accepted, a job that asks for a further section (research, then the proposal: REVIEW_KINDS) is
// re-queued, told to write that next, in the same session. A job that was not asked for the item — its agent wrote it
// because its own item asked for it within the work — is told it was accepted and, where the type goes on (research:
// issue #538, open decision D2), goes on in the same session: with the rest of its work, or it ends done, by its own outcome. Otherwise, accepted or
// rejected, the job ends `finished` with every decision it reached as its result — what an accepted item becomes is
// decided later (it stays linked to the job and its item). The handlers run inside the review service's tx.
import type { ExecutionReport } from '../domain/ports.ts';
import { raisedBy } from '../domain/raised-by.ts';
import {
  asksOfSpec, REVIEW_KINDS, REVIEW_SECTIONS, reviewSections, type EventType,
  type Job, type Lane, type LaneId, type MachineSnapshot, type ReviewItem, type ReviewKind, type ReviewVersion,
} from '../domain/types.ts';
import type { Cleanup } from './cleanup.ts';
import { nowIso, priorityTagOf, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import { afterSwitch, resolveFork } from './phase-shifts.ts';

/** The job's review items, by kind, that it has. */
export function itemsOfJob(c: EngineContext, job: Job): ReviewItem[] {
  return REVIEW_KINDS.flatMap((k) => {
    const id = job[REVIEW_SECTIONS[k].jobField];
    const item = id ? c.store.reviews[k].get(id) : undefined;
    return item ? [item] : [];
  });
}

/** The job's open review item, if it waits on one. */
export const openItemOf = (c: EngineContext, job: Job): ReviewItem | undefined => itemsOfJob(c, job).find((p) => p.status === 'open');

/** The job's result once its last review item is decided: each decision it reached, by kind. */
export const decidedResult = (items: readonly ReviewItem[]) =>
  Object.fromEntries(items.filter((p) => p.signOff).map((p) => [p.kind, { id: p.id, version: p.signOff!.version, decision: p.signOff!.decision }]));

/** Inside the tx recording the outcome: the job's item (a new one, or the next version of one sent back), and the job waiting on it. */
export function recordReport(c: EngineContext, job: Job, lane: Lane | undefined, laneId: LaneId, machine: MachineSnapshot | undefined, kind: ReviewKind, report: ExecutionReport, at: string): { kind: ReviewKind; itemId: string } {
  const { store } = c;
  const type = REVIEW_SECTIONS[kind];
  const items = store.reviews[kind];
  const currentId = job[type.jobField];
  const current = currentId ? items.get(currentId) : undefined;
  const version = (number: number): ReviewVersion => ({ number, text: report.text, ...reviewSections(kind, report.text), recentOutput: report.recentOutput, at });
  const stage = c.reviews[kind].firstStage();
  let p: ReviewItem;
  if (current?.status === 'revising') {
    items.addVersion(current.id, version(current.versions.length + 1));
    p = items.update(current.id, { status: 'open', stage });
  } else {
    const raised = raisedBy({ laneId, resumeOn: job.resumeOn, pin: job.spec.machineId, machines: new Map(machine ? [[machine.id, machine.label]] : []) });
    // A fork's item came from its parent's item (issue #548); one written in a switched phase, from the job's question.
    const from = job.source ?? job.forkOf?.source;
    const source = from ? { key: from.key, url: from.url, title: from.title } : undefined;
    p = items.create({
      jobId: job.id, stage, version: version(1), ...(raised ? { raisedBy: raised } : {}), ...(source ? { source } : {}),
      ...(job.forkOf ? { forkOf: { jobId: job.forkOf.jobId, questionId: job.forkOf.questionId } } : {}),
      ...(job.shift?.to === kind ? { switchedFrom: { jobId: job.id, questionId: job.shift.questionId } } : {}),
    });
  }
  store.jobs.update(job.id, {
    status: 'waiting_answer', [type.jobField]: p.id, questionId: undefined, laneId: undefined, pendingAnswer: undefined,
    resumeOn: lane?.machineId ?? job.resumeOn ?? job.spec.machineId,
  });
  const v = p.versions.at(-1)!;
  const first = type.parts[0]!.id;
  store.events.append({
    type: `${type.prefix}.submitted` as EventType, jobId: job.id, laneId, ...(p.raisedBy ? { machineId: p.raisedBy.machineId } : {}),
    data: { [type.idField]: p.id, version: v.number, ...(v.sections[first] ? { [first]: v.sections[first] } : {}), missing: v.missing, ...(p.raisedBy ? { raisedBy: p.raisedBy } : {}), ...priorityTagOf(c, job.id) },
  });
  return { kind, itemId: p.id };
}

export interface ReviewHandlers {
  /** Accepted or rejected: the job moves on to the next section it asks for, goes on with its work (an item it was not asked for, accepted), or ends `finished` with its decisions. */
  onDecided(p: ReviewItem): void;
  /** Sent back: the job is re-queued with `brief` pending (a parked one keeps it until it is re-queued). */
  onRevise(p: ReviewItem, brief: string): void;
}

/** The section a job asks for after `kind`, that it has no item of yet. */
function nextAsk(job: Job, kind: ReviewKind): ReviewKind | undefined {
  const asks = asksOfSpec(job.spec);
  return asks.slice(asks.indexOf(kind) + 1).find((k) => !job[REVIEW_SECTIONS[k].jobField]);
}

/** What a job is told when its item was accepted and it asks for `next`. */
const moveOnBrief = (p: ReviewItem, next: ReviewKind): string => {
  const notes = p.signOff?.notes ? ` Its notes: ${p.signOff.notes}` : '';
  return `[hopper ${p.kind}] Your ${REVIEW_SECTIONS[p.kind].noun} was accepted.${notes}\n${REVIEW_SECTIONS[next].ask.replace('Change nothing', 'Build on it; change nothing')}`;
};

/** What a job is told when an item it was not asked for was accepted (issue #538): go on with its work, or end done. */
const goOnBrief = (p: ReviewItem): string => {
  const notes = p.signOff?.notes ? ` Its notes: ${p.signOff.notes}` : '';
  return `[hopper ${p.kind}] Your ${REVIEW_SECTIONS[p.kind].noun} was accepted.${notes}\nGo on with what else your item asks, in this session. If it asks for nothing more, end your message with a line containing only HOPPER_DONE.`;
};

export function createReviewHandlers(c: EngineContext, cleanup: Cleanup): ReviewHandlers {
  const { store } = c;
  /** The job, while it still waits on this item: on it, or parked on it. */
  const waitingOn = (p: ReviewItem): Job | undefined => {
    const job = store.jobs.get(p.jobId);
    const field = REVIEW_SECTIONS[p.kind].jobField;
    if ((job?.status === 'waiting_answer' || job?.status === 'parked') && job[field] === p.id) return job;
    console.error(`${p.kind} ${p.id}: job ${p.jobId} is ${job?.status ?? 'missing'} (${p.kind} ${job?.[field] ?? 'none'}); ignored`);
    return undefined;
  };
  const requeue = (job: Job, brief: string, reason: string) => {
    if (job.status === 'parked') { store.jobs.update(job.id, { pendingAnswer: brief }); return; }
    store.jobs.update(job.id, { status: 'queued', pendingAnswer: brief, holdReason: undefined, waitReason: undefined });
    store.events.append({ type: 'job.requeued', jobId: job.id, data: { from: 'waiting_answer', reason } });
  };
  return {
    onDecided(p) {
      const job = waitingOn(p);
      if (!job) return;
      // A fork's result goes to its parent's question (issue #548); the fork itself ends as any job asked for one does.
      if (job.forkOf) resolveFork(c, job, p);
      // A phase a question switched the job to (issue #548): the person picked what it does next; `end` ends it here.
      const switched = job.shift?.to === p.kind;
      if (switched && afterSwitch(c, job, p, requeue, moveOnBrief)) return;
      const next = p.status === 'accepted' && !switched ? nextAsk(job, p.kind) : undefined;
      if (next) return requeue(job, moveOnBrief(p, next), `${REVIEW_SECTIONS[p.kind].noun} accepted: on to the ${REVIEW_SECTIONS[next].noun}`);
      // Not asked for it: the item was part of the job's own work, which goes on where its type says so (issue #538).
      const type = REVIEW_SECTIONS[p.kind];
      if (p.status === 'accepted' && !switched && type.goesOn && !job.spec[type.specFlag]) return requeue(job, goOnBrief(p), `${REVIEW_SECTIONS[p.kind].noun} accepted: the job goes on`);
      const result = decidedResult(itemsOfJob(c, store.jobs.get(p.jobId)!));
      store.jobs.update(p.jobId, { status: 'finished', result, finishedAt: nowIso(c), pendingAnswer: undefined });
      store.events.append({ type: 'job.finished', jobId: p.jobId, data: { result } });
      setImmediate(() => void cleanup(p.jobId));
    },
    onRevise(p, brief) {
      const job = waitingOn(p);
      if (job) requeue(job, brief, `${REVIEW_SECTIONS[p.kind].noun} sent back`);
    },
  };
}

/** A person asks a job that has not started for a section's special job (issues #537, #543): its agent is told so when it starts. */
export function askFor(c: EngineContext, kind: ReviewKind, id: string): Job {
  const { store } = c;
  const type = REVIEW_SECTIONS[kind];
  return store.tx(() => {
    const job = store.jobs.get(id);
    if (!job) throw new EngineError('not_found', `job ${id} not found`);
    if (job.status !== 'queued' && job.status !== 'held') throw new EngineError('conflict', `job ${id} is ${job.status}: only a job that has not started can be asked for a ${type.noun}`);
    if (job.spec[type.specFlag]) return job;
    const next = store.jobs.respecify(id, { ...job.spec, [type.specFlag]: true });
    store.events.append({ type: `${type.prefix}.asked` as EventType, jobId: id, data: { by: 'user' } });
    return next;
  });
}
