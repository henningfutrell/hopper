// Direct jobs (issue #901, design.md "Direct jobs"): a person submits a job straight to the hopper, with no GitHub issue.
// The submission is kept (`direct_jobs`), recorded with who submitted it and what they authorized (`direct_job.submitted`),
// and taken by the `direct` job source in the same transaction: its job runs through the same queue gate, routing rules,
// blast radius, vault and infra plan rules as any job. The source tells GitHub nothing: its reports are kept on the job
// only. Run again takes the same submission again. Reads answer the submission with its newest job, its result and its
// open questions, its job's artifacts (its outputs, private in the hopper) and its live promotion to GitHub (issue #946).
// A submission that authorizes `vault` grants its item the vault in that transaction too, by the submitter:
// the caller has had Access decide it first, as for a person's Grant (design.md "Direct jobs", part 3).
// Its pull request (issue #1068): a direct job that ended done and opened a pull request on its repository through the
// hopper's GitHub proxy follows it, as a job of an issue does — shown in Pull requests, tended through Run again with the
// tend brief, merged by yolo mode — with the user's own GitHub connection (`pullRequests`). A tend job follows the pull
// request it was handed. A direct job has no issue, so the merge closes nothing.
import { createHash } from 'node:crypto';
import { authorizesVault, DIRECT_QUERY_LABEL, DIRECT_SOURCE, directJobView, directKey, directQueryState, isDirectQuery, openedPullRequest, type DirectJob, type DirectJobInput, type DirectJobView, type DirectPullRequests, type DirectQueryInput, type DirectQueryView } from '../domain/direct-jobs.ts';
import type { ActingPerson } from '../domain/failures.ts';
import { staleArtifacts } from '../domain/promotions.ts';
import { tendOf } from '../domain/pull-requests.ts';
import type { JobSource, SourceHost, SourceReport } from '../domain/ports.ts';
import type { UserStore } from '../domain/store.ts';
import type { Job, Question } from '../domain/types.ts';
import { directItem } from './item.ts';

export { directItem, directPrompt, PRIVATE_LINE, QUERY_LINE } from './item.ts';

export interface DirectJobs {
  /** The `direct` job source: the sync loop reports its jobs' ends to it, and Run again asks it. */
  readonly source: JobSource;
  /**
   * Keep the submission and make its job, in one transaction; with `vault` among its authorizations, grant its item the
   * vault, by `by`, in the same one. `id`: the id to keep it under (the one Access decided the grant for); absent: a new
   * id. `job` is absent only when its key already had one.
   */
  submit(input: DirectJobInput, by: ActingPerson, id?: string): { directJob: DirectJobView; job?: Job };
  list(): DirectJobView[];
  get(id: string): DirectJobView | undefined;
  /**
   * Issue #2184: keep a direct query and make its job, as `submit` does; its id comes from its request id, so the same
   * request id again answers the query kept (`replayed`) and makes nothing. `conflict`: that request id was asked with
   * another question or callback.
   */
  ask(input: DirectQueryInput, by: ActingPerson): { directQuery: DirectQueryView; job?: Job; replayed?: true } | { conflict: string };
  queries(): DirectQueryView[];
  /** A direct query by its request id. */
  query(requestId: string): DirectQueryView | undefined;
  /**
   * Issue #2184: inside the tx that moves a question to the human stage. A direct query's question goes to its caller
   * too: `direct_query.question_asked`, delivered to its callback. A question of any other job: nothing.
   */
  questionAsked(q: Question, answerUrl: string): void;
}

/** A direct query's id: its request id's hash, so the same request id names the same query (issue #2184). */
export const directQueryId = (requestId: string): string => `query-${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`;

