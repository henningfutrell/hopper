// After done (issue #579), the sync loop's half, at each sync of a source, on each job's report chain. A finished job
// whose pull request its report kept to follow is asked of its source (`JobSource.follow`): merged or closed without a
// merge is recorded (`job.pull_request_merged`, `job.pull_request_closed`) with the source state it leaves — and its item
// closed as not planned upstream, abandoned (`job.pull_request_abandoned`, issue #428); still open,
// what was seen of it is kept, with no event (issue #637). A merge recorded as the whole item before issue #721 is asked
// once more (`rechecksMerge`), for the newest job of its item only: a part after all is recorded again as a part. And a job
// that failed only for want of a merged pull request — `not complete:`, from before a pull request was done — and still
// waits on a person is judged again: done or partly done now, it is finished (its hand-off closes on `job.finished`) and
// its end reported again, so its issue loses `hopper:failed`. A throw is kept as a retry and asked again next sync.
// A person's Merge now or Close PR (issue #677) is the same follow, with the act, on the same chain: recorded the same
// way, with who pressed it; a throw goes back to the person.
// Tending (issue #736): a followed pull request that, as last seen, has merge conflicts or failing checks is not left for a
// person. After its follow, off the report chain, the job's item runs again (`tend`, Run again by `tending`) with the tend
// brief; the job follows it no more (`follow: tended`) and `job.pull_request_tended` names the new job, which brings the
// same pull request back to ready, or fails saying why and waits on a person. At most `MAX_TENDS` in a row of one pull
// request. A refusal because a newer job of the item exists is no failure; any other is kept as a retry.
// Reconciling (issue #763): each sync, before the follows, a done job that follows no pull request (`reconcilable`) and is
// the newest of its item is matched to its item's open pull request on the source (`unfollowedPullRequests`); one found is
// followed from now on (`follow: open`, `job.pull_request_followed`), on the job's report chain: a job that ended before the
// hopper followed pull requests is shown, merged and tended as a job's own. A throw is asked again next sync.
// A pull request is followed to its end (issue #786): a failed job's is reconciled, followed and tended as a done job's —
// but a failed tend's (`failedTend`), which waits on a person —, and a rebase tend is never capped, only `fix_checks`.
// The tending queue (issue #796): after every follow of the sync, a tend starts only when no head holds it (`queueHeads`):
// a tend job at work, or a pull request on its way to the hopper's merge. Jev's pick first (`merge-order`, `tend-order.ts`),
// then the rules' order (`tendOrder`). A pull request whose checks stay pending
// holds it no more than `PENDING_HOLD_MS` after its last push; one not seen yet holds nothing (issue #927). A `fix_checks`
// brief names the checks that failed, and the first fix of a row may run a flaky one again once (issue #927).
// One queue per set of pull requests that conflict (issue #939): a head holds only the due pull requests the source says
// conflict with it (`JobSource.conflictBetween`, the hopper's mirror), and two due ones that do not conflict are tended at
// the same time. Where the source cannot say, they conflict, as before. What holds one is kept on its job (`heldBehind`).
// Cross-references (issue #430): before each follow, the cross-references of the job's item (`JobSource.crossReferences`) are
// asked again and kept on the job (`crossReferences`), when they changed. A throw is only logged: the follow goes on, and
// they are asked again next sync.
import type { JobSource, PullRequestActResult, RerunResult, SourceHost, UserStore } from '../domain/ports.ts';
import { queueHeads, repoOf, tendOrder, type Holds, type QueueHead, type TendDue } from '../domain/tending-queue.ts';
import { pickHead } from './tend-order.ts';
import { SourceError } from '../domain/ports.ts';
import {
  failedTend, following, followsWhenEnded, judge, MAX_TENDS, rechecksMerge, reconcilable, tendBrief, tendsInRow, tendStep,
  type ActingPerson, type FollowUp, type FoundPullRequest, type Job, type JevFirst, type PullRequestAct, type PullRequestSeen, type Tended, type TendChecks,
} from '../domain/types.ts';

