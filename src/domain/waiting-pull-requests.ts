// Pull requests of a waiting job (issue #1143 reopened, design.md "Pull requests of a waiting job"): the newest job of an
// item is on its own wait — an outside event, a person's window —, so no follow reads the pull requests its item's jobs
// opened through the hopper, and no tend starts: a tend is a Run again, and the item has a job at work. One of them that
// gets merge conflicts sat with no signal for as long as the wait lasted. Now each round of every follow reads them, and the
// first one with merge conflicts wakes the job, told to rebase it and wait again. Once for each head of the pull request:
// a job that could not resolve them, and waits again, is not woken again until the pull request's head or a new read
// changes. Pure: the source reads each one, the engine ends the wait.
import type { CompanionRead } from './companion-pull-requests.ts';
import type { Job, JobWait } from './types.ts';
import { waitOnLabel } from './wait-on.ts';

/** What the reads of a waiting job's pull request kept, on the job (`waitingPulls`, by URL): ended, or the head that woke it. */
export interface WaitingSeen { ended?: true; woke?: string }

/** The engine's side (`SourceHost`): a pull request with merge conflicts ends the job's own wait that began at `since`. */
export interface WakesOnConflict {
  /** End the wait, the job told `told`; `job.wait_ended` with `conflicting`. False: it is no longer on that wait. */
  wakeOnConflict(jobId: string, since: string, pullRequest: string, told: string): boolean;
}

type Source = { waitingPulls?: Record<string, WaitingSeen> };
const keptOf = (j: Job): Record<string, WaitingSeen> => (j.sourceState?.source as Source | undefined)?.waitingPulls ?? {};
const order = (a: Job, b: Job) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const GITHUB_PULL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/i;
/** The key of the head a read saw: a pull request whose head GitHub did not say wakes the job once. */
const headKey = (r: CompanionRead): string => r.head ?? 'unknown';

/** A job on its own wait that a pull request can wake: not a wait on its own command, which runs in its pane. */
const wakeable = (j: Job): boolean => j.status === 'waiting_on' && j.wait !== undefined && j.wait.on?.kind !== 'own_command';

/**
 * Each item of `jobs` whose newest job is on a wakeable wait, with the GitHub pull requests its jobs opened through the
 * hopper (`opened`), but the ones a read saw end.
 */
export function waitingPullRequests(jobs: readonly Job[], opened: (jobId: string) => readonly string[]): { job: Job; pulls: string[] }[] {
  const items = new Map<string, Job[]>();
  for (const j of jobs) if (j.source?.key && j.source.repo) items.set(j.source.key, [...(items.get(j.source.key) ?? []), j]);
  const out: { job: Job; pulls: string[] }[] = [];
  for (const js of items.values()) {
    const job = [...js].sort(order).at(-1)!;
    if (!wakeable(job)) continue;
    const kept = keptOf(job);
    const pulls = new Set(js.flatMap((j) => opened(j.id)).filter((u) => GITHUB_PULL.test(u) && !kept[u]?.ended));
    if (pulls.size > 0) out.push({ job, pulls: [...pulls].sort() });
  }
  return out;
}

const readOf = (read: readonly CompanionRead[], url: string) => read.find((r) => r.url.toLowerCase() === url.toLowerCase());

/** The first of `pulls` that `read` saw open with merge conflicts at a head that has not woken `job` yet. */
export function conflictWake(job: Job, pulls: readonly string[], read: readonly CompanionRead[]): CompanionRead | undefined {
  if (!wakeable(job)) return undefined;
  const kept = keptOf(job);
  for (const url of pulls) {
    const r = readOf(read, url);
    if (r?.state === 'open' && r.conflicting && kept[url]?.woke !== headKey(r)) return r;
  }
  return undefined;
}

/** What is kept on `job` after `read`: each one that ended, and the head that woke it, for `woke` (the one that woke it now). */
export function waitingAfter(job: Job, pulls: readonly string[], read: readonly CompanionRead[], woke: string | undefined): Record<string, WaitingSeen> {
  const after = { ...keptOf(job) };
  for (const url of pulls) {
    const r = readOf(read, url);
    if (!r) continue;
    if (r.state !== 'open') after[url] = { ended: true };
    else if (url === woke) after[url] = { woke: headKey(r) };
  }
  return after;
}

/** What the woken job is told: which pull request, its base, what to do, and to wait again on what it waited on. */
export function conflictWakeNote(wait: Pick<JobWait, 'for' | 'on'>, pullRequest: string, base: string | undefined): string {
  const waited = wait.on ? waitOnLabel(wait.on) : wait.for;
  const onto = base ? ` \`${base}\`` : '';
  return `[hopper] The hopper ended your wait (${waited}): your pull request ${pullRequest} has merge conflicts with its base branch${onto}, and no other job works on it while you wait. Fetch, rebase its branch onto its base as just fetched, resolve every conflict and keep the intent of both sides, run the repo's checks, and push with --force-with-lease. Then, if what you waited on has not happened, end your turn with HOPPER_WAITING again, as before. If you cannot resolve the conflicts, say why in your message, and wait again: the hopper does not wake you for the same head again.`;
}
