// The engine as a SourceHost (ports.ts): everything the sync loop may do to the hopper. Each
// write is one store.tx that re-reads the job (compare-and-set), so a re-sort can never land on a
// job a Decision has just claimed. design.md "Job sources".
import type { RerunResult, SourceHost, SourceItem, SourceRef } from '../domain/ports.ts';
import { SPECIALTY_LABEL } from '../domain/elbow-in.ts';
import { asksOf, isRerunnable, machineRanOn, PUSHABLE_ENDS, reworkBrief, REVIEW_SECTIONS, TERMINAL_STATUSES } from '../domain/types.ts';
import type { Job, JobSourceRef, JobSpec, RoutedBy, SpecFromConfig } from '../domain/types.ts';
import { settleLiveAgain } from '../failures/continued.ts';
import { routeItem } from '../routing/index.ts';
import type { Commands } from './commands.ts';
import { nowIso, priorityTagOf, type EngineContext } from './context.ts';
import { awaitsOrigin } from '../domain/trust-stamp.ts';
import { appendStamped } from './quarantine.ts';
import { EngineError } from './errors.ts';
import { recordCommentWake } from './wait.ts';
import { changedSince, gateItem, holdForChange, recordSnapshot, refreshEdit, refreshText } from './item-snapshots.ts';
import { carryNotes } from './notes.ts';

const clamp = (p: number): number => Math.max(0, Math.min(100, p));

function refFor(item: SourceItem, source: { name: string; kind: string }): JobSourceRef {
  return {
    source: source.name, kind: source.kind, key: item.key, url: item.url, title: item.title, author: item.author,
    ...(item.repo !== undefined ? { repo: item.repo } : {}),
    ...(item.number !== undefined ? { number: item.number } : {}),
    ...(item.assignee !== undefined ? { assignee: item.assignee } : {}),
    labels: [...item.labels],
    ...(item.parts ? { parts: { ...item.parts } } : {}),
    ...(item.origin ? { origin: item.origin } : {}),
    ...(item.origin && item.originActs ? { originActs: item.originActs.map((a) => ({ ...a })) } : {}),
    ...(item.origin ? linksOf(item) : {}),
  };
}

/** An item's or a job's links (issue #655 part 19): its repository's visibility and its linked pull requests, copied. */
const linksOf = (x: Pick<SourceItem, 'visibility' | 'linkedPulls'>): Pick<SourceItem, 'visibility' | 'linkedPulls'> =>
  ({ ...(x.visibility ? { visibility: x.visibility } : {}), ...(x.linkedPulls ? { linkedPulls: x.linkedPulls.map((p) => ({ ...p })) } : {}) });

/** A person's Run again or Rework of a job (issue #652): the new job keeps the origin of the job it follows, its origin acts (issue #655 part 14) and its links (part 19). */
const originFrom = (item: SourceItem, job: Job): SourceItem => (item.origin || !job.source?.origin ? item
  : { ...item, origin: job.source.origin, ...(job.source.originActs ? { originActs: job.source.originActs } : {}), ...linksOf(job.source) });

/**
 * What the item and the routing rule give a job's spec (issue #375). The job's own work tree is a routing
 * rule's, which pins the job to its machine (issues #324, #361); anything else runs in its machine's.
 */
function fromConfigFor(item: SourceItem, routedBy: RoutedBy | undefined): SpecFromConfig {
  return specFromConfig({
    executor: routedBy?.set.executor ?? item.executor, model: item.model || undefined, cwd: routedBy?.set.workTree,
    machineId: routedBy?.set.machine, rule: routedBy?.rule,
  });
}

/** The same parts as the job's spec holds them now. */
function fromSpec(spec: JobSpec): SpecFromConfig {
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return specFromConfig({
    executor: spec.executor, model: text(spec.payload.model), cwd: text(spec.payload.cwd),
    machineId: spec.machineId, rule: spec.routedBy?.rule,
  });
}

/** One key order and no undefined values, so two compare by their JSON. */
function specFromConfig(f: { executor: string } & { [K in Exclude<keyof SpecFromConfig, 'executor'>]: SpecFromConfig[K] | undefined }): SpecFromConfig {
  return {
    executor: f.executor, ...(f.model !== undefined ? { model: f.model } : {}), ...(f.cwd !== undefined ? { cwd: f.cwd } : {}),
    ...(f.machineId !== undefined ? { machineId: f.machineId } : {}),
    ...(f.rule !== undefined ? { rule: f.rule } : {}),
  };
}