export interface AfterDoneContext {
  store: Pick<UserStore, 'jobs' | 'events' | 'handoffs'>;
  host: Pick<SourceHost, 'finishComplete'>;
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  /** The job's source while the sync loop runs it, else undefined. */
  sourceOf(job: Job): JobSource | undefined;
  /** Whether the job's end is reported to its source. */
  finalReported(job: Job): boolean;
  /** Keep the job's new source state. */
  setSource(jobId: string, source: Record<string, unknown>): void;
  /** Report the job's end again: a finish replaced its reported failure. */
  reportAgain(jobId: string): void;
  /** Asking the source failed: kept as the job's retry. */
  failed(jobId: string, e: unknown): void;
  /** Run the job's item again with `brief`, by `tending` (issue #736): Run again's own path, off the report chain. */
  tend(jobId: string, brief: string): Promise<RerunResult>;
  /** The time now, in ms: how long a pull request whose checks run holds its tending queue (issue #927). */
  now(): number;
  /** Jev first, for the head of a tending queue (issue #796); absent: the rules pick. */
  jevFirst?: JevFirst;
}

const NOT_COMPLETE = /^not complete: /;

export function createAfterDone(c: AfterDoneContext) {
  const { store } = c;

  /** Only the newest job of its item is checked again: an older one's merge never takes off a later job's `hopper:done`. */
  const newestOfItem = (j: Job) => !j.source || store.jobs.getBySourceKey(j.source.key)?.id === j.id;
  const rechecks = (j: Job) => rechecksMerge(j) && newestOfItem(j);

  /** Keep what following found, and record a merge or a close: by the hopper, by `acting`, or as seen on GitHub. */
  function record(jobId: string, r: FollowUp, acting?: ActingPerson): void {
    c.setSource(jobId, r.state);
    if (r.outcome === 'open' || r.outcome === 'checked') return;
    store.events.append({
      type: r.outcome === 'merged' ? 'job.pull_request_merged' : r.outcome === 'abandoned' ? 'job.pull_request_abandoned' : 'job.pull_request_closed', jobId,
      data: { pullRequest: r.pullRequest, part: r.part, ...(r.byHopper ? { byHopper: true } : {}), ...(acting ? { person: acting.person, via: acting.via } : {}) },
    });
  }

  /** Keep the cross-references of a following job's item (issue #430), when they changed; a throw is logged, not kept as a retry. */
  async function crossReference(source: JobSource, job: Job): Promise<void> {
    if (!source.crossReferences || !following(job)) return;
    try {
      const crossReferences = await source.crossReferences(job);
      const s = store.jobs.get(job.id)?.sourceState?.source ?? {};
      if (JSON.stringify(crossReferences) !== JSON.stringify(s.crossReferences ?? [])) c.setSource(job.id, { ...s, crossReferences });
    } catch (e) {
      console.warn(`hopper: ${source.name}: the cross-references of job ${job.id} failed, asked again next sync: ${(e as Error).message}`);
    }
  }

  async function follow(source: JobSource, jobId: string): Promise<void> {
    let job = store.jobs.get(jobId);
    if (!job || !(following(job) || rechecks(job))) return;
    await crossReference(source, job);
    job = store.jobs.get(jobId) ?? job;
    const r = await source.follow!(job);
    if (r) record(jobId, r);
  }

  /** A person's Merge now or Close PR (issue #677), on the job's report chain. */
  async function act(jobId: string, what: PullRequestAct, acting: ActingPerson): Promise<PullRequestActResult> {
    const job = store.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found', message: `job ${jobId} not found` };
    const source = c.sourceOf(job);
    if (!source?.follow) return { ok: false, reason: 'conflict', message: `job ${jobId}: its source is not running, or follows no pull request` };
    let result: PullRequestActResult = { ok: false, reason: 'source', message: 'not sent' };
    await c.enqueue(jobId, async () => { result = await actOn(source, jobId, what, acting); });
    return result;
  }

  /** Asked of the source with the act, then recorded as a follow is; a throw goes back to the person. */
  async function actOn(source: JobSource, jobId: string, what: PullRequestAct, acting: ActingPerson): Promise<PullRequestActResult> {
    const job = store.jobs.get(jobId);
    if (!job || !following(job)) return { ok: false, reason: 'conflict', message: `job ${jobId} has no open pull request` };
    try {
      const r = await source.follow!(job, what);
      if (!r) return { ok: false, reason: 'conflict', message: `job ${jobId} has no open pull request` };
      record(jobId, r, acting);
      return { ok: true, outcome: r.outcome, pullRequest: r.pullRequest, part: r.part };
    } catch (e) {
      const refused = e instanceof SourceError && e.permanent;
      return { ok: false, reason: refused ? 'conflict' : 'source', message: `${what === 'merge' ? 'merge' : 'close'} refused: ${(e as Error).message}` };
    }
  }

  async function judgeAgain(source: JobSource, jobId: string): Promise<void> {
    const job = store.jobs.get(jobId);
    if (job?.status !== 'failed') return;
    const v = await judge(source, job);
    if (!v.done && !('partlyDone' in v)) return;
    if (c.host.finishComplete(jobId, 'partlyDone' in v ? v.partlyDone : undefined)) c.reportAgain(jobId);
  }

  /**
   * Its followed pull request needs tending (issue #736), and it may be: the step, its URL, and what the brief says of its
   * checks — the ones that failed, and a rerun for the first fix of a row (issue #927); else undefined.
   */
  function tendDue(job: Job | undefined): { step: NonNullable<ReturnType<typeof tendStep>>; url: string; checks: TendChecks } | undefined {
    if (!job || !followsWhenEnded(job) || !following(job)) return undefined;
    const s = job.sourceState?.source as { pullRequest?: string; seen?: PullRequestSeen } | undefined;
    const step = tendStep(s?.seen);
    if (!step || !s?.pullRequest) return undefined;
    const inRow = step === 'fix_checks' ? tendsInRow(job, s.pullRequest, (id) => store.jobs.get(id)) : 0;
    if (inRow >= MAX_TENDS) return undefined;
    return { step, url: s.pullRequest, checks: { failed: s.seen?.failedChecks ?? [], rerun: inRow === 0 } };
  }

  /** Tend the job's followed pull request when it needs it (issue #736): its item runs again with the tend brief. */
  async function tendIfDue(jobId: string): Promise<void> {
    const due = tendDue(store.jobs.get(jobId));
    if (!due) return;
    const r = await c.tend(jobId, tendBrief(due.url, due.step, due.checks));
    if (!r.ok) {
      if (r.reason !== 'conflict') c.failed(jobId, new Error(r.message));
      return;
    }
    const job = store.jobs.get(jobId);
    if (!job) return;
    const tended: Tended = { pullRequest: due.url, step: due.step, nextJobId: r.job.id };
    c.setSource(jobId, { ...(job.sourceState?.source ?? {}), follow: 'tended', tended });
    store.events.append({ type: 'job.pull_request_tended', jobId, data: { pullRequest: due.url, step: due.step, nextJobId: r.job.id } });
  }

  /** Keep what holds the job's pull request (issue #939), when it changed; undefined: nothing holds it. */
  function keepHold<K extends keyof Holds>(jobId: string, key: K, value: Holds[K]): void {
    const s = (store.jobs.get(jobId)?.sourceState?.source ?? {}) as Record<string, unknown>;
    if (JSON.stringify(s[key]) === JSON.stringify(value)) return;
    const { [key]: _was, ...rest } = s;
    c.setSource(jobId, value === undefined ? rest : { ...rest, [key]: value });
  }

  /**
   * Whether the job's pull request conflicts with pull request `other` of its repository (issue #939), as the source says;
   * undefined: it cannot say. A throw is only logged.
   */
  async function conflict(source: JobSource, job: Job, other: string): Promise<boolean | undefined> {
    const s = job.sourceState?.source as { pullRequest?: string; seen?: PullRequestSeen } | undefined;
    if (!source.conflictBetween || !s?.pullRequest || !s.seen?.base || !job.source?.repo) return undefined;
    try {
      return await source.conflictBetween(job.source.repo, s.seen.base, s.pullRequest, other);
    } catch (e) {
      console.warn(`hopper: ${source.name}: whether ${s.pullRequest} and ${other} conflict failed, asked again next sync: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** The first of `heads` the job's pull request conflicts with (issue #939); where the source cannot say, it conflicts. */
  async function heldBy(source: JobSource, job: Job, heads: readonly QueueHead[]): Promise<QueueHead | undefined> {
    for (const h of heads) if (await conflict(source, job, h.pullRequest) !== false) return h;
    return undefined;
  }

  /**
   * The tends of each job repository (issue #796), one queue per set of pull requests that conflict (issue #939): of the
   * source's jobs whose followed pull request needs tending, each one no head and no tend started before it conflicts with,
   * Jev's pick first, then the rules' order. Each other is held behind the first that conflicts with it.
   */
  async function tendNext(source: JobSource, listed: Job[]): Promise<void> {
    const get = (id: string) => store.jobs.get(id);
    const jobs = listed.map((j) => get(j.id) ?? j);
    const due = jobs.filter((j) => c.finalReported(j)).flatMap((j): TendDue[] => { const d = tendDue(j); return d ? [{ jobId: j.id, pullRequest: d.url, step: d.step }] : []; });
    const merges = (repo: string) => source.mergesOnReady?.(repo) ?? false;
    const held = new Map<string, QueueHead>();
    for (const repo of new Set(due.map((d) => repoOf(get(d.jobId)!)))) {
      if (repo === undefined) continue;
      const heads = queueHeads(repo, jobs, get, merges, c.now());
      const free: TendDue[] = [];
      for (const d of tendOrder(due.filter((x) => repoOf(get(x.jobId)!) === repo), get)) {
        const h = await heldBy(source, get(d.jobId)!, heads);
        if (h) held.set(d.jobId, h); else free.push(d);
      }
      if (free.length === 0) continue;
      const first = await pickHead(c.jevFirst, repo, free, get);
      const started: QueueHead[] = [];
      for (const d of [first, ...free.filter((x) => x !== first)]) {
        const h = await heldBy(source, get(d.jobId)!, started);
        if (h) { held.set(d.jobId, h); continue; }
        keepHold(d.jobId, 'heldBehind', undefined);
        started.push({ pullRequest: d.pullRequest, why: 'tending' });
        await tendIfDue(d.jobId).catch((e: unknown) => { c.failed(d.jobId, e); });
      }
    }
    for (const j of jobs) keepHold(j.id, 'heldBehind', held.get(j.id));
  }

  /** May follow its item's open pull request (issues #763, #786): no failed tend, and the newest job of its item. */
  const adoptable = (j: Job) => reconcilable(j) && newestOfItem(j) && !failedTend(j, (id) => store.jobs.get(id));

  /** Follow the open pull request found for an ended job that follows none (issue #763), if it still follows none. */
  function adopt(f: FoundPullRequest): void {
    const job = store.jobs.get(f.jobId);
    if (!job || !adoptable(job)) return;
    const { part: _p, seen: _s, parts: _ps, mergeChecked: _m, ...rest } = (job.sourceState?.source ?? {}) as Record<string, unknown>;
    c.setSource(job.id, { ...rest, pullRequest: f.pullRequest, follow: 'open', ...(f.part ? { part: true } : {}) });
    store.events.append({ type: 'job.pull_request_followed', jobId: job.id, data: { pullRequest: f.pullRequest, part: f.part } });
  }

  /** Reconcile the source's done jobs that follow no pull request with it (issue #763); not while it is paused. */
  async function reconcile(source: JobSource, jobs: Job[]): Promise<void> {
    const candidates = jobs.filter((j) => adoptable(j) && c.finalReported(j));
    if (!source.unfollowedPullRequests || candidates.length === 0 || source.paused?.() !== undefined) return;
    try {
      const found = await source.unfollowedPullRequests(candidates);
      await Promise.all(found.map((f) => c.enqueue(f.jobId, async () => { adopt(f); })));
    } catch (e) {
      console.warn(`hopper: ${source.name}: reconciling pull requests failed, asked again next sync: ${(e as Error).message}`);
    }
  }

  const waitsOnPerson = (j: Job) => j.status === 'failed' && NOT_COMPLETE.test(j.error ?? '') && store.handoffs.forJob(j.id)?.status === 'open';

  return {
    act,
    /** One sync of the source: every job of its to follow, or to judge again. */
    async catchUp(source: JobSource, listed: Job[]): Promise<void> {
      await reconcile(source, listed);
      const jobs = listed.map((j) => store.jobs.get(j.id) ?? j);
      const run = (j: Job, fn: (s: JobSource, id: string) => Promise<void>) =>
        c.enqueue(j.id, () => fn(source, j.id).catch((e: unknown) => { c.failed(j.id, e); }));
      const followOf = async (id: string): Promise<void> => {
        const j = store.jobs.get(id);
        if (j && followsWhenEnded(j) && source.follow && (following(j) || rechecks(j))) await run(j, follow);
      };
      // A failed job that waits on a person is judged again first (issue #786: it may follow its pull request too).
      await Promise.all(jobs.filter((j) => c.finalReported(j)).map((j) =>
        (waitsOnPerson(j) ? run(j, judgeAgain).then(() => followOf(j.id)) : followOf(j.id))));
      // The tends run after every follow, off the report chain (Run again takes that chain itself): one per repository.
      await tendNext(source, listed);
    },
  };
}
