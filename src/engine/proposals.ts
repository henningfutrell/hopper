// The engine's side of proposals (issue #537, design.md "Proposals"). A job whose agent comes back with a proposal
// waits on it (waiting_answer, no question), as on a question: it holds no lane, its pane stays, it can be parked.
// Accepted or rejected, the job ends `finished` with the decision as its result — what an accepted proposal becomes
// is decided later (the proposal stays linked to the job and its item). Sent back, the job is re-queued with what to
// change, and its next proposal is the next version. The handlers run inside the proposal service's tx.
import type { ExecutionProposal } from '../domain/ports.ts';
import { raisedBy } from '../domain/raised-by.ts';
import { proposalSections, type Job, type Lane, type LaneId, type MachineSnapshot, type Proposal, type ProposalVersion } from '../domain/types.ts';
import type { Cleanup } from './cleanup.ts';
import { nowIso, priorityTagOf, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** The job's result once its proposal is decided. */
export const decidedResult = (p: Proposal) => ({ proposal: { id: p.id, version: p.signOff!.version, decision: p.signOff!.decision } });

/** Inside the tx recording the outcome: the job's proposal (a new one, or the next version of one sent back), and the job waiting on it. */
export function recordProposal(c: EngineContext, job: Job, lane: Lane | undefined, laneId: LaneId, machine: MachineSnapshot | undefined, proposal: ExecutionProposal, at: string): string {
  const { store } = c;
  const current = job.proposalId ? store.proposals.get(job.proposalId) : undefined;
  const version = (number: number): ProposalVersion => ({ number, text: proposal.text, ...proposalSections(proposal.text), recentOutput: proposal.recentOutput, at });
  const stage = c.proposals.firstStage();
  let p: Proposal;
  if (current?.status === 'revising') {
    store.proposals.addVersion(current.id, version(current.versions.length + 1));
    p = store.proposals.update(current.id, { status: 'open', stage });
  } else {
    const raised = raisedBy({ laneId, resumeOn: job.resumeOn, pin: job.spec.machineId, machines: new Map(machine ? [[machine.id, machine.label]] : []) });
    const source = job.source ? { key: job.source.key, url: job.source.url, title: job.source.title } : undefined;
    p = store.proposals.create({ jobId: job.id, stage, version: version(1), ...(raised ? { raisedBy: raised } : {}), ...(source ? { source } : {}) });
  }
  store.jobs.update(job.id, {
    status: 'waiting_answer', proposalId: p.id, questionId: undefined, laneId: undefined, pendingAnswer: undefined,
    resumeOn: lane?.machineId ?? job.resumeOn ?? job.spec.machineId,
  });
  const v = p.versions.at(-1)!;
  store.events.append({
    type: 'proposal.submitted', jobId: job.id, laneId, ...(p.raisedBy ? { machineId: p.raisedBy.machineId } : {}),
    data: { proposalId: p.id, version: v.number, ...(v.sections.goal ? { goal: v.sections.goal } : {}), missing: v.missing, ...(p.raisedBy ? { raisedBy: p.raisedBy } : {}), ...priorityTagOf(c, job.id) },
  });
  return p.id;
}

export interface ProposalHandlers {
  /** Accepted or rejected: the job waiting on it ends `finished` with the decision; its pane is cleaned up after the commit. */
  onDecided(p: Proposal): void;
  /** Sent back: the job is re-queued with `brief` pending (a parked one keeps it until it is re-queued). */
  onRevise(p: Proposal, brief: string): void;
}

export function createProposalHandlers(c: EngineContext, cleanup: Cleanup): ProposalHandlers {
  const { store } = c;
  /** The job, while it still waits on this proposal: on it, or parked on it. */
  const waitingOn = (p: Proposal): Job | undefined => {
    const job = store.jobs.get(p.jobId);
    if ((job?.status === 'waiting_answer' || job?.status === 'parked') && job.proposalId === p.id) return job;
    console.error(`proposal ${p.id}: job ${p.jobId} is ${job?.status ?? 'missing'} (proposal ${job?.proposalId ?? 'none'}); ignored`);
    return undefined;
  };
  return {
    onDecided(p) {
      if (!waitingOn(p)) return;
      const result = decidedResult(p);
      store.jobs.update(p.jobId, { status: 'finished', result, finishedAt: nowIso(c), pendingAnswer: undefined });
      store.events.append({ type: 'job.finished', jobId: p.jobId, data: { result } });
      setImmediate(() => void cleanup(p.jobId));
    },
    onRevise(p, brief) {
      const job = waitingOn(p);
      if (!job) return;
      if (job.status === 'parked') { store.jobs.update(p.jobId, { pendingAnswer: brief }); return; }
      store.jobs.update(p.jobId, { status: 'queued', pendingAnswer: brief, holdReason: undefined, waitReason: undefined });
      store.events.append({ type: 'job.requeued', jobId: p.jobId, data: { from: 'waiting_answer', reason: 'proposal sent back' } });
    },
  };
}

/** A person asks a job that has not started for a proposal (issue #537): its agent is told so when it starts. */
export function askForProposal(c: EngineContext, id: string): Job {
  const { store } = c;
  return store.tx(() => {
    const job = store.jobs.get(id);
    if (!job) throw new EngineError('not_found', `job ${id} not found`);
    if (job.status !== 'queued' && job.status !== 'held') throw new EngineError('conflict', `job ${id} is ${job.status}: only a job that has not started can be asked for a proposal`);
    if (job.spec.proposal) return job;
    const next = store.jobs.respecify(id, { ...job.spec, proposal: true });
    store.events.append({ type: 'proposal.asked', jobId: id, data: { by: 'user' } });
    return next;
  });
}