const same = (a: SpecFromConfig, b: SpecFromConfig): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `spec` with the parts `f` gives: set where `f` has one, removed where it has none. */
function withParts(spec: JobSpec, f: SpecFromConfig, routedBy: RoutedBy | undefined): JobSpec {
  const { cwd: _c, model: _m, ...rest } = spec.payload;
  const { machineId: _p, routedBy: _r, ...base } = spec;
  return {
    ...base, executor: f.executor,
    payload: { ...rest, ...(f.cwd !== undefined ? { cwd: f.cwd } : {}), ...(f.model !== undefined ? { model: f.model } : {}) },
    ...(f.machineId !== undefined ? { machineId: f.machineId } : {}),
    ...(routedBy ? { routedBy } : {}),
  };
}

function specFor(item: SourceItem, source: { name: string }, priority: number, routedBy: RoutedBy | undefined, f: SpecFromConfig): JobSpec {
  // `body` is the item's own text, without the context block: what the command executor runs.
  const spec: JobSpec = {
    executor: f.executor, payload: { prompt: item.prompt, body: item.body, env: item.env }, priority, goal: item.title,
    submittedBy: `${source.name}:${item.author}`, kind: 'coding',
    // Labelled hopper:research or hopper:proposal, or with a Research or Proposal heading in its body (issues #537,
    // #543; the layout of #542), or by its account's comment command (issue #655 part 21): the job is asked for the
    // research or the proposal, not the work — research first.
    ...Object.fromEntries(asksOf(item.labels, item.body ?? '', item.asks).map((k) => [REVIEW_SECTIONS[k].specFlag, true as const])),
    // Labelled hopper:specialty (issue #762): it may elbow in past a machine's lane cap; no other job may.
    ...(item.labels.includes(SPECIALTY_LABEL) ? { specialty: true as const } : {}),
  };
  return withParts(spec, f, routedBy);
}

/**
 * The spec a job that has not started gets from `to`, what its source and routing rules give it now
 * (issue #375): each part follows the config unless it was changed on the job by hand — it differs from
 * what the config gave it last (`fromConfig`; absent on a job from before: the spec as it is) —, and then
 * keeps the hand value.
 */
function respecified(job: Job, to: SpecFromConfig, routedBy: RoutedBy | undefined): JobSpec {
  const now = fromSpec(job.spec);
  const was = job.fromConfig ?? now;
  const pick = <K extends keyof SpecFromConfig>(k: K): SpecFromConfig[K] | undefined => (now[k] === was[k] ? to[k] : now[k]);
  const parts = specFromConfig({ executor: pick('executor')!, model: pick('model'), cwd: pick('cwd'), machineId: pick('machineId'), rule: to.rule });
  return withParts(job.spec, parts, routedBy);
}

/**
 * The first routing rule matching the item (design.md "Routing rules (issue #18)"). A matching rule
 * whose machine or executor is not configured is skipped with a warning; intake never fails on one.
 */
function route(c: EngineContext, item: SourceItem, source: { name: string }): RoutedBy | undefined {
  const rules = c.routing.rules();
  if (rules.length === 0) return undefined;
  const executors = [...c.executors.names(), ...c.executors.unavailable().map((u) => u.name)];
  const r = routeItem(rules, { source: source.name, ...(item.repo !== undefined ? { repo: item.repo } : {}), labels: item.labels, author: item.author, title: item.title },
    { machines: c.routing.machines(), executors });
  for (const s of r.skipped) console.warn(`hopper: routing rule ${s.rule} skipped for ${item.key}: ${s.reason}`);
  return r.routedBy;
}

/**
 * Why the item cannot run, or undefined: the source's own verdict first, then the executor's. A
 * configured executor that cannot run accepts the item unvalidated: its job is held until a
 * restart brings the executor up (design.md "Failure").
 */
function problemWith(c: EngineContext, item: SourceItem, spec: JobSpec): string | undefined {
  if (item.invalid) return item.invalid;
  const executor = c.executors.get(spec.executor);
  if (!executor && c.executors.unavailable().some((u) => u.name === spec.executor)) return undefined;
  if (!executor) return `unknown executor ${spec.executor} (known: ${c.executors.names().join(', ')})`;
  const problem = executor.validate(spec.payload);
  return problem ? `invalid payload for executor ${spec.executor}: ${problem}` : undefined;
}

