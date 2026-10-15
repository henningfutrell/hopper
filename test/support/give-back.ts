// Run again and Rework through the UI session (issue #1194): the route answers 202 before its source gives the item back.
// `runAgain` answers as the route did before: the new job once it is made (200), why the give-back failed (`error`), or
// the route's own refusal as it came.
import type { Job } from '../../src/domain/types.ts';
import type { TestApp } from './app.ts';
import { waitFor } from './wait.ts';

type Ran = { status: number; body: Job & { error?: string } };

export async function runAgain(app: TestApp, jobId: string, token: string, act: 'rerun' | 'rework' = 'rerun', body: unknown = {}): Promise<Ran> {
  const jobs = async () => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000', undefined, { 'x-hopper-session': token })).body.jobs;
  const before = new Set((await jobs()).map((j) => j.id));
  const seen = (await app.events('types=job.give_back_failed')).length;
  const r = await app.ui<Job & { error?: string }>(`/ui/api/jobs/${jobId}/${act}`, body, { token });
  if (r.status !== 202) return r;
  return waitFor(async (): Promise<Ran | undefined> => {
    const made = (await jobs()).find((j) => j.rerunOf === jobId && !before.has(j.id));
    if (made) return { status: 200, body: made };
    const failed = (await app.events('types=job.give_back_failed')).slice(seen).find((e) => e.jobId === jobId);
    return failed ? { status: 409, body: { error: String(failed.data.error) } as Ran['body'] } : undefined;
  }, { what: `the ${act} of job ${jobId}`, timeoutMs: 10_000 });
}
