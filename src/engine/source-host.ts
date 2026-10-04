// The engine as a SourceHost (ports.ts): everything the sync loop may do to the hopper. Each
// write is one store.tx that re-reads the job (compare-and-set), so a re-sort can never land on a
// job a Decision has just claimed. design.md "Job sources".
import type { SourceHost, SourceItem } from '../domain/ports.ts';
import { isRerunnable } from '../domain/types.ts';
import type { Job, JobSourceRef, JobSpec } from '../domain/types.ts';
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

function specFor(item: SourceItem, source: { name: string }, priority: number): JobSpec {
  const payload = { prompt: item.prompt, cwd: item.cwd, ...(item.model ? { model: item.model } : {}), env: item.env };
  return { executor: item.executor, payload, priority, goal: item.title, submittedBy: `${source.name}:${item.author}`, kind: 'coding' };
}

/** Why the item cannot run, or undefined: the source's own verdict first, then the executor's. */
function problemWith(c: EngineContext, item: SourceItem, spec: JobSpec): string | undefined {
  if (item.invalid) return item.invalid;
  const executor = c.executors.get(spec.executor);
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
      const priority = clamp(item.priority);
      const ref = refFor(item, source);
      const spec = specFor(item, source, priority);
      const invalid = problemWith(c, item, spec);
      return store.tx((): Job => {
        const job = store.jobs.create(spec, priority, ref);
        store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority, source: ref } });
        if (invalid === undefined) return job;
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

    answer: (questionId, answer) => c.questions.answerByHuman(questionId, answer),

    reprioritize(jobId, to, reason) {
      return store.tx(() => {
        const job = store.jobs.get(jobId);
        const next = clamp(to);
        if (!job || (job.status !== 'queued' && job.status !== 'held') || job.priority === next) return false;
        store.jobs.update(jobId, { priority: next });
        store.events.append({ type: 'job.reprioritized', jobId, data: { from: job.priority, to: next, reason } });
        return true;
      });
    },

    setSourceState(jobId, state) {
      store.tx(() => {
        if (store.jobs.get(jobId)) store.jobs.update(jobId, { sourceState: state });
      });
    },
  };
}
