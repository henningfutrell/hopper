// The jobs that hold a machine (issue #2932): a removal or rename of it waits for them. Each links to its job; a job on its own
// wait has Release the wait (POST /ui/api/jobs/:id/release-wait): its agent ends and its checkpoint is kept, so it resumes on
// another machine when it wakes.
import { useState } from 'react';
import { Confirm } from '@/components/confirm';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { goalOf, jobHref } from '@/model/job';
import { holdsIntro, holdText } from '@/model/machine-holds';
import type { MachineView } from '@/model/wire';
import { act, useHopper } from '@/store';

export function MachineHolds({ m, canAct }: { m: MachineView; canAct: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const jobs = useHopper((s) => s.jobs);
  const holds = m.holding ?? [];
  if (holds.length === 0) return null;
  const release = async (jobId: string) => {
    setBusy(jobId);
    try {
      await act(`/ui/api/jobs/${encodeURIComponent(jobId)}/release-wait`, {}, 'Released: it resumes on another machine');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Jobs that hold this machine" data-slot="machine-holds" className="grid gap-1.5 text-sm">
      <p className="font-medium">Jobs that hold this machine</p>
      <p className="text-xs text-muted-foreground">{holdsIntro(holds.length)}</p>
      <ul className="grid gap-1.5">
        {holds.map((h) => {
          const job = jobs[h.jobId];
          return (
            <li key={h.jobId} data-job={h.jobId} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs">
              <a href={jobHref(h.jobId)} className="font-mono underline">{h.jobId.slice(0, 8)}</a>
              {job && <span className="min-w-0 truncate">{goalOf(job)}</span>}
              <StatusBadge status={h.status} />
              <span className="text-muted-foreground">{holdText(h.status)}</span>
              {canAct && h.release && (
                <Confirm title="Release this job's wait?" action="Release the wait"
                  description={<>Its agent ends and its checkpoint is kept. It stays on its wait, and resumes its session on another machine when it wakes.</>}
                  onConfirm={() => void release(h.jobId)}>
                  <Button size="sm" variant="outline" disabled={busy !== null} aria-label={`Release the wait of ${h.jobId}`}>Release the wait</Button>
                </Confirm>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
