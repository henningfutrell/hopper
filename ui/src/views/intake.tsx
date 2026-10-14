// Intake (issue #897; it was Not taken, issue #798, and the intake list in Sources, issue #440): the one home of what a
// job source's open labelled issues that wait on an intake decision, per source — grouped by why, with a count per group:
// request cards waiting for approval first (Approve), then not assigned to you (Assign to me, and Assign all), on the
// backburner (Take off the backburner), and the other reasons. An issue that passed intake — taken, partly done, its pull
// request waits for review — is job progress, on Jobs (issue #1035): Intake lists none of them, and counts them in one line
// that links to Jobs. A request declined here (issue #1035) is no row either: one line counts them. With nothing waiting, a source says so. The nav badge counts the request cards. An issue approved here stays in its place until the view closes (issue #811).
// Always rendered: with no source that lists issues, it says what will show here. Sources keeps each source's sync and
// links here; who is a trusted actor is configuration, on Settings → Intake.
import { Hand, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IntakeGroups } from '@/components/intake-groups';
import { Empty, Panel } from '@/components/panel';
import { declined, inProgress, intakeOf, waiting } from '@/model/intake';
import type { SourceStatus } from '@/model/wire';
import { actFor, useHopper } from '@/store';
import { intakeRefusal } from '@/store/intake';
import { useCanOperate } from '@/store/selectors';

function SourceIntake({ s }: { s: SourceStatus }) {
  const canOperate = useCanOperate();
  const all = intakeOf(s);
  const items = all.filter(waiting);
  const progress = all.filter(inProgress).length;
  const declinedCount = all.filter(declined).length;
  const assignable = items.filter((x) => x.action === 'assign').map((x) => x.key);
  return (
    <Panel title={s.name} icon={Inbox} bodyClassName="space-y-2 text-xs">
      <div data-intake={s.name} className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span data-intake-summary className="text-muted-foreground">{items.length === 0 ? 'Nothing waiting for intake' : `${items.length} waiting for intake`}</span>
          {progress > 0 && <a data-intake-in-progress href="#jobs" className="underline">{progress} in progress on Jobs</a>}
          {declinedCount > 0 && <span data-intake-declined className="text-muted-foreground" title="An edit to a declined issue's title or body shows it here again">{declinedCount} {declinedCount === 1 ? 'request' : 'requests'} declined</span>}
          {canOperate && assignable.length > 1 && (
            <Button size="xs" variant="outline" title="Assigns every labelled issue not assigned to you to your GitHub account"
              onClick={() => void actFor(`/ui/api/sources/${encodeURIComponent(s.name)}/intake`, { kind: 'assign', keys: assignable }, 'Assigned to you', intakeRefusal(assignable))}>
              <Hand />Assign all {assignable.length} to me
            </Button>
          )}
        </div>
        <IntakeGroups items={all} source={s.name} />
      </div>
    </Panel>
  );
}

export function Intake() {
  const sources = useHopper((s) => s.sources);
  const listing = sources.filter((s) => Array.isArray(s.detail?.intake));
  return (
    <div data-intake-page className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The open labelled issues the job sources list that wait on an intake decision. An issue from someone outside your trusted
        actors waits here as a request until you approve or decline it. An issue the hopper took leaves Intake: its progress is on <a href="#jobs" className="underline">Jobs</a>. <a href="#settings/intake" className="underline">Trusted actors</a> · <a href="/help/needs-you#intake" className="underline">Help</a>
      </p>
      {listing.length === 0
        ? <Panel title="Intake" icon={Inbox}><Empty>No job source lists issues yet. When one syncs, each open labelled issue it did not take shows here, with why.</Empty></Panel>
        : listing.map((s) => <SourceIntake key={s.name} s={s} />)}
    </div>
  );
}
