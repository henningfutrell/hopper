// Direct jobs (issue #901, design.md "Direct jobs"): a person submits a job straight to the hopper, with no GitHub issue.
// The submission is kept (`direct_jobs`), recorded with who submitted it and what they authorized (`direct_job.submitted`),
// and taken by the `direct` job source in the same transaction: its job runs through the same queue gate, routing rules,
// blast radius, vault and infra plan rules as any job. The source tells GitHub nothing: its reports are kept on the job
// only. Run again takes the same submission again. Reads answer the submission with its newest job, its result and its
// open questions, its job's artifacts (its outputs, private in the hopper) and its live promotion to GitHub (issue #946).
import { DIRECT_SOURCE, directJobView, directKey, type DirectJob, type DirectJobInput, type DirectJobView } from '../domain/direct-jobs.ts';
import type { ActingPerson } from '../domain/failures.ts';
import { staleArtifacts } from '../domain/promotions.ts';
import type { JobSource, SourceHost } from '../domain/ports.ts';
import type { UserStore } from '../domain/store.ts';
import type { Job } from '../domain/types.ts';
import { directItem } from './item.ts';

export { directItem, directPrompt, PRIVATE_LINE } from './item.ts';

export interface DirectJobs {
  /** The `direct` job source: the sync loop reports its jobs' ends to it, and Run again asks it. */
  readonly source: JobSource;
  /** Keep the submission and make its job, in one transaction. `job` is absent only when its key already had one. */
  submit(input: DirectJobInput, by: ActingPerson): { directJob: DirectJobView; job?: Job };
  list(): DirectJobView[];
  get(id: string): DirectJobView | undefined;
}

const SOURCE_REF = { name: DIRECT_SOURCE, kind: DIRECT_SOURCE };

export function createDirectJobs(o: { store: UserStore; host: () => SourceHost; url: (id: string) => string; artifactUrl: (id: string) => string; now: () => string }): DirectJobs {
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

  const source: JobSource = {
    name: DIRECT_SOURCE,
    kind: DIRECT_SOURCE,
    describe: () => ({ private: true }),
    // Its items come through `submit`, never a poll.
    discover: async () => [],
    check: async () => [],
    // Nothing goes out: the job keeps what was reported, and its result stays in the hopper.
    report: async (r) => ({ ...(r.job.sourceState?.source ?? {}), reported: r.kind }),
    async rerun(job) {
      const id = idOf(job);
      const d = id === undefined ? undefined : store.directJobs.get(id);
      if (!d) throw new Error(`job ${job.id} is of no direct job this hopper keeps`);
      return directItem(d, o.url(d.id));
    },
  };

  return {
    source,
    submit(input, by) {
      return store.tx(() => {
        const d = store.directJobs.add({ ...input, submittedBy: by, submittedAt: o.now() });
        // Who submitted it and what they authorized, never its title or brief: those stay on the record.
        store.events.append({
          type: 'direct_job.submitted',
          data: { id: d.id, by: by.person, via: by.via, labels: d.labels, authorizations: d.authorizations, ...(d.repo ? { repo: d.repo } : {}) },
        });
        const job = o.host().ingest(directItem(d, o.url(d.id)), SOURCE_REF) ?? undefined;
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
