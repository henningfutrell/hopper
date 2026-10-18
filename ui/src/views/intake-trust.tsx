// The Intake view of the stamp (issue #655): the waiting jobs a trust stamp holds — none, one that does not verify, a
// quarantine, a level below the dispatch minimum or the intake strictness, Jev's trust check due — each with the daemon's
// hold text, its trust, origin acts and links (JobTrust), and the act that lets it go on: Approve trust, Lift quarantine,
// or the job view (Cancel, Run again). Those that wait on a person come first; the nav badge counts them. Who may start
// jobs with no approval (the trusted actors, the intake strictness) is on Settings → Intake.
import { ShieldAlert } from 'lucide-react';
import { useMemo } from 'react';
import { Panel } from '@/components/panel';
import { goalOf } from '@/model/job';
import { heldByTrust } from '@/model/trust';
import { useHopper } from '@/store';
import { JobTrust } from './job-trust';

export function IntakeTrust() {
  const jobs = useHopper((s) => s.jobs);
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
          </div>
        ))}
      </div>
    </Panel>
  );
}
