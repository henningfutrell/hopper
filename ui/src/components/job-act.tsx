// A person's act on one job — Merge now, Close PR, a give-back — while its GitHub outbox row is not sent (issue #1238):
// on its way, on its way again after a refusal for now, or failed with why. Read from each source's `detail.jobActs`,
// which the stream keeps current. Shown on the job's pull request card and on the job. None once it went through.
import type { JobActMarker, SourceStatus } from '@/model/wire';
import { useHopper } from '@/store';

const NAME: Record<JobActMarker['act'], string> = {
  merge: 'Merge now', close: 'Close PR', rerun: 'Run again', rework: 'Rework', retry: 'Retry', continue: 'Continue', fixed: 'I fixed it', push: 'Push it', tend: 'Tend again',
};

/** The job's act on its way in any source's outbox, when it has one. */
export function jobActOf(sources: readonly SourceStatus[], jobId: string): JobActMarker | undefined {
  for (const s of sources) {
    const acts = s.detail?.jobActs;
    if (acts && typeof acts === 'object' && jobId in acts) return (acts as Record<string, JobActMarker>)[jobId];
  }
  return undefined;
}

/** What the marker says. */
export function jobActText(m: JobActMarker): string {
  if (m.state === 'failed') return `${NAME[m.act]} failed on GitHub: ${m.error}. Press it again to send it again.`;
  return `${NAME[m.act]}: on its way to GitHub${m.attempt ? `, try ${m.attempt}` : ''}${m.error ? ` (${m.error})` : ''}`;
}

export function JobAct({ jobId }: { jobId: string }) {
  const m = useHopper((s) => jobActOf(s.sources, jobId));
  if (!m) return null;
  return <div data-slot="job-act" data-job-act={m.state} className={m.state === 'failed' ? 'text-xs text-bad' : 'text-xs text-muted-foreground'}>{jobActText(m)}</div>;
}
