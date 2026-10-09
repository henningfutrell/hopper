// The review (issues #537, #543, design.md "Sections"): one service per review section — Proposals, Research — built
// from its ReviewSectionType. The reviewer levels, lowest first — escalation levels named in the section's settings —
// then a person. Each level approves, asks for changes or escalates; its verdict and notes go on the trail. An approval
// goes on up, or accepts the item where the top level may sign off. A request for changes sends it back to the job,
// until the levels have done so as often as the settings allow; then a person decides. A level that fails, times out,
// cannot review or replies malformed escalates: it never decides. A person takes one of the decisions the section
// declares, at any stage. Like the question pipeline, every write is one tx, compare-and-set.
import type { Clock, ConfigRecords, EscalationLevel, ReviewActionResult, ReviewReply, ReviewRequest, ReviewService, ReviewServices, UserStore } from '../domain/ports.ts';
import {
  jobPriorityTag, REVIEW_KINDS, REVIEW_OPEN_STATUSES, REVIEW_SECTIONS, TERMINAL_STATUSES, type EventType,
  type ReviewDecisionId, type ReviewEntry, type ReviewItem, type ReviewKind, type ReviewSettings,
} from '../domain/types.ts';
import type { Logins } from '../logins/index.ts';
import { check } from '../questions/results.ts';
import { readRules } from '../questions/rules.ts';
import { REVIEW_REPLY } from './reply.ts';
import { reviewSettings } from './settings.ts';

export interface ReviewServiceOptions {
  store: UserStore;
  clock: Clock;
  /** The escalation levels now; the reviewers are looked up among them by name, per review. */
  levels(): readonly EscalationLevel[];
  /** Ceiling on one level's review. */
  stageTimeoutMs: number;
  /** Where the rules are read. */
  config: ConfigRecords;
  /** Inside the tx that accepts or rejects it. */
  onDecided(item: ReviewItem): void;
  /** Inside the tx that sends it back: `brief` is what the job is told. */
  onRevise(item: ReviewItem, brief: string): void;
  logins?: Logins;
}

export const HUMAN = 'human';

/** A reviewer named in the settings that is no escalation level now: every review it gets is an error. */
const missingLevel = (name: string): EscalationLevel => ({
  name, answer: async () => ({ error: 'not a question' }), review: async () => ({ error: `no escalation level is named ${name} now` }),
});

type Suffix = 'escalated' | 'escalated_to_human' | 'reviewed' | 'revision_requested' | 'accepted' | 'rejected' | 'cancelled';