/** The direct query's title: the question's first line, short. */
const titleOf = (question: string): string => {
  const line = question.split('\n')[0]!.trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

const SOURCE_REF = { name: DIRECT_SOURCE, kind: DIRECT_SOURCE };

export function createDirectJobs(o: {
  store: UserStore; host: () => SourceHost; url: (id: string) => string; artifactUrl: (id: string) => string; now: () => string;
  /** How a direct job's pull request is followed (issue #1068); absent: none is. */
  pullRequests?: DirectPullRequests;
}): DirectJobs {
  const { store } = o;
  const view = (d: DirectJob): DirectJobView => {
    const job = store.jobs.getBySourceKey(directKey(d.id));
    const questions = job ? store.questions.list({ jobId: job.id, status: ['open'], order: 'oldest-first' }).map((q) => ({ id: q.id, text: q.text, tier: q.tier, askedAt: q.createdAt })) : [];
    const artifacts = (job ? store.artifacts.list({ jobId: job.id }) : []).map((a) => ({
      id: a.id, title: a.title, revision: a.revision, kind: a.kind, url: o.artifactUrl(a.id), ...(a.summary ? { summary: a.summary } : {}),
    }));
    const live = store.promotions.live(d.id);
    const now = live ? live.artifacts.map((a) => ({ id: a.id, revision: store.artifacts.get(a.id)?.revision ?? a.revision })) : [];
    return directJobView(d, job, questions, { artifacts, ...(live ? { promotion: { ...live, stale: staleArtifacts(live, now) } } : {}) });
  };
  const queryView = (v: DirectJobView): DirectQueryView | undefined => (v.query ? { ...v, query: v.query, state: directQueryState(v.job) } : undefined);
  // Issue #2184: a direct query's end, once per job and end, recorded for its caller: the event's `callback` names the
  // webhook subscription its delivery goes to, so the delivery is the callback, kept and retried as every delivery is.
  const queryEnded = (r: SourceReport): void => {
    if (!isDirectQuery(r.job)) return;
    const id = idOf(r.job);
    const d = id === undefined ? undefined : store.directJobs.get(id);
    if (!d?.query || r.job.sourceState?.source?.reported === r.kind) return;
    const base = { id: d.id, requestId: d.query.requestId, jobId: r.job.id, url: o.url(d.id), ...(d.query.callback ? { callback: d.query.callback } : {}) };
    if (r.kind === 'finished') {
      const artifacts = store.artifacts.list({ jobId: r.job.id }).map((a) => ({ id: a.id, title: a.title, url: o.artifactUrl(a.id) }));
      store.events.append({ type: 'direct_query.answered', jobId: r.job.id, data: { ...base, answer: r.job.result ?? null, artifacts } });
    } else if (r.kind === 'failed' || r.kind === 'rejected') {
      store.events.append({ type: 'direct_query.failed', jobId: r.job.id, data: { ...base, error: r.job.error ?? r.kind } });
    } else if (r.kind === 'cancelled') {
      store.events.append({ type: 'direct_query.cancelled', jobId: r.job.id, data: base });
    }
  };
  const idOf = (job: Job): string | undefined => {
    const key = job.source?.key ?? '';
    return key.startsWith(`${DIRECT_SOURCE}:`) ? key.slice(DIRECT_SOURCE.length + 1) : undefined;
  };

  // The pull request the job opened on its repository, else the one a tend handed it (issue #1068).
  const ownPullRequest = (job: Job): string | undefined => {
    const repo = job.source?.repo;
    if (!repo) return undefined;
    return openedPullRequest(store.events.recent(1000, ['github_proxy.done'], job.id), repo) ?? tendOf(job, (id) => store.jobs.get(id))?.pullRequest;
  };

  const source: JobSource = {
    name: DIRECT_SOURCE,
    kind: DIRECT_SOURCE,
    describe: () => ({ private: true }),
    // Its items come through `submit`, never a poll.
    discover: async () => [],
    check: async () => [],
    // Nothing goes out: the job keeps what was reported, and its result stays in the hopper. A done job's own pull request
    // is kept to follow (issue #1068).
    report: async (r) => {
      queryEnded(r);
      const state = { ...(r.job.sourceState?.source ?? {}), reported: r.kind };
      const pullRequest = r.kind === 'finished' && o.pullRequests ? ownPullRequest(r.job) : undefined;
      return pullRequest ? { ...state, pullRequest, follow: 'open' } : state;
    },
    async rerun(job) {
      const id = idOf(job);
      const d = id === undefined ? undefined : store.directJobs.get(id);
      if (!d) throw new Error(`job ${job.id} is of no direct job this hopper keeps`);
      return directItem(d, o.url(d.id));
    },
    ...o.pullRequests,
  };

  const submit = (input: DirectJobInput, by: ActingPerson, id?: string): { directJob: DirectJobView; job?: Job } => store.tx(() => {
    const d = store.directJobs.add({ ...input, submittedBy: by, submittedAt: o.now() }, id);
    // Who submitted it and what they authorized, never its title or brief: those stay on the record.
    store.events.append({
      type: 'direct_job.submitted',
      data: { id: d.id, by: by.person, via: by.via, labels: d.labels, authorizations: d.authorizations, ...(d.repo ? { repo: d.repo } : {}) },
    });
    const job = o.host().ingest(directItem(d, o.url(d.id)), SOURCE_REF) ?? undefined;
    // The submitter's vault grant, as Grant on Vault keeps it: for the item, so Run again keeps it.
    const key = directKey(d.id);
    if (job && authorizesVault(d) && !store.vaultGrants.get(key)) {
      store.vaultGrants.put({ key, job: job.id, by: by.person, at: o.now() });
      store.events.append({ type: 'vault.granted', jobId: job.id, data: { job: job.id, key, by: by.person } });
    }
    return { directJob: view(d), ...(job ? { job } : {}) };
  });

  return {
    source,
    submit,
    ask(input, by) {
      const id = directQueryId(input.requestId);
      const kept = store.directJobs.get(id);
      if (kept) {
        if (kept.brief !== input.question || kept.query?.callback !== input.callback) return { conflict: `request ${input.requestId} was asked already, with another question or callback` };
        return { directQuery: queryView(view(kept))!, replayed: true };
      }
      const query = { requestId: input.requestId, ...(input.callback ? { callback: input.callback } : {}), ...(input.repos?.length ? { repos: input.repos } : {}), ...(input.clusters?.length ? { clusters: input.clusters } : {}) };
      return store.tx(() => {
        // A direct query authorizes nothing: no vault grant, no repository to open a pull request on.
        const made = submit({
          title: titleOf(input.question), brief: input.question, labels: [DIRECT_QUERY_LABEL, ...(input.labels ?? []).filter((l) => l !== DIRECT_QUERY_LABEL)], authorizations: [],
          ...(input.executor ? { executor: input.executor } : {}), ...(input.priority !== undefined ? { priority: input.priority } : {}), query,
        }, by, id);
        store.events.append({ type: 'direct_query.accepted', ...(made.job ? { jobId: made.job.id } : {}), data: { id, requestId: input.requestId, by: by.person, via: by.via, ...(input.callback ? { callback: input.callback } : {}) } });
        return { directQuery: queryView(view(store.directJobs.get(id)!))!, ...(made.job ? { job: made.job } : {}) };
      });
    },
    questionAsked(q, answerUrl) {
      const job = store.jobs.get(q.jobId);
      const id = job && isDirectQuery(job) ? idOf(job) : undefined;
      const d = id === undefined ? undefined : store.directJobs.get(id);
      if (!job || !d?.query) return;
      store.events.append({
        type: 'direct_query.question_asked', jobId: job.id, questionId: q.id,
        data: { id: d.id, requestId: d.query.requestId, jobId: job.id, questionId: q.id, question: q.text, answerUrl, url: o.url(d.id), ...(d.query.callback ? { callback: d.query.callback } : {}) },
      });
    },
    queries: () => store.directJobs.list().map(view).flatMap((v) => queryView(v) ?? []),
    query(requestId) {
      const d = store.directJobs.get(directQueryId(requestId));
      return d ? queryView(view(d)) : undefined;
    },
    list: () => store.directJobs.list().map(view),
    get(id) {
      const d = store.directJobs.get(id);
      return d ? view(d) : undefined;
    },
  };
}
