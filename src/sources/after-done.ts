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
// way, with who pressed it; answered before it runs (issue #1194, pull-request-acts.ts). A person's Tend again (issue #1010) on a pull request the hopper
// gave up on tends it at once, the same step, with who pressed it (tend-again.ts).
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
// The tending queue (issue #796): after every follow of the sync, a tend starts only when no head holds it (`queueHeads`),
// or a head held it an hour (`MAX_HELD_MS`, issue #1143: `heldSince`), as new heads keep coming:
// a tend job at work, or a pull request on its way to the hopper's merge. Jev's pick first (`merge-order`, `tend-order.ts`),
// then the rules' order (`tendOrder`). A pull request whose checks stay pending
// holds it no more than `PENDING_HOLD_MS` after its last push; one not seen yet holds nothing (issue #927). A `fix_checks`
// brief names the checks that failed, and the first fix of a row may run a flaky one again once (issue #927). It quotes each
// failed GitHub Actions job's log, trimmed, which the source reads (`JobSource.checkLogs`, issue #993), or says why it could not.
// One queue per set of pull requests that conflict (issue #939): a head holds only the due pull requests the source says
// conflict with it (`JobSource.conflictBetween`, the hopper's mirror), and two due ones that do not conflict are tended at
// the same time. Where the source cannot say, they conflict, as before. What holds one is kept on its job (`heldBehind`).
// A tend the source refused (issue #967) keeps why on its job (`tendRefused`), until a tend starts: its card says it.
// A tend job cancelled by no person and no source (issue #1010) — the sweep, a restart — is no reason to give up: the same
// step is due again after a wait that doubles each time (`tendRetryAt`), at most `MAX_TEND_RETRIES` in a row.
// Rework goes back at once (issue #938): a `fix_checks` tend is held by no head. Every pull request with failed checks goes
// back to its job in the same sync, limited only by free lanes; only a `rebase` waits for the head it conflicts with.
// Cross-references (issue #430): before each follow, the cross-references of the job's item (`JobSource.crossReferences`) are
// asked again and kept on the job (`crossReferences`), when they changed. A throw is only logged: the follow goes on, and
// they are asked again next sync.
// The base merge (issue #967): a `rebase` tend the queue starts is first asked of the source (`JobSource.baseMerge`, the
// hopper's mirror): it merges the base branch into the pull request and pushes, with no job and no lane, resolving only a
// Markdown conflict where both sides only added lines. Pushed, `job.pull_request_base_merged` records it, and what the job
// saw of its pull request says it has no merge conflicts and its checks run again, so it heads its queue at once. A real
// conflict, or a source that cannot, and the tend job runs as before. A throw is only logged: the tend job runs.
// Rounds (issue #985, the in-motion cycle, `FollowRound`): the sync loop says which follows a sync makes. `all` follows every
// job that follows a pull request, reconciles, judges again and asks the cross-references; `in_motion` follows only the
// pull requests in motion (`inMotion`); `none` follows nothing. Before its follows, a round asks the source for every pull
// request they follow in one batch (`readFollowed`); a throw is logged, and the round follows nothing. Tending runs at every
// sync, from what was last seen.
// Housekeeping (issue #1143): a follow that moved its pull request to the landing branch is recorded
// (`job.pull_request_retargeted`); one that closed it as superseded records the close with why (`superseded`); and a tend
// job started is said on the pull request (`JobSource.tendStarted`). A rebase tend that failed is tended again once its
// base branch moves (issue #1143 part 3): each sync, before the tends, the source says the commit that base is at
// (`JobSource.baseTip`, the hopper's mirror); the first is kept (`tended.baseAt`), and another one marks it moved
// (`tended.baseMoved`), which makes the same step due (`tendRetryAt`), at most `MAX_TEND_RETRIES` in a row. A source that
// cannot say leaves it to a person, as before. A throw is only logged. A tend starts only on an open pull request (issue
// #1456): before each, the source says whether it ended on GitHub (`JobSource.endedPullRequests`); ended, the job follows
// it again at once, and that follow records its end. A tend job whose work item's issue is closed is tended no more (issue
// #2127): before each tend, the source reads it when the ledger does not hold it closed (`JobSource.issueState`).
// Strays (issue #1143 part 4, `strays.ts`): in a round of every one, after reconciling, the pull requests no job follows, of items no job works on, get the same housekeeping.
// The census (issue #1176, `census.ts`): after the strays, at most once an hour, the source lists every open pull request of its job repositories that no job
// names and the ledger does not hold, each with why (`JobSource.censusPullRequests`, `untrackedPullRequests`).
// The work-item ledger (issue #1067, part 3): what an open pull request waits on (its **pull request wait**: a draft, merge
// conflicts, failed checks, checks running, the merge) is recorded as `job.pull_request_seen` when it differs from what the
// ledger holds for it, so the item says what it waits on. What was seen of it stays kept with no event otherwise.
import type { JobSource, RerunResult, SourceHost, UserStore } from '../domain/ports.ts';
import { createTendAgain } from './tend-again.ts'; import { createPullRequestActs } from './pull-request-acts.ts';
import { heldTooLong, queueHeads, repoOf, tendOrder, type Holds, type QueueHead, type TendDue } from '../domain/tending-queue.ts';
import { pickHead } from './tend-order.ts';
import { strayHousekeeping } from './strays.ts'; import { changeOf, keepFollowed } from './keep-followed.ts';
import { pullRequestCensus } from './census.ts'; import { recordCiMiss } from './ci-missed.ts';
import {
  failedTend, following, followsWhenEnded, inMotion, jobPullRequestRepo, judge, MAX_TENDS, rebasesWhenBaseMoves, rechecksMerge, reconcilable, tendBrief, tendRetryAt, tendsInRow, tendStep,
  type ActingPerson, type BaseMerge, type ChangeKind, type FollowUp, type FoundPullRequest, type Job, type JevFirst, type PullRequestSeen, type Tended, type TendChecks,
} from '../domain/types.ts';
import { pullRequestWaitOf } from '../domain/work-items.ts'; import { heldClosed, issueClosed } from './closed-as-complete.ts'; import { followOutcome, traceJobStep } from '../telemetry/job-steps.ts';