export function createReviewService(kind: ReviewKind, o: ReviewServiceOptions): ReviewService {
  const { store, clock } = o;
  const type = REVIEW_SECTIONS[kind];
  const items = store.reviews[kind];
  const inflight = new Map<string, AbortController>();
  const running = new Set<Promise<void>>();
  let stopped = false;
  const iso = () => clock.now().toISOString();

  function emit(p: ReviewItem, suffix: Suffix, data: Record<string, unknown>) {
    const r = p.raisedBy;
    store.events.append({
      type: `${type.prefix}.${suffix}` as EventType, jobId: p.jobId, ...(r ? { machineId: r.machineId } : {}),
      data: { [type.idField]: p.id, version: p.versions.length, ...data, ...(r ? { raisedBy: r } : {}), ...(jobPriorityTag(store.jobs, store.settings.getPriorityLanes(), p.jobId) ?? {}) },
    });
  }

  function abortReview(id: string, reason: string) { inflight.get(id)?.abort(reason); inflight.delete(id); }

  /** The first part of the newest version, as the escalation event names it (a proposal's goal, a report's question). */
  const headline = (p: ReviewItem): Record<string, string> => {
    const first = type.parts[0]!.id;
    const text = p.versions.at(-1)!.sections[first];
    return text ? { [first]: text } : {};
  };

  /** Inside a tx. Moves an open item to `stage` and announces it. */
  function enter(p: ReviewItem, stage: string, reason: string): ReviewItem {
    const updated = p.stage === stage ? p : items.update(p.id, { stage });
    emit(updated, 'escalated', { target: stage, reason, ...headline(updated) });
    return updated;
  }

  /** Inside a tx. A person decides from here. */
  function toHuman(p: ReviewItem, reason: string) {
    const updated = enter(p, HUMAN, reason);
    emit(updated, 'escalated_to_human', { reason });
  }

  /** Inside a tx. Accepted or rejected: signed off, and the job told. */
  function signOff(p: ReviewItem, decision: 'accept' | 'reject', stage: string, notes: string | undefined, by?: string): ReviewItem {
    const at = iso();
    const updated = items.update(p.id, {
      status: decision === 'accept' ? 'accepted' : 'rejected',
      signOff: { decision, stage, at, version: p.versions.length, ...(by ? { by } : {}), ...(notes ? { notes } : {}) },
    });
    emit(updated, decision === 'accept' ? 'accepted' : 'rejected', { stage, ...(by ? { by } : {}), ...(notes ? { notes } : {}) });
    o.onDecided(updated);
    return updated;
  }

  /** Inside a tx. Back to the job with what to do next. */
  function sendBack(p: ReviewItem, stage: string, decision: ReviewDecisionId, notes: string, by?: string): ReviewItem {
    const updated = items.update(p.id, { status: 'revising', ...(stage === HUMAN ? {} : { levelRevisions: p.levelRevisions + 1 }) });
    emit(updated, 'revision_requested', { stage, decision, notes, ...(by ? { by } : {}) });
    o.onRevise(updated, type.brief(updated, stage, decision, notes));
    return updated;
  }

  /** Inside a tx. The item, if it is still open at `stage` on the same version. */
  function stillAt(id: string, stage: string, version: number): ReviewItem | undefined {
    const p = items.get(id);
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

  function requestFor(p: ReviewItem, number: number, of: number, level: string): ReviewRequest {
    const job = store.jobs.get(p.jobId);
    const jobMachine = job?.resumeOn ?? job?.spec.machineId;
    return {
      kind, item: p, version: p.versions.at(-1)!,
      jobPrompt: typeof job?.spec.payload.prompt === 'string' ? job.spec.payload.prompt : '',
      ...(job?.spec.goal ? { jobGoal: job.spec.goal } : {}),
      rules: readRules(o.config).text, previous: p.reviews, level: { number, of },
      ...(jobMachine ? { jobMachine } : {}),
      ...(o.logins ? { logins: o.logins.forRun({ run: level }, () => !stopped) } : {}),
    };
  }

  /** One reviewer level holds the item. Returns why it goes on up, or undefined when it stops here. */
  async function review(id: string, level: EscalationLevel, number: number, of: number, reason: string, s: ReviewSettings): Promise<string | undefined> {
    const entered = store.tx((): ReviewItem | undefined => {
      const p = items.get(id);
      return p && p.status === 'open' ? enter(p, level.name, reason) : undefined;
    });
    if (!entered) return undefined;
    const version = entered.versions.length;
    const startedAt = iso();
    const req = requestFor(entered, number, of, level.name);
    const replied = level.review ? await call(id, (signal) => level.review!(req, signal)) : { error: `this escalation level cannot review ${type.noun}s` };
    if (stopped) return undefined;
    const reply = check(REVIEW_REPLY, 'review', replied);
    return store.tx((): string | undefined => {
      const p = stillAt(id, level.name, version);
      if (!p) return undefined;
      const model = (reply.ok ? reply.value.model : undefined) ?? level.model;
      const machine = reply.ok ? reply.value.machine : undefined;
      const base = { version, stage: level.name, role: 'level' as const, ...(model ? { model } : {}), ...(machine ? { machine } : {}), startedAt, finishedAt: iso() };
      const record = (r: ReviewEntry) => {
        items.addReview(id, r);
        emit(p, 'reviewed', { stage: r.stage, verdict: r.verdict, notes: r.notes, ...(r.error ? { error: r.error } : {}) });
      };
      if (!reply.ok) {
        record({ ...base, verdict: 'escalate', notes: 'the review failed', error: reply.error });
        return `${level.name} failed: ${reply.error}`;
      }
      const { verdict, notes } = reply.value;
      record({ ...base, verdict, notes });
      if (verdict === 'escalate') return `${level.name}: ${notes}`;
      if (verdict === 'approve') {
        if (s.signOff === 'top-level' && number === of) return void signOff(items.get(id)!, 'accept', level.name, notes);
        return `${level.name} approved: ${notes}`;
      }
      const now = items.get(id)!;
      if (now.levelRevisions < s.levelRevisions) return void sendBack(now, level.name, 'request_changes', notes);
      return void toHuman(now, `${level.name} asked for changes again, past the ${s.levelRevisions} the reviewer levels may ask for: ${notes}`);
    });
  }

  async function run(id: string, reason: string): Promise<void> {
    if (stopped) return;
    const s = reviewSettings(store, kind);
    const levels = o.levels();
    const reviewers = s.reviewers.map((name) => levels.find((l) => l.name === name) ?? missingLevel(name));
    let why: string | undefined = reason;
    for (const [i, level] of reviewers.entries()) {
      why = await review(id, level, i + 1, reviewers.length, why, s);
      if (why === undefined) return;
    }
    store.tx(() => {
      const p = items.get(id);
      if (p && p.status === 'open') toHuman(p, reviewers.length === 0 ? 'no reviewer levels configured' : why);
    });
  }

  function start(id: string, reason: string) {
    const p: Promise<void> = run(id, reason)
      .catch((err: unknown) => console.error(`${kind} ${id}: review failed`, err))
      .finally(() => running.delete(p));
    running.add(p);
  }

  return {
    kind,
    firstStage() {
      const [first] = reviewSettings(store, kind).reviewers;
      return first ?? HUMAN;
    },
    handle(id) { start(id, 'submitted'); },
    /** A person's decision on an open item, over any level in flight. */
    decide(id, decision, by, notes) {
      const offered = type.decisions.find((d) => d.id === decision);
      if (!offered) return { ok: false, reason: 'not_offered', message: `${type.noun}s are not decided by ${decision}` };
      return store.tx((): ReviewActionResult => {
        const p = items.get(id);
        if (!p) return { ok: false, reason: 'not_found', message: `${type.noun} ${id} not found` };
        if (p.status !== 'open') return { ok: false, reason: 'not_open', message: `${type.noun} ${id} is ${p.status}: only an open ${type.noun} can be decided` };
        abortReview(id, 'superseded');
        const at = iso();
        items.addReview(id, { version: p.versions.length, stage: HUMAN, role: 'human', verdict: decision, notes: notes ?? '', by, startedAt: at, finishedAt: at });
        const now = items.get(id)!;
        if (offered.effect === 'send_back') return { ok: true, item: sendBack(now, HUMAN, decision, notes ?? '', by) };
        return { ok: true, item: signOff(now, offered.effect, HUMAN, notes, by) };
      });
    },
    markSeen(id) {
      const p = items.get(id);
      if (!p) return { ok: false, reason: 'not_found', message: `${type.noun} ${id} not found` };
      return { ok: true, item: p.seenAt ? p : items.update(id, { seenAt: iso() }) };
    },
    sweep() {
      for (const p of items.list({ status: [...REVIEW_OPEN_STATUSES] })) {
        const job = store.jobs.get(p.jobId);
        if (job && job[type.jobField] === p.id && !TERMINAL_STATUSES.includes(job.status)) continue;
        store.tx(() => {
          const now = items.get(p.id);
          if (!now || !REVIEW_OPEN_STATUSES.includes(now.status)) return;
          abortReview(p.id, 'cancel');
          emit(items.update(p.id, { status: 'cancelled' }), 'cancelled', { reason: job ? `its job is ${job.status}` : 'its job is gone' });
        });
      }
    },
    recover() {
      this.sweep();
      for (const p of items.list({ status: ['open'] })) if (p.stage !== HUMAN) start(p.id, 'restarted after a daemon restart');
    },
    async stop() {
      stopped = true;
      for (const id of [...inflight.keys()]) abortReview(id, 'shutdown');
      await Promise.all([...running]);
    },
  };
}

/** Every review section's service, from one set of options. */
export const createReviewServices = (o: ReviewServiceOptions): ReviewServices =>
  Object.fromEntries(REVIEW_KINDS.map((k) => [k, createReviewService(k, o)])) as unknown as ReviewServices;
