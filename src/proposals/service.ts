// The proposal review (issue #537, design.md "Proposals"): the reviewer levels, lowest first — escalation levels named
// in the proposal settings — then a person. Each level approves, asks for changes or escalates; its verdict and notes
// go on the trail. An approval goes on up, or accepts the proposal where the top level may sign off. A request for
// changes sends it back to the job, until the levels have done so as often as the settings allow; then a person
// decides. A level that fails, times out, cannot review or replies malformed escalates: it never decides. A person
// accepts, rejects or sends it back, at any stage. Like the question pipeline, every write is one tx, compare-and-set.
import type { Clock, ConfigRecords, EscalationLevel, ProposalActionResult, ProposalService, ReviewReply, ReviewRequest, UserStore } from '../domain/ports.ts';
import { jobPriorityTag, PROPOSAL_OPEN_STATUSES, TERMINAL_STATUSES, type Proposal, type ProposalReview, type ProposalSettings } from '../domain/types.ts';
import type { Logins } from '../logins/index.ts';
import { check } from '../questions/results.ts';
import { readRules } from '../questions/rules.ts';
import { REVIEW_REPLY } from './reply.ts';
import { proposalSettings } from './settings.ts';

export interface ProposalServiceOptions {
  store: UserStore;
  clock: Clock;
  /** The escalation levels now; the reviewers are looked up among them by name, per review. */
  levels(): readonly EscalationLevel[];
  /** Ceiling on one level's review. */
  stageTimeoutMs: number;
  /** Where the rules are read. */
  config: ConfigRecords;
  /** Inside the tx that accepts or rejects it. */
  onDecided(p: Proposal): void;
  /** Inside the tx that sends it back: `brief` is what the job is told. */
  onRevise(p: Proposal, brief: string): void;
  logins?: Logins;
}

export const HUMAN = 'human';

/** What a job is told when its proposal is sent back. */
export function revisionBrief(p: Proposal, from: string, notes: string): string {
  const who = from === HUMAN ? 'a person' : `the reviewer level ${from}`;
  return [
    `[hopper proposal] Your proposal (version ${p.versions.length}) was sent back by ${who}. What to change:`,
    notes,
    'Write the revised proposal in full, as before, and end with HOPPER_PROPOSAL.',
  ].join('\n');
}

/** A reviewer named in the settings that is no escalation level now: every review it gets is an error. */
const missingLevel = (name: string): EscalationLevel => ({
  name, answer: async () => ({ error: 'not a question' }), review: async () => ({ error: `no escalation level is named ${name} now` }),
});