export interface AfterDoneContext {
  store: Pick<UserStore, 'jobs' | 'events' | 'handoffs' | 'workItems'>;
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
  /** The source's GitHub outbox sends now (issue #1238 part 3): a Merge now or Close PR is seen at once. */
  sendNow(source: JobSource): void;
}

const NOT_COMPLETE = /^not complete: /;

/** Which follows a sync makes (issue #985): every one, only those in motion, or none. */
export type FollowRound = 'all' | 'in_motion' | 'none';

export function createAfterDone(c: AfterDoneContext) {
  const { store } = c;
  const strays = strayHousekeeping(c), census = pullRequestCensus(c);

  /**
   * The newest of `listed`, from one read of the jobs table (issue #1154): a sync of a source with about 740 ended jobs
   * read each one again and again, a get each, one store call each, while the event loop waited. A job deleted since
   * stays as listed.
   */
  const fresh = (listed: readonly Job[], all = store.jobs.list()): Job[] => {
    const byId = new Map(all.map((j) => [j.id, j]));
    return listed.map((j) => byId.get(j.id) ?? j);
  };
  /** The newest job of each item, by source key, of `all` (newest first, as the store lists them). */
  const newestOfItems = (all: readonly Job[]): Map<string, string> => {
    const newest = new Map<string, string>();
    for (const j of all) if (j.source && !newest.has(j.source.key)) newest.set(j.source.key, j.id);
    return newest;
  };

  /**
   * Only the newest job of its item is checked again: an older one's merge never takes off a later job's `hopper:done`.
   * `newest`: the newest of each item as just read (`newestOfItems`), for a check of many jobs; else a read of its own.
   */
  const newestOfItem = (j: Job, newest?: ReadonlyMap<string, string>) =>
    !j.source || (newest ? newest.get(j.source.key) : store.jobs.getBySourceKey(j.source.key)?.id) === j.id;
  const rechecks = (j: Job) => rechecksMerge(j) && newestOfItem(j);

  /** Keep what following found, and record a merge or a close: by the hopper, by `acting`, or as seen on GitHub. */
  function record(jobId: string, r: FollowUp, acting?: ActingPerson): void {
    keepFollowed(c, jobId, r);
    // Who merged it: the act's, else as its merge marker kept it, after a stop (issue #1588).
    const who = acting ?? r.acting;
    // And a CI run that failed on a check a push requirement stands for (issue #2555 part 5).
    if (r.outcome === 'open') { seen(jobId, r.pullRequest, r.state.seen as PullRequestSeen | undefined); recordCiMiss(store, jobId, r.pullRequest, r.state.seen as PullRequestSeen | undefined); }
    if (r.outcome === 'open' || r.outcome === 'checked') return;
    store.events.append({
      type: r.outcome === 'merged' ? 'job.pull_request_merged' : r.outcome === 'abandoned' ? 'job.pull_request_abandoned' : 'job.pull_request_closed', jobId,
      data: {
        pullRequest: r.pullRequest, part: r.part, ...(r.byHopper ? { byHopper: true } : {}), ...(r.superseded ? { superseded: r.superseded } : {}),
        ...(who ? { person: who.person, via: who.via } : {}),
      },
    });
  }

  /** What the open pull request waits on, recorded when its work item holds another wait for it. */
  function seen(jobId: string, pullRequest: string, s: PullRequestSeen | undefined): void {
    const key = store.jobs.get(jobId)?.source?.key;
    if (!s || key === undefined) return;
    const item = store.workItems.get(key);
    const wait = pullRequestWaitOf(s);
    if (!item || (item.pullRequest !== undefined && item.pullRequest !== pullRequest) || (item.pullRequest === pullRequest && item.pullRequestWait === wait)) return;
    store.events.append({ type: 'job.pull_request_seen', jobId, data: { pullRequest, wait } });
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

  async function follow(source: JobSource, jobId: string, all: boolean): Promise<void> {
    let job = store.jobs.get(jobId);
    if (!job || !(following(job) || rechecks(job))) return;
    if (all) await crossReference(source, job);
    job = store.jobs.get(jobId) ?? job;
    // The merge marker is kept before the hopper's merge call (issue #1588).
    const followed = job;
    const r = await traceJobStep(jobId, 'follow', () => source.follow!(followed, undefined, { keep: (state) => c.setSource(jobId, state) }), followOutcome, { 'hopper.pull_request.act': 'none' });
    if (r) return record(jobId, r);
    // Nothing changed: the ledger may not hold what it waits on yet (it was seen before the ledger read it).
    const s = job.sourceState?.source as { pullRequest?: string; seen?: PullRequestSeen } | undefined;
    if (following(job) && s?.pullRequest) seen(jobId, s.pullRequest, s.seen);
  }

  /** A person's Merge now or Close PR (issue #677), answered at once; it runs on the job's report chain after (issue #1194). */
  const prActs = createPullRequestActs({ store, sourceOf: c.sourceOf, enqueue: c.enqueue, record, sendNow: c.sendNow, setSource: c.setSource });

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
  function tendDue(job: Job | undefined): { step: NonNullable<ReturnType<typeof tendStep>>; url: string; checks: TendChecks; retries?: number } | undefined {
    if (!job || !followsWhenEnded(job)) return undefined;
    const again = retryDue(job);
    if (again) return again;
    if (!following(job)) return undefined;
    const s = job.sourceState?.source as { pullRequest?: string; seen?: PullRequestSeen } | undefined;
    const step = tendStep(s?.seen);
    if (!step || !s?.pullRequest) return undefined;
    const inRow = step === 'fix_checks' ? tendsInRow(job, s.pullRequest, (id) => store.jobs.get(id)) : 0;
    if (inRow >= MAX_TENDS) return undefined;
    return { step, url: s.pullRequest, checks: { failed: s.seen?.failedChecks ?? [], rerun: inRow === 0 } };
  }

  /**
   * A tend of the job's pull request whose tend job was cancelled by no person and no source (issue #1010), due again once
   * its wait is over: the same step, on the job's report as last seen. Only while the cancelled tend job is the newest of
   * the item, and its end is reported.
   */
  function retryDue(job: Job): { step: Tended['step']; url: string; checks: TendChecks; retries: number } | undefined {
    const s = job.sourceState?.source as { follow?: string; tended?: Tended; seen?: PullRequestSeen } | undefined;
    if (s?.follow !== 'tended' || !s.tended || !job.source) return undefined;
    const tendJob = store.jobs.getBySourceKey(job.source.key);
    const at = tendRetryAt(s.tended, tendJob);
    if (at === undefined || at > c.now() || !c.finalReported(tendJob!)) return undefined;
    return { step: s.tended.step, url: s.tended.pullRequest, checks: { failed: s.seen?.failedChecks ?? [], rerun: s.tended.step === 'fix_checks' && tendsInRow(job, s.tended.pullRequest, (id) => store.jobs.get(id)) === 0 },
      // A person's Tend again starts a new row of retries.
      retries: s.tended.again ? 0 : (s.tended.retries ?? 0) + 1 };
  }

  /**
   * Tend the job's followed pull request when it needs it (issue #736): its item runs again with the tend brief. A
   * `fix_checks` brief carries the failed checks' logs, as the source read them (issue #993).
   */
  async function tendIfDue(source: JobSource, jobId: string, acting?: ActingPerson): Promise<RerunResult | undefined> {
    const due = tendDue(store.jobs.get(jobId));
    if (!due) return undefined;
    // A tend job's work item's issue closed (issue #2127): nothing is left to tend, and the tend's Run again would reopen it.
    const ended = await endedBeforeTend(source, jobId, due.url) ?? (await issueClosed(store, source, store.jobs.get(jobId)) ? 'issue' : undefined);
    if (ended) return { ok: false, reason: 'conflict', message: `job ${jobId}'s pull request is not tended: ${ended === 'issue' ? 'its work item\'s issue is closed' : `it was ${ended} on GitHub`}` };
    const checks = due.step === 'fix_checks' && source.checkLogs && due.checks.failed?.length
      ? { ...due.checks, failed: await source.checkLogs(due.checks.failed) } : due.checks;
    const r = await traceJobStep(jobId, 'tend', () => c.tend(jobId, tendBrief(due.url, due.step, checks)), (t) => (t.ok ? 'started' : t.reason), { 'hopper.tend.step': due.step });
    if (!r.ok) {
      // Kept, so the card says why (issue #967): a refusal is never shown as a tend to come.
      keepHold(jobId, 'tendRefused', r.message);
      if (r.reason !== 'conflict') c.failed(jobId, new Error(r.message));
      return r;
    }
    const job = store.jobs.get(jobId);
    if (!job) return r;
    const tended: Tended = { pullRequest: due.url, step: due.step, nextJobId: r.job.id, ...(due.retries ? { retries: due.retries } : {}) };
    const { tendRefused: _r, ...was } = (job.sourceState?.source ?? {}) as Record<string, unknown>;
    c.setSource(jobId, { ...was, follow: 'tended', tended });
    store.events.append({ type: 'job.pull_request_tended', jobId, data: { pullRequest: due.url, step: due.step, nextJobId: r.job.id, ...acting } });
    // The pull request says the hopper works on it (issue #1143).
    await source.tendStarted?.(job, due.url, due.step);
    return r;
  }

  /**
   * Whether the pull request a tend is due for ended on GitHub since it was last seen (issue #1456): a tend works from what
   * was last seen, and a failed tend's job follows its pull request no more, so a pull request closed or merged meanwhile
   * was rebased again and again. Ended: the job follows it again at once, and that follow records its end as any follow
   * does. A read that fails, or a source that cannot say, tends it as before.
   */
  async function endedBeforeTend(source: JobSource, jobId: string, url: string): Promise<'merged' | 'closed' | undefined> {
    const m = /([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url);
    if (!source.endedPullRequests || !source.follow || !m) return undefined;
    const state = await source.endedPullRequests([{ repo: m[1]!, number: Number(m[2]) }]).then((e) => e[0]?.state, (e: unknown) =>
      void console.warn(`hopper: ${source.name}: whether ${url} ended was not read, it is tended: ${(e as Error).message}`));
    if (!state) return undefined;
    const { tended: _t, ...was } = (store.jobs.get(jobId)?.sourceState?.source ?? {}) as Record<string, unknown>;
    c.setSource(jobId, { ...was, pullRequest: url, follow: 'open' });
    await follow(source, jobId, false).catch((e: unknown) => { c.failed(jobId, e); });
    return state;
  }

  const again = createTendAgain({ store, sourceOf: c.sourceOf, finalReported: c.finalReported, setSource: c.setSource, now: c.now, tendIfDue });

  /**
   * The base merge of a due `rebase` (issue #967): whether the source merged the base branch into the pull request and
   * pushed. Pushed: recorded, and the job's `seen` says no merge conflicts and its checks run again from now.
   */
  async function mergedBase(source: JobSource, d: TendDue): Promise<boolean> {
    const job = store.jobs.get(d.jobId);
    if (d.step !== 'rebase' || !source.baseMerge || !job) return false;
    let r: BaseMerge | undefined;
    try {
      r = await traceJobStep(d.jobId, 'base_merge', () => source.baseMerge!(job), (b) => b?.outcome ?? 'none');
    } catch (e) {
      console.warn(`hopper: ${source.name}: the base merge of ${d.pullRequest} failed, a tend job rebases it: ${(e as Error).message}`);
      return false;
    }
    if (r?.outcome !== 'pushed') return false;
    const s = (store.jobs.get(d.jobId)?.sourceState?.source ?? {}) as { seen?: PullRequestSeen };
    if (s.seen) {
      const { failedChecks: _f, failedHead: _h, mergeHeldBehind: _m, ...seen } = s.seen;
      c.setSource(d.jobId, { ...s, seen: { ...seen, conflicting: false, checks: 'pending', pushedAt: new Date(c.now()).toISOString() } satisfies PullRequestSeen });
    }
    store.events.append({ type: 'job.pull_request_base_merged', jobId: d.jobId, data: { pullRequest: d.pullRequest, commit: r.commit, resolved: r.resolved } });
    return true;
  }

  /**
   * Watch the base branch of the job's pull request while its failed rebase tend waits on a person (issue #1143 part 3):
   * the commit the source says it is at is kept first (`baseAt`); another one later marks it moved (`baseMoved`), and the
   * rebase is due again. Only once the tend job's end is reported to its source.
   */
  async function watchBase(source: JobSource, jobId: string): Promise<void> {
    const job = store.jobs.get(jobId);
    const s = job?.sourceState?.source as { follow?: string; tended?: Tended } | undefined;
    if (!source.baseTip || !job?.source || s?.follow !== 'tended' || !s.tended || s.tended.baseMoved) return;
    const tendJob = store.jobs.getBySourceKey(job.source.key);
    if (!tendJob || !rebasesWhenBaseMoves(s.tended, tendJob) || !c.finalReported(tendJob)) return;
    let tip: string | undefined;
    try {
      tip = await source.baseTip(job);
    } catch (e) {
      console.warn(`hopper: ${source.name}: the base branch of ${s.tended.pullRequest} failed, asked again next sync: ${(e as Error).message}`);
      return;
    }
    if (tip === undefined || tip === s.tended.baseAt) return;
    const tended: Tended = s.tended.baseAt === undefined ? { ...s.tended, baseAt: tip } : { ...s.tended, baseMoved: new Date(c.now()).toISOString() };
    c.setSource(jobId, { ...(store.jobs.get(jobId)?.sourceState?.source ?? {}), tended });
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
    const repo = jobPullRequestRepo(job);
    if (!source.conflictBetween || !s?.pullRequest || !s.seen?.base || !repo) return undefined;
    try {
      return await source.conflictBetween(repo, s.seen.base, s.pullRequest, other);
    } catch (e) {
      console.warn(`hopper: ${source.name}: whether ${s.pullRequest} and ${other} conflict failed, asked again next sync: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * The first of `heads` a due rebase conflicts with (issue #939); where the source cannot say, it conflicts. A `fix_checks`
   * is held by none (issue #938): rework goes back at once.
   */
  async function heldBy(source: JobSource, d: TendDue, heads: readonly QueueHead[]): Promise<QueueHead | undefined> {
    if (d.step !== 'rebase') return undefined;
    // Held an hour (issue #1143): new heads keep coming, so it is tended now, and the log says so (issue #1162).
    const job = store.jobs.get(d.jobId)!, held = job.sourceState?.source as Holds | undefined;
    if (heldTooLong(held?.heldSince, c.now())) return void console.warn(`hopper: ${source.name}: ${d.pullRequest} was held behind ${held?.heldBehind?.pullRequest} since ${held?.heldSince}: tended now`);
    for (const h of heads) if (await conflict(source, job, h.pullRequest) !== false) return h;
    return undefined;
  }

  /**
   * The tends of each job repository (issue #796), one queue per set of pull requests that conflict (issue #939): of the
   * source's jobs whose followed pull request needs tending, each one no head and no tend started before it conflicts with,
   * Jev's pick first, then the rules' order. Each other rebase is held behind the first that conflicts with it; a
   * `fix_checks` never is (issue #938). Since when it is held is kept; held `MAX_HELD_MS`, it is held no more (issue #1143).
   */
  async function tendNext(source: JobSource, listed: Job[]): Promise<void> {
    const get = (id: string) => store.jobs.get(id);
    // Only a tended job watches its base: the others need no read of their own.
    for (const j of fresh(listed)) if ((j.sourceState?.source as { follow?: string } | undefined)?.follow === 'tended') await watchBase(source, j.id);
    const jobs = fresh(listed);
    // A tend job's closed work item is tended no more (issue #2127): one that found nothing left to merge closed it, and a rebase is never capped.
    const due = jobs.filter((j) => c.finalReported(j) && !heldClosed(store, j)).flatMap((j): TendDue[] => { const d = tendDue(j); return d ? [{ jobId: j.id, pullRequest: d.url, step: d.step }] : []; });
    const merges = (repo: string, kind?: ChangeKind) => source.mergesOnReady?.(repo, kind) ?? false;
    const held = new Map<string, QueueHead>();
    for (const repo of new Set(due.map((d) => repoOf(get(d.jobId)!)))) {
      if (repo === undefined) continue;
      const heads = queueHeads(repo, jobs, get, merges, c.now(), (j) => c.finalReported(j));
      const free: TendDue[] = [];
      for (const d of tendOrder(due.filter((x) => repoOf(get(x.jobId)!) === repo), get)) {
        const h = await heldBy(source, d, heads);
        if (h) held.set(d.jobId, h); else free.push(d);
      }
      if (free.length === 0) continue;
      const first = await pickHead(c.jevFirst, repo, free, get);
      const started: QueueHead[] = [];
      for (const d of [first, ...free.filter((x) => x !== first)]) {
        const h = await heldBy(source, d, started);
        if (h) { held.set(d.jobId, h); continue; }
        keepHold(d.jobId, 'heldBehind', undefined);
        // A base merge pushed: it holds the ones that conflict with it only on its way to the hopper's merge (issue #967).
        if (await mergedBase(source, d)) {
          if (merges(repo, changeOf(get(d.jobId))?.kind)) started.push({ pullRequest: d.pullRequest, why: 'merging' });
          continue;
        }
        const r = await tendIfDue(source, d.jobId).catch((e: unknown) => { c.failed(d.jobId, e); });
        started.push({ pullRequest: d.pullRequest, why: 'tending', ...(r?.ok ? { jobId: r.job.id } : {}) });
      }
    }
    // Only tendNext keeps a hold: a job held now, or held when `jobs` was read, is the only one with a hold to keep or drop.
    const hadHold = (j: Job) => { const s = j.sourceState?.source as Holds | undefined; return s?.heldBehind !== undefined || s?.heldSince !== undefined; };
    for (const j of jobs) {
      const h = held.get(j.id);
      if (!h && !hadHold(j)) continue;
      keepHold(j.id, 'heldBehind', h);
      const since = (store.jobs.get(j.id)?.sourceState?.source as Holds | undefined)?.heldSince;
      keepHold(j.id, 'heldSince', h ? since ?? new Date(c.now()).toISOString() : undefined);
    }
  }

  /** May follow its item's open pull request (issues #763, #786): no failed tend, and the newest job of its item. */
  const adoptable = (j: Job, newest?: ReadonlyMap<string, string>) => reconcilable(j) && newestOfItem(j, newest) && !failedTend(j, (id) => store.jobs.get(id));

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
    const newest = newestOfItems(store.jobs.list());
    const candidates = jobs.filter((j) => adoptable(j, newest) && c.finalReported(j));
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
    act: prActs.act,
    /** What sends a Merge now or Close PR row of a source's outbox (issue #1238 part 3). */
    outboxActs: prActs.acts,
    tendAgain: again.tendAgain,
    checkTendAgain: again.checkTendAgain,
    /** One sync of the source: the jobs of its round to follow, or to judge again; then the tends. `asked`: a census now. */
    async catchUp(source: JobSource, listed: Job[], round: FollowRound = 'all', asked = false): Promise<void> {
      const all = round === 'all';
      if (all) await reconcile(source, listed).then(() => strays(source, listed)).then(() => census(source, listed, asked));
      const stored = store.jobs.list(), jobs = fresh(listed, stored), newest = newestOfItems(stored);
      const run = (j: Job, fn: (s: JobSource, id: string) => Promise<void>) =>
        c.enqueue(j.id, () => fn(source, j.id).catch((e: unknown) => { c.failed(j.id, e); }));
      const merges = (repo: string, kind?: ChangeKind) => source.mergesOnReady?.(repo, kind) ?? false;
      const inRound = (j: Job) => all ? following(j) || (rechecksMerge(j) && newestOfItem(j, newest)) : round === 'in_motion' && inMotion(j, merges, c.now());
      const due = jobs.filter((j) => c.finalReported(j) && followsWhenEnded(j) && inRound(j));
      let read = due.length > 0 && source.follow !== undefined;
      if (read) {
        try {
          await source.readFollowed?.(due.filter(following));
        } catch (e) {
          read = false;
          console.warn(`hopper: ${source.name}: reading the followed pull requests failed, followed at the next round: ${(e as Error).message}`);
        }
      }
      const followOf = async (id: string): Promise<void> => {
        if (!read || !due.some((d) => d.id === id)) return;
        const j = store.jobs.get(id);
        if (j && followsWhenEnded(j) && (following(j) || rechecks(j))) await run(j, (s, x) => follow(s, x, all));
      };
      // A failed job that waits on a person is judged again first (issue #786: it may follow its pull request too); only in
      // a round of every one.
      await Promise.all(jobs.filter((j) => c.finalReported(j)).map((j) =>
        (all && waitsOnPerson(j) ? run(j, judgeAgain).then(() => followOf(j.id)) : followOf(j.id))));
      // The tends run after every follow, off the report chain (Run again takes that chain itself): one per repository.
      await tendNext(source, listed);
    },
  };
}
