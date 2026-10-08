// What the Failures view reads (issue #509): the open problems and those resolved in the last day, the newest
// assessed failures, the profile — and, on each problem and failure, whether the daemon takes each action now and
// why not. The routes refuse with the same reasons, so the view offers only what is taken.
import type { UserStore } from '../domain/ports.ts';
import type { Allowed, FailureRecord, FailureSettings, FailuresView, Problem, ProblemView } from '../domain/types.ts';
import { knownCauses } from './causes.ts';
import { profileOf } from './profile.ts';

const DAY_MS = 86_400_000;
const PROFILE_DAYS = 14;
const RECENT = 50;
const OK: Allowed = { ok: true };
const no = (why: string): Allowed => ({ ok: false, why });

type Reads = Pick<UserStore, 'failures' | 'problems' | 'jobs'>;

/** Whether the job can run again: it exists, has a source, and is the newest job of its item. */
function newestOfItem(store: Reads, jobId: string): Allowed {
  const job = store.jobs.get(jobId);
  if (!job) return no('its job is gone');
  if (!job.source) return no('its job has no source to run it again');
  if (store.jobs.getBySourceKey(job.source.key)?.id !== jobId) return no('a newer job of its item exists');
  return OK;
}

/** The records of a problem whose jobs wait on its release, and can run again. */
export function releasable(store: Reads, problemId: string): FailureRecord[] {
  return store.failures.list({ problemId }).filter((r) => r.outcome === 'held' && r.pending === undefined && newestOfItem(store, r.jobId).ok);
}

/** Whether a person may run a failure's job again now. */
export function recordRetry(store: Reads, r: FailureRecord): Allowed {
  if (r.pending) return no(r.pending === 'retry' ? 'it runs again by itself' : 'it is being run again');
  if (r.outcome === 'retried' || r.outcome === 'redirected' || r.outcome === 'released') return no('already run again');
  if (r.outcome === 'held') return no('it waits on its problem: resolve or release it');
  return newestOfItem(store, r.jobId);
}

function problemView(store: Reads, p: Problem): ProblemView {
  const held = releasable(store, p.id);
  return {
    ...p, held: held.map((r) => r.jobId),
    actions: { resolve: p.status === 'open' ? OK : no('already resolved'), release: held.length > 0 ? OK : no('no job is held') },
  };
}

export function viewOf(store: Reads & Pick<UserStore, 'settings'>, settings: FailureSettings, now: Date): FailuresView {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const resolved = store.problems.list({ status: 'resolved', limit: 50 }).filter((p) => (p.resolvedAt ?? '') >= dayAgo);
  const since = new Date(now.getTime() - PROFILE_DAYS * DAY_MS).toISOString();
  return {
    now: now.toISOString(),
    settings,
    causes: knownCauses(store.settings.getNamedCauses()),
    problems: [...store.problems.list({ status: 'open' }), ...resolved].map((p) => problemView(store, p)),
    recent: store.failures.list({ limit: RECENT }).map((r) => ({ ...r, actions: { retry: recordRetry(store, r) } })),
    profile: profileOf(store.failures.list({ since, limit: 5000 }), now.toISOString(), { days: PROFILE_DAYS, generalThreshold: settings.groupThreshold }),
  };
}