export function createSourceHost(c: EngineContext, commands: Pick<Commands, 'cancel' | 'finishWaiting'>): SourceHost {
  const { store } = c;

  /** The new job for an item, or null when its key's newest job is not re-runnable. A key's earlier job is its `rerunOf`. */
  function ingest(offered: SourceItem, source: SourceRef, brief?: string, tend = false): Job | null {
    // The item's snapshot (issue #662): a later job of the item runs the snapshot's text, held when the live text differs.
    const gate = gateItem(store, offered, source, nowIso(c));
    const item = brief ? { ...gate.item, prompt: `${gate.item.prompt}\n\n${brief}` } : gate.item;
    const change = gate.change && brief ? { ...gate.change, accepted: { ...gate.change.accepted, prompt: `${gate.change.accepted.prompt}\n\n${brief}` } } : gate.change;
    const routedBy = route(c, item, source);
    const priority = clamp(routedBy?.set.priority ?? item.priority);
    const ref = refFor(item, source);
    const fromConfig = fromConfigFor(item, routedBy);
    // Tending's job (issue #967): it may elbow in past a lane cap, so a pull request's conflict never waits for a lane.
    const spec = { ...specFor(item, source, priority, routedBy, fromConfig), ...(tend ? { tend: true as const } : {}) };
    const invalid = problemWith(c, item, spec);
    return store.tx((): Job | null => {
      // Two hoppers that run one item again at once (issue #1892): the second waits here, then reads the first's new job.
      store.jobs.lockItem?.(item.key);
      const known = store.jobs.getBySourceKey(item.key);
      if (known && !isRerunnable(known)) return null;
      const job = store.jobs.create(spec, priority, ref);
      store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority, source: ref } }); appendStamped(store, job);
      // A job that cannot run ran nothing: its item's snapshot waits for a job that can.
      if (gate.record && invalid === undefined) recordSnapshot(c, job, item.key, gate.record, 'intake');
      if (change && invalid === undefined) holdForChange(c, job.id, item.key, change);
      // Every new job waits at the queue gate (issue #159) until the pre-sort or the user accepts it. An item of a source that
      // judges origins offered with none (issue #2113: its issue's job had not ended when the sync judged it) waits for it:
      // the next sync judges its issue, stamps it again by the rules or opens its request card in Intake.
      if (invalid === undefined) {
        const pending = awaitsOrigin(job) ? { originPending: true as const } : {};
        const queued = store.jobs.update(job.id, { accepted: false, fromConfig, ...pending, ...(known ? { rerunOf: known.id } : {}) });
        // The notes its item's earlier job never delivered go on to this one (issue #997).
        if (!known) return queued;
        carryNotes(c, known, job.id);
        return store.jobs.get(job.id)!;
      }
      // Created and failed together: the source reports claimed, then failed — once.
      store.events.append({ type: 'job.failed', jobId: job.id, data: { error: invalid, ...priorityTagOf(c, job.id) } });
      return store.jobs.update(job.id, { status: 'failed', error: invalid, finishedAt: nowIso(c), ...(known ? { rerunOf: known.id } : {}) });
    });
  }

  return {
    store,

    ingest(item, source) {
      return ingest(item, source);
    },

    changedSince(item, jobId) {
      return changedSince(store, item, jobId === undefined ? undefined : store.jobs.get(jobId));
    },

    cancel(jobId, reason) {
      try {
        commands.cancel(jobId, reason);
      } catch (e) {
        // Already terminal or gone: the source's signal came late; nothing to do.
        if (!(e instanceof EngineError)) throw e;
      }
    },

    finishWaiting(jobId, result) {
      try {
        commands.finishWaiting(jobId, result);
      } catch (e) {
        // No longer on its own wait (it went on, or ended): the source's signal came late; its next check says again.
        if (!(e instanceof EngineError)) throw e;
      }
    },

    refresh(jobId, item, source) {
      const routedBy = route(c, item, source);
      const priority = clamp(routedBy?.set.priority ?? item.priority);
      const reason = routedBy?.set.priority !== undefined ? `rule:${routedBy.rule}` : item.priorityReason;
      const to = fromConfigFor(item, routedBy);
      return store.tx(() => {
        const job = store.jobs.get(jobId);
        if (!job || TERMINAL_STATUSES.includes(job.status)) return false;
        let changed = false;
        // A job queued before origins were judged (issue #652, the backfill): its issue is offered once it is of a trusted
        // origin or a person approved it; the job takes that origin, and its hold goes.
        if (job.originPending && item.origin && job.source) {
          store.jobs.update(jobId, { originPending: undefined, source: { ...job.source, origin: item.origin, ...(item.originActs ? { originActs: item.originActs } : {}), ...linksOf(item) } });
          store.jobs.restamp(jobId); // its trust stamp from the origin now judged (issue #655)
          store.events.append({ type: 'job.origin_judged', jobId, data: { key: item.key, origin: item.origin } });
          changed = true;
        }
        // Only a job that has not started: a started one resumes in the pane and work tree it ran in.
        // Its item's text changed while it waits (issue #662): held, its text kept. The task text is never refreshed.
        if (refreshText(c, job, item, source)) changed = true;
        // A started one runs the text it started with: an edit of its item lowers its trust (issue #655 part 7).
        else if (refreshEdit(c, job, item, source)) changed = true;
        const was = job.fromConfig ?? fromSpec(job.spec);
        const waiting = job.status === 'queued' || job.status === 'held';
        if (waiting && job.attempts === 0 && job.pendingAnswer === undefined && !same(was, to)) {
          const spec = respecified(job, to, routedBy);
          const invalid = problemWith(c, item, spec);
          if (invalid !== undefined) console.warn(`hopper: job ${jobId} keeps its spec: ${invalid}`);
          else {
            store.jobs.respecify(jobId, spec);
            store.jobs.update(jobId, { fromConfig: to });
            store.events.append({ type: 'job.respecified', jobId, data: { from: was, to } });
            changed = true;
          }
        }
        // The priority is the job's live one (issue #535): a started job's follows its item too, so it is tagged and
        // listed by it everywhere — its question, its login, its lane.
        // A new priority ends its place in the user order (issue #1776): it then waits at that priority (issue #461).
        if (job.priority !== priority) {
          store.jobs.update(jobId, { priority, userRank: undefined });
          store.events.append({ type: 'job.reprioritized', jobId, data: { from: job.priority, to: priority, reason } });
          // Its forks carry its priority (issue #548): the ones still at work follow it.
          for (const forkId of job.forks ?? []) {
            const fork = store.jobs.get(forkId);
            if (!fork || TERMINAL_STATUSES.includes(fork.status) || fork.priority === priority) continue;
            store.jobs.update(forkId, { priority, userRank: undefined });
            store.events.append({ type: 'job.reprioritized', jobId: forkId, data: { from: fork.priority, to: priority, reason: `its parent job ${jobId}: ${reason}` } });
          }
          changed = true;
        }
        return changed;
      });
    },

    // A reply on the issue thread (issue #435): the question settles as a person's answer, and its job resumes.
    answerFromThread: (questionId, answer, by) => c.questions.settleWith(questionId, answer, by, 'a reply on the issue thread') !== undefined,
    // A trusted account's comment on its issue or pull request (issue #2159): the job's own wait ends, and it is told the comment.
    wakeOnComment(jobId, since, comment, told) {
      const woken = store.tx(() => recordCommentWake(c, jobId, since, comment, told)) !== undefined;
      if (woken) c.trigger('job.wait_ended');
      return woken;
    },

    finishOperatorLed(jobId) {
      return store.tx(() => {
        if (store.jobs.get(jobId)?.status !== 'operator_led') return false;
        store.jobs.update(jobId, { status: 'finished', finishedAt: nowIso(c) });
        store.events.append({ type: 'job.finished', jobId, data: { result: 'operator-led work complete' } });
        return true;
      });
    },

    finishComplete(jobId, partlyDone) {
      return store.tx(() => {
        if (store.jobs.get(jobId)?.status !== 'failed') return false;
        store.jobs.update(jobId, { status: 'finished', error: undefined, finishedAt: nowIso(c), ...(partlyDone ? { partlyDone } : {}) });
        store.events.append({ type: 'job.finished', jobId, data: { result: partlyDone ? 'partly done' : 'pull request ready for review', ...(partlyDone ? { partlyDone } : {}) } });
        return true;
      });
    },

    finishShipped(jobId, result) {
      return store.tx(() => {
        const job = store.jobs.get(jobId);
        if (job?.status !== 'failed') return false;
        // Its end is told to its source again: finished, in place of a failure already reported.
        const sync = { ...(job.sourceState?.sync ?? {}), finalReported: false };
        store.jobs.update(jobId, { status: 'finished', error: undefined, finishedAt: nowIso(c), sourceState: { ...job.sourceState, sync }, ...(result ? { result } : {}) });
        store.events.append({ type: 'job.finished', jobId, data: { result: result ?? 'issue closed as complete' } });
        return true;
      });
    },

    setSourceState(jobId, state) {
      store.tx(() => {
        if (store.jobs.get(jobId)) store.jobs.update(jobId, { sourceState: state });
      });
    },

    rerun(jobId, item, source, by = 'user', brief, acting) {
      return store.tx(() => {
        const ended = store.jobs.get(jobId);
        if (!ended) throw new EngineError('not_found', `job ${jobId} not found`);
        // A sync that offered the item between the source giving it back and now made the new job already.
        const job = ingest(originFrom(item, ended), source, brief, by === 'tending') ?? store.jobs.getBySourceKey(item.key)!;
        store.events.append({ type: 'job.rerun', jobId, data: { by, ...acting } });
        return job;
      });
    },

    rework(jobId, item, source, rework, acting) {
      return store.tx(() => {
        const ended = store.jobs.get(jobId);
        if (!ended) throw new EngineError('not_found', `job ${jobId} not found`);
        // It no longer follows its pull request: the new job does, once it ends done (issue #724).
        store.jobs.update(jobId, { sourceState: { ...ended.sourceState, source: rework.state } });
        const made = ingest(originFrom(item, ended), source, reworkBrief(rework.pullRequest, rework.notes)) ?? store.jobs.getBySourceKey(item.key)!;
        const job = store.jobs.update(made.id, { rework: { pullRequest: rework.pullRequest, notes: rework.notes, at: nowIso(c), ...acting } });
        store.events.append({ type: 'job.rework_requested', jobId, data: { pullRequest: rework.pullRequest, notes: rework.notes, nextJobId: job.id, ...acting } });
        return job;
      });
    },

    continueJob(jobId, brief, by) {
      return store.tx((): RerunResult => {
        const job = store.jobs.get(jobId);
        if (!job) return { ok: false, reason: 'not_found', message: `job ${jobId} not found` };
        // Push it (issue #1010) goes on with a finished or cancelled job's kept work too.
        const ends: readonly string[] = 'keptWork' in by ? PUSHABLE_ENDS : ['failed'];
        if (!ends.includes(job.status)) return { ok: false, reason: 'conflict', message: `job ${jobId} is ${job.status}: only a ${'keptWork' in by ? 'failed, finished or cancelled' : 'failed'} job can be continued` };
        if (job.source && store.jobs.getBySourceKey(job.source.key)?.id !== jobId) return { ok: false, reason: 'conflict', message: `job ${jobId} cannot be continued: a newer job of its item exists` };
        const machineId = machineRanOn(job);
        // Its end is told to its source again: the claim, then however this run ends.
        const sync = { ...(job.sourceState?.sync ?? {}), claimReported: false, finalReported: false, cancelReason: undefined };
        const next = store.jobs.update(jobId, {
          status: 'queued', pendingAnswer: brief, continued: { at: nowIso(c), ...by }, ...(machineId ? { resumeOn: machineId } : {}),
          error: undefined, errorTail: undefined, liveness: undefined, finishedAt: undefined, assessment: undefined, dismissedAt: undefined, result: undefined,
          holdReason: undefined, waitReason: undefined, laneId: undefined, sourceState: { ...job.sourceState, sync },
        });
        // Push it (issue #1777): its failure record waits on nothing now, so its problem's release runs nothing. A hand-off's
        // Continue and the assessor's settle their own record.
        if ('keptWork' in by) settleLiveAgain(store, jobId, nowIso(c));
        store.events.append({ type: 'job.continued', jobId, data: { ...by } });
        return { ok: true, job: next };
      });
    },
  };
}
