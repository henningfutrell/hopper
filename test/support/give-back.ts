// The acts that give an item back, through the UI session (issue #1194): each route answers 202 before its source gives
// the item back. Each helper answers as the route did before: what the act made once it is made (200), why the
// give-back failed (409, `error`), or the route's own refusal as it came.
import type { DomainEvent, FailuresView, HandoffView, Job } from '../../src/domain/types.ts';
import type { TestApp } from './app.ts';
import { waitFor } from './wait.ts';

type Settled<T> = { status: number; body: T & { error?: string } };

/** The act sent; then `made`, given the ended job, until it answers, or the give-back failed. */
async function settled<T>(app: TestApp, path: string, body: unknown, token: string, made: (jobId: string) => Promise<T | undefined>): Promise<Settled<T>> {
  const seen = (await app.events('types=job.give_back_failed')).length;
  const r = await app.ui<{ jobId: string; error?: string }>(path, body, { token });
  if (r.status !== 202) return r as unknown as Settled<T>;
  const jobId = r.body.jobId;
  return waitFor(async (): Promise<Settled<T> | undefined> => {
    const failed = (await app.events('types=job.give_back_failed')).slice(seen).find((e) => e.jobId === jobId);
    if (failed) return { status: 409, body: { error: String(failed.data.error) } as Settled<T>['body'] };
    const m = await made(jobId);
    return m === undefined ? undefined : { status: 200, body: m as Settled<T>['body'] };
  }, { what: `the give-back of job ${jobId} (${path})`, timeoutMs: 10_000 });
}

const jobsOf = async (app: TestApp, token: string) => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000', undefined, { 'x-hopper-session': token })).body.jobs;
/** The events of `type` for the job after the `seen` first ones. */
const eventsAfter = async (app: TestApp, type: string, seen: number, jobId: string): Promise<DomainEvent[]> =>
  (await app.events(`types=${type}`)).slice(seen).filter((e) => e.jobId === jobId);

export async function runAgain(app: TestApp, jobId: string, token: string, act: 'rerun' | 'rework' = 'rerun', body: unknown = {}): Promise<Settled<Job>> {
  const before = new Set((await jobsOf(app, token)).map((j) => j.id));
  return settled(app, `/ui/api/jobs/${jobId}/${act}`, body, token, async (id) => (await jobsOf(app, token)).find((j) => j.rerunOf === id && !before.has(j.id)));
}

/** Failures' Retry: the new job, once its record says it was run again. */
export async function retry(app: TestApp, recordId: string, token: string): Promise<Settled<Job>> {
  return settled(app, `/ui/api/failures/${recordId}/retry`, {}, token, async () => {
    const v = (await app.api<FailuresView>('GET', '/api/failures')).body;
    const r = [...v.recent, ...v.ended].find((x) => x.id === recordId);
    return r?.outcome === 'retried' && r.nextJobId ? app.job(r.nextJobId) : undefined;
  });
}

/** A hand-off's resolution: the hand-off and, for Continue and I fixed it, the job that follows, once it is closed. */
export async function resolveHandoff(app: TestApp, handoffId: string, body: Record<string, unknown>, token: string): Promise<Settled<{ handoff: HandoffView; job?: Job }>> {
  return settled(app, `/ui/api/failures/handoffs/${handoffId}/resolve`, body, token, async () => {
    const handoff = (await app.api<FailuresView>('GET', '/api/failures')).body.handoffs.find((h) => h.id === handoffId);
    if (handoff?.status !== 'closed') return undefined;
    return { handoff, ...(handoff.nextJobId ? { job: await app.job(handoff.nextJobId) } : {}) };
  });
}

/** Push it: the job, once it goes on. */
export async function pushIt(app: TestApp, jobId: string, body: Record<string, unknown>, token: string): Promise<Settled<{ job: Job }>> {
  const seen = (await app.events('types=job.continued')).length;
  return settled(app, `/ui/api/failures/kept-work/${jobId}/push`, body, token, async (id) =>
    ((await eventsAfter(app, 'job.continued', seen, id)).length > 0 ? { job: await app.job(id) } : undefined));
}

/** Tend again: the new tend job. */
export async function tendAgain(app: TestApp, jobId: string, token: string): Promise<Settled<{ job: Job }>> {
  const seen = (await app.events('types=job.pull_request_tended')).length;
  return settled(app, '/ui/api/pull-requests/tend', { jobId }, token, async (id) => {
    const tended = (await eventsAfter(app, 'job.pull_request_tended', seen, id))[0];
    return tended ? { job: await app.job(String(tended.data.nextJobId)) } : undefined;
  });
}
