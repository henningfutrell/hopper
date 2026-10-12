// Intake (issue #897; it was Not taken, issue #798, and the intake list in Sources, issue #440): the one home of what a
// job source's intake did with each open labelled issue it listed, per source — grouped by why, with a count per group:
// request cards waiting for approval first (Approve), then not assigned to you (Assign to me, and Assign all), on the
// backburner (Take off the backburner), its pull request waits for review, partly done, the other reasons, and taken last.
// The nav badge counts the request cards. An issue approved here stays in its place until the view closes (issue #811).
// Always rendered: with no source that lists issues, it says what will show here. Sources keeps each source's sync and
// links here; who is a trusted actor is configuration, on Settings → Intake.
import { Hand, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IntakeGroups } from '@/components/intake-groups';
import { Empty, Panel } from '@/components/panel';
import { intakeOf } from '@/model/intake';
import type { SourceStatus } from '@/model/wire';
import { actFor, useHopper } from '@/store';
import { intakeRefusal } from '@/store/intake';
import { useCanOperate } from '@/store/selectors';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function SourceIntake({ s }: { s: SourceStatus }) {
  const canOperate = useCanOperate();
  const items = intakeOf(s);
  const taken = items.filter((x) => x.reason === undefined).length;
  const assignable = items.filter((x) => x.action === 'assign').map((x) => x.key);
  return (
    <Panel title={s.name} icon={Inbox} bodyClassName="space-y-2 text-xs">
      <div data-intake={s.name} className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span data-intake-summary className="text-muted-foreground">{plural(items.length, 'open labelled issue')}: {taken} taken, {items.length - taken} not taken</span>
          {canOperate && assignable.length > 1 && (
            <Button size="xs" variant="outline" title="Assigns every labelled issue not assigned to you to your GitHub account"
              onClick={() => void actFor(`/ui/api/sources/${encodeURIComponent(s.name)}/intake`, { kind: 'assign', keys: assignable }, 'Assigned to you', intakeRefusal(assignable))}>
              <Hand />Assign all {assignable.length} to me
            </Button>
          )}
        </div>
        <IntakeGroups items={items} source={s.name} taken />
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
        Each open labelled issue the job sources list, and what became of it. An issue from someone outside your trusted actors
        waits here as a request until you approve it. <a href="#settings/intake" className="underline">Trusted actors</a> · <a href="/help/needs-you#intake" className="underline">Help</a>
      </p>
      {listing.length === 0
        ? <Panel title="Intake" icon={Inbox}><Empty>No job source lists issues yet. When one syncs, each open labelled issue it lists shows here: taken, or why not.</Empty></Panel>
        : listing.map((s) => <SourceIntake key={s.name} s={s} />)}
    </div>
  );
}