export function createProposalService(o: ProposalServiceOptions): ProposalService {
  const { store, clock } = o;
  const inflight = new Map<string, AbortController>();
  const running = new Set<Promise<void>>();
  let stopped = false;
  const iso = () => clock.now().toISOString();

  type ProposalEvent = 'proposal.escalated' | 'proposal.escalated_to_human' | 'proposal.reviewed' | 'proposal.revision_requested' | 'proposal.accepted' | 'proposal.rejected' | 'proposal.cancelled';
  function emit(p: Proposal, type: ProposalEvent, data: Record<string, unknown>) {
    const r = p.raisedBy;
    store.events.append({
      type, jobId: p.jobId, ...(r ? { machineId: r.machineId } : {}),
      data: { proposalId: p.id, version: p.versions.length, ...data, ...(r ? { raisedBy: r } : {}), ...(jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), p.jobId) ?? {}) },
    });
  }

  function abortReview(id: string, reason: string) { inflight.get(id)?.abort(reason); inflight.delete(id); }

  /** Inside a tx. Moves an open proposal to `stage` and announces it. */
  function enter(p: Proposal, stage: string, reason: string): Proposal {
    const updated = p.stage === stage ? p : store.proposals.update(p.id, { stage });
    emit(updated, 'proposal.escalated', { target: stage, reason, ...(updated.versions.at(-1)!.sections.goal ? { goal: updated.versions.at(-1)!.sections.goal } : {}) });
    return updated;
  }

  /** Inside a tx. A person decides from here. */
  function toHuman(p: Proposal, reason: string) {
    const updated = enter(p, HUMAN, reason);
    emit(updated, 'proposal.escalated_to_human', { reason });
  }

  /** Inside a tx. Accepted or rejected: signed off, and the job told. */
  function signOff(p: Proposal, decision: 'accept' | 'reject', stage: string, notes: string | undefined, by?: string): Proposal {
    const at = iso();
    const updated = store.proposals.update(p.id, {
      status: decision === 'accept' ? 'accepted' : 'rejected',
      signOff: { decision, stage, at, version: p.versions.length, ...(by ? { by } : {}), ...(notes ? { notes } : {}) },
    });
    emit(updated, decision === 'accept' ? 'proposal.accepted' : 'proposal.rejected', { stage, ...(by ? { by } : {}), ...(notes ? { notes } : {}) });
    o.onDecided(updated);
    return updated;
  }

  /** Inside a tx. Back to the job with what to change. */
  function sendBack(p: Proposal, stage: string, notes: string, by?: string): Proposal {
    const updated = store.proposals.update(p.id, { status: 'revising', ...(stage === HUMAN ? {} : { levelRevisions: p.levelRevisions + 1 }) });
    emit(updated, 'proposal.revision_requested', { stage, notes, ...(by ? { by } : {}) });
    o.onRevise(updated, revisionBrief(updated, stage, notes));
    return updated;
  }

  /** Inside a tx. The proposal, if it is still open at `stage` on the same version. */
  function stillAt(id: string, stage: string, version: number): Proposal | undefined {
    const p = store.proposals.get(id);
    return p && p.status === 'open' && p.stage === stage && p.versions.length === version ? p : undefined;
  }

  async function call(id: string, fn: (signal: AbortSignal) => Promise<ReviewReply | { error: string }>): Promise<ReviewReply | { error: string }> {
    const ac = new AbortController();
    inflight.set(id, ac);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(() => { ac.abort('timeout'); resolve({ error: `timeout after ${o.stageTimeoutMs}ms` }); }, o.stageTimeoutMs);
    });
    try {
      return await Promise.race([fn(ac.signal).catch((e: unknown) => ({ error: `threw: ${e instanceof Error ? e.message : String(e)}` })), timeout]);
    } finally {
      clearTimeout(timer);
      if (inflight.get(id) === ac) inflight.delete(id);
    }
  }

  function requestFor(p: Proposal, number: number, of: number, level: string): ReviewRequest {
    const job = store.jobs.get(p.jobId);
    const jobMachine = job?.resumeOn ?? job?.spec.machineId;
    return {
      proposal: p, version: p.versions.at(-1)!,
      jobPrompt: typeof job?.spec.payload.prompt === 'string' ? job.spec.payload.prompt : '',
      ...(job?.spec.goal ? { jobGoal: job.spec.goal } : {}),
      rules: readRules(o.config).text, previous: p.reviews, level: { number, of },
      ...(jobMachine ? { jobMachine } : {}),
      ...(o.logins ? { logins: o.logins.forRun({ run: level }, () => !stopped) } : {}),
    };
  }

  /** One reviewer level holds the proposal. Returns why it goes on up, or undefined when it stops here. */
  async function review(id: string, level: EscalationLevel, number: number, of: number, reason: string, s: ProposalSettings): Promise<string | undefined> {
    const entered = store.tx((): Proposal | undefined => {
      const p = store.proposals.get(id);
      return p && p.status === 'open' ? enter(p, level.name, reason) : undefined;
    });
    if (!entered) return undefined;
    const version = entered.versions.length;
    const startedAt = iso();
    const req = requestFor(entered, number, of, level.name);
    const replied = level.review ? await call(id, (signal) => level.review!(req, signal)) : { error: 'this escalation level cannot review proposals' };
    if (stopped) return undefined;
    const reply = check(REVIEW_REPLY, 'review', replied);
    return store.tx((): string | undefined => {
      const p = stillAt(id, level.name, version);
      if (!p) return undefined;
      const model = (reply.ok ? reply.value.model : undefined) ?? level.model;
      const machine = reply.ok ? reply.value.machine : undefined;
      const base = { version, stage: level.name, role: 'level' as const, ...(model ? { model } : {}), ...(machine ? { machine } : {}), startedAt, finishedAt: iso() };
      const record = (r: ProposalReview) => {
        store.proposals.addReview(id, r);
        emit(p, 'proposal.reviewed', { stage: r.stage, verdict: r.verdict, notes: r.notes, ...(r.error ? { error: r.error } : {}) });
      };
      if (!reply.ok) {
        record({ ...base, verdict: 'escalate', notes: 'the review failed', error: reply.error });
        return `${level.name} failed: ${reply.error}`;
      }
      const { verdict, notes } = reply.value;
      record({ ...base, verdict, notes });
      if (verdict === 'escalate') return `${level.name}: ${notes}`;
      if (verdict === 'approve') {
        if (s.signOff === 'top-level' && number === of) return void signOff(store.proposals.get(id)!, 'accept', level.name, notes);
        return `${level.name} approved: ${notes}`;
      }
      const now = store.proposals.get(id)!;
      if (now.levelRevisions < s.levelRevisions) return void sendBack(now, level.name, notes);
      return void toHuman(now, `${level.name} asked for changes again, past the ${s.levelRevisions} the reviewer levels may ask for: ${notes}`);
    });
  }

  async function run(id: string, reason: string): Promise<void> {
    if (stopped) return;
    const s = proposalSettings(store);
    const levels = o.levels();
    const reviewers = s.reviewers.map((name) => levels.find((l) => l.name === name) ?? missingLevel(name));
    let why: string | undefined = reason;
    for (const [i, level] of reviewers.entries()) {
      why = await review(id, level, i + 1, reviewers.length, why, s);
      if (why === undefined) return;
    }
    store.tx(() => {
      const p = store.proposals.get(id);
      if (p && p.status === 'open') toHuman(p, reviewers.length === 0 ? 'no reviewer levels configured' : why);
    });
  }

  function start(id: string, reason: string) {
    const p: Promise<void> = run(id, reason)
      .catch((err: unknown) => console.error(`proposal ${id}: review failed`, err))
      .finally(() => running.delete(p));
    running.add(p);
  }

  /** A person's decision on an open proposal, over any level in flight. */
  function byHuman(id: string, decision: 'accept' | 'reject' | 'request_changes', by: string, notes: string | undefined): ProposalActionResult {
    return store.tx((): ProposalActionResult => {
      const p = store.proposals.get(id);
      if (!p) return { ok: false, reason: 'not_found', message: `proposal ${id} not found` };
      if (p.status !== 'open') return { ok: false, reason: 'not_open', message: `proposal ${id} is ${p.status}: only an open proposal can be decided` };
      abortReview(id, 'superseded');
      const at = iso();
      store.proposals.addReview(id, { version: p.versions.length, stage: HUMAN, role: 'human', verdict: decision, notes: notes ?? '', by, startedAt: at, finishedAt: at });
      const now = store.proposals.get(id)!;
      if (decision === 'request_changes') return { ok: true, proposal: sendBack(now, HUMAN, notes ?? '', by) };
      return { ok: true, proposal: signOff(now, decision, HUMAN, notes, by) };
    });
  }

  return {
    firstStage() {
      const [first] = proposalSettings(store).reviewers;
      return first ?? HUMAN;
    },
    handle(id) { start(id, 'submitted'); },
    accept: (id, by, notes) => byHuman(id, 'accept', by, notes),
    reject: (id, by, notes) => byHuman(id, 'reject', by, notes),
    requestChanges: (id, by, notes) => byHuman(id, 'request_changes', by, notes),
    markSeen(id) {
      const p = store.proposals.get(id);
      if (!p) return { ok: false, reason: 'not_found', message: `proposal ${id} not found` };
      return { ok: true, proposal: p.seenAt ? p : store.proposals.update(id, { seenAt: iso() }) };
    },
    sweep() {
      for (const p of store.proposals.list({ status: [...PROPOSAL_OPEN_STATUSES] })) {
        const job = store.jobs.get(p.jobId);
        if (job && job.proposalId === p.id && !TERMINAL_STATUSES.includes(job.status)) continue;
        store.tx(() => {
          const now = store.proposals.get(p.id);
          if (!now || !PROPOSAL_OPEN_STATUSES.includes(now.status)) return;
          abortReview(p.id, 'cancel');
          emit(store.proposals.update(p.id, { status: 'cancelled' }), 'proposal.cancelled', { reason: job ? `its job is ${job.status}` : 'its job is gone' });
        });
      }
    },
    recover() {
      this.sweep();
      for (const p of store.proposals.list({ status: ['open'] })) if (p.stage !== HUMAN) start(p.id, 'restarted after a daemon restart');
    },
    async stop() {
      stopped = true;
      for (const id of [...inflight.keys()]) abortReview(id, 'shutdown');
      await Promise.all([...running]);
    },
  };
}
