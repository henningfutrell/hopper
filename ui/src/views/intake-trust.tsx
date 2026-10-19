// The Intake view of the stamp (issue #655): the waiting jobs a trust stamp holds — none, one that does not verify, a
// quarantine, a level below the dispatch minimum or the intake strictness, Jev's trust check due — each with the daemon's
// hold text, its trust, origin acts and links (JobTrust), and the act that lets it go on: Approve trust, Lift quarantine,
// or the job view (Run again), and Cancel in each row (issue #1974). Those that wait on a person come first; the nav badge counts them. Who may start
// jobs with no approval (the trusted actors, the intake strictness) is on Settings → Intake.
import { ShieldAlert, X } from 'lucide-react';
import { useMemo } from 'react';
import { Confirm } from '@/components/confirm';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { goalOf } from '@/model/job';
import { heldByTrust } from '@/model/trust';
import { act, useHopper } from '@/store';
import { useCanOperate } from '@/store/selectors';
import { JobTrust } from './job-trust';

export function IntakeTrust() {
  const jobs = useHopper((s) => s.jobs);
  const operate = useCanOperate();
  const held = useMemo(() => heldByTrust(Object.values(jobs)), [jobs]);
  if (held.length === 0) return null;
  return (
    <Panel title="Held by trust" icon={ShieldAlert} bodyClassName="space-y-3 text-xs">
      <div data-intake-trust className="space-y-3">
        <p className="text-muted-foreground">
          Jobs that do not start because of their trust stamp. Read each job before you let it go on. <a href="#settings/intake" className="underline">Trusted actors and intake strictness</a>
        </p>
        {held.map(({ job, forPerson }) => (
          <div key={job.id} data-trust-held={job.id} className="space-y-1 border-t pt-2 first:border-t-0 first:pt-0">
            <a href={`#job/${encodeURIComponent(job.id)}`} className="font-medium underline">{goalOf(job)}</a>
            <p className={forPerson ? 'break-words text-warn' : 'break-words text-muted-foreground'}>{job.holdReason}</p>
            <JobTrust job={job} />
            {operate && (
              <Confirm title="Cancel this job?" action="Cancel job" onConfirm={() => act(`/ui/api/jobs/${encodeURIComponent(job.id)}/cancel`, {}, 'Job cancelled')}
                description={<>“{goalOf(job)}” ends cancelled, and its source is told.</>}>
                <Button size="xs" variant="outline"><X />Cancel</Button>
              </Confirm>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
