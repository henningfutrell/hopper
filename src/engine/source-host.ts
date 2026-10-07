// The engine as a SourceHost (ports.ts): everything the sync loop may do to the hopper. Each
// write is one store.tx that re-reads the job (compare-and-set), so a re-sort can never land on a
// job a Decision has just claimed. design.md "Job sources".
import type { SourceHost, SourceItem } from '../domain/ports.ts';
import { isRerunnable } from '../domain/types.ts';
import type { Job, JobSourceRef, JobSpec, RoutedBy } from '../domain/types.ts';
import { routeItem } from '../routing/index.ts';
import type { Commands } from './commands.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

const clamp = (p: number): number => Math.max(0, Math.min(100, p));

function refFor(item: SourceItem, source: { name: string; kind: string }): JobSourceRef {
  return {
    source: source.name, kind: source.kind, key: item.key, url: item.url, title: item.title, author: item.author,
    ...(item.repo !== undefined ? { repo: item.repo } : {}),
    ...(item.number !== undefined ? { number: item.number } : {}),
  };
}

function specFor(item: SourceItem, source: { name: string }, priority: number, routedBy: RoutedBy | undefined): JobSpec {
  // `body` is the item's own text, without the context block: what the command executor runs.
  const payload = { prompt: item.prompt, body: item.body, cwd: item.cwd, ...(item.model ? { model: item.model } : {}), env: item.env };
  return {
    executor: routedBy?.set.executor ?? item.executor, payload, priority, goal: item.title, submittedBy: `${source.name}:${item.author}`, kind: 'coding',
    ...(routedBy?.set.machine !== undefined ? { machineId: routedBy.set.machine } : {}),
    ...(routedBy ? { routedBy } : {}),
  };
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

export function createSourceHost(c: EngineContext, commands: Pick<Commands, 'cancel'>): SourceHost {
  const { store } = c;
  return {
    store,

    ingest(item, source) {
      const known = store.jobs.getBySourceKey(item.key);
      if (known && !isRerunnable(known)) return null;
      const routedBy = route(c, item, source);
      const priority = clamp(routedBy?.set.priority ?? item.priority);
      const ref = refFor(item, source);
      const spec = specFor(item, source, priority, routedBy);
      const invalid = problemWith(c, item, spec);
      return store.tx((): Job => {
        const job = store.jobs.create(spec, priority, ref);
        store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority, source: ref } });
        // Every new job waits at the queue gate (issue #159) until the pre-sort or the user accepts it.
        if (invalid === undefined) return store.jobs.update(job.id, { accepted: false });
        // Created and failed together: the source reports claimed, then failed — once.
        store.events.append({ type: 'job.failed', jobId: job.id, data: { error: invalid } });
        return store.jobs.update(job.id, { status: 'failed', error: invalid, finishedAt: nowIso(c) });
      });
    },

    cancel(jobId, reason) {
      try {
        commands.cancel(jobId, reason);
      } catch (e) {
        // Already terminal or gone: the source's signal came late; nothing to do.
        if (!(e instanceof EngineError)) throw e;
      }
    },

    reprioritize(jobId, to, reason) {
      return store.tx(() => {
        const job = store.jobs.get(jobId);
        const next = clamp(to);
        if (!job || (job.status !== 'queued' && job.status !== 'held') || job.priority === next) return false;
        // A routing rule set this job's priority at intake: the source's re-sort does not undo it.
        if (job.spec.routedBy?.set.priority !== undefined) return false;
        store.jobs.update(jobId, { priority: next });
        store.events.append({ type: 'job.reprioritized', jobId, data: { from: job.priority, to: next, reason } });
        return true;
      });
    },

    finishOperatorLed(jobId) {
      return store.tx(() => {
        if (store.jobs.get(jobId)?.status !== 'operator_led') return false;
        store.jobs.update(jobId, { status: 'finished', finishedAt: nowIso(c) });
        store.events.append({ type: 'job.finished', jobId, data: { result: 'operator-led work complete' } });
        return true;
      });
    },

    setSourceState(jobId, state) {
      store.tx(() => {
        if (store.jobs.get(jobId)) store.jobs.update(jobId, { sourceState: state });
      });
    },

    rerun(jobId) {
      return store.tx(() => {
        const job = store.jobs.get(jobId);
        if (!job) throw new EngineError('not_found', `job ${jobId} not found`);
        store.events.append({ type: 'job.rerun', jobId, data: { by: 'user' } });
        return job;
      });
    },
  };
}
