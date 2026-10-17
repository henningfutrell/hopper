// A job's trust on its job view (issue #655): its trust level from its signed stamp, and for an operator, Quarantine — the
// job is held, and its proxy token opens no door of the hopper (POST /ui/api/jobs/:id/quarantine) — or Lift quarantine,
// which gives back the level it had (POST /ui/api/jobs/:id/unquarantine).
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { Confirm } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { isQuarantined, quarantineOffered, trustText } from '@/model/trust';
import type { Job } from '@/model/wire';
import { act } from '@/store';
import { useCanOperate } from '@/store/selectors';

export function JobTrust({ job }: { job: Job }) {
  const operate = useCanOperate();
  const text = trustText(job);
  if (!text) return null;
  const at = `/ui/api/jobs/${encodeURIComponent(job.id)}`;
  const quarantined = isQuarantined(job);
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">trust</span>
      <span data-slot="job-trust" data-level={job.stamp?.level} className={quarantined ? 'min-w-0 break-words text-bad' : 'min-w-0 break-words'}>{text}</span>
      {operate && quarantineOffered(job) && (quarantined
        ? <Button size="xs" variant="outline" onClick={() => act(`${at}/unquarantine`, {}, 'Quarantine lifted')}><ShieldCheck />Lift quarantine</Button>
        : (
          <Confirm title="Quarantine this job?" action="Quarantine" onConfirm={() => act(`${at}/quarantine`, {}, 'Job quarantined')}
            description="The job is held, and it reaches nothing through the hopper: no GitHub, git, vault, skill or step. A running job keeps its pane; cancel or park it as any job. A person lifts the quarantine.">
            <Button size="xs" variant="outline"><ShieldOff />Quarantine</Button>
          </Confirm>
        ))}
    </div>
  );
}
