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
import { authorizesVault, DIRECT_SOURCE, directJobView, directKey, openedPullRequest, type DirectJob, type DirectJobInput, type DirectJobView, type DirectPullRequests } from '../domain/direct-jobs.ts';
import type { ActingPerson } from '../domain/failures.ts';
import { staleArtifacts } from '../domain/promotions.ts';
import { tendOf } from '../domain/pull-requests.ts';
import type { JobSource, SourceHost } from '../domain/ports.ts';
import type { UserStore } from '../domain/store.ts';
import type { Job } from '../domain/types.ts';
import { directItem } from './item.ts';

export { directItem, directPrompt, PRIVATE_LINE } from './item.ts';

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
}

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

  return {
    source,
    submit(input, by, id) {
      return store.tx(() => {
        const d = store.directJobs.add({ ...input, submittedBy: by, submittedAt: o.now() }, id);
        // Who submitted it and what they authorized, never its title or brief: those stay on the record.
        store.events.append({
          type: 'direct_job.submitted',
          data: { id: d.id, by: by.person, via: by.via, labels: d.labels, authorizations: d.authorizations, ...(d.repo ? { repo: d.repo } : {}) },
        });
        const job = o.host().ingest(directItem(d, o.url(d.id)), SOURCE_REF) ?? undefined;
        // The submitter's vault grant, as Grant on Settings → Vault keeps it: for the item, so Run again keeps it.
        const key = directKey(d.id);
        if (job && authorizesVault(d) && !store.vaultGrants.get(key)) {
          store.vaultGrants.put({ key, job: job.id, by: by.person, at: o.now() });
          store.events.append({ type: 'vault.granted', jobId: job.id, data: { job: job.id, key, by: by.person } });
        }
        return { directJob: view(d), ...(job ? { job } : {}) };
      });
    },
    list: () => store.directJobs.list().map(view),
    get(id) {
      const d = store.directJobs.get(id);
      return d ? view(d) : undefined;
    },
  };
}
