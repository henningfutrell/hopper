// Intake (issue #897; it was Not taken, issue #798, and the intake list in Sources, issue #440): the one home of what a
// job source's open labelled issues that wait on an intake decision, per source — grouped by why, with a count per group:
// request cards waiting for approval first (Approve), then not assigned to you (Assign to me, and Assign all), on the
// backburner (Take off the backburner), and the other reasons. An issue that passed intake — taken, partly done, its pull
// request waits for review — is job progress, on Jobs (issue #1035): Intake lists none of them, and counts them in one line
// that links to Jobs. A request declined here (issue #1035) is no row either: one line counts those whose GitHub writes wait (issue #1710). With nothing waiting, a source says so. The nav badge counts the request cards. An issue approved here stays in its place until the view closes (issue #811).
// Always rendered: with no source that lists issues, it says what will show here. Sources keeps each source's sync and
// links here; who is a trusted actor is configuration, on Settings → Intake. A source that lists fewer issues than it should
// says why (issue #1125): paused (and still shown), its last sync failed, or a job repository GitHub did not answer for. The
// GitHub connection's source that cannot run is shown with its error (issue #1377), never left out. A source whose waiting
// issues are of more than one repository filters them by repository (issue #1463); Assign all assigns the issues shown.
// Above the sources, the waiting jobs a trust stamp holds (issue #655, IntakeTrust), when there are any.
import { Hand, Inbox } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { IntakeGroups } from '@/components/intake-groups';
import { IntakeTrust } from './intake-trust';
import { Empty, Panel } from '@/components/panel';
import { declined, inIntake, inProgress, intakeOf, intakeTrouble, repoOf, reposOf, waiting } from '@/model/intake';
import type { SourceStatus } from '@/model/wire';
import { cn } from '@/lib/utils';
import { actFor, useHopper } from '@/store';
import { intakeRefusal } from '@/store/intake';
import { useCanOperate } from '@/store/selectors';

function SourceIntake({ s }: { s: SourceStatus }) {
  const canOperate = useCanOperate();
  const all = intakeOf(s);
  const waitingAll = all.filter(waiting);
  const repos = reposOf(waitingAll);
  const [picked, pick] = useState<string>();
  // A repository picked that has no waiting issue now shows all again.
  const repo = repos.length > 1 && repos.some((r) => r.repo === picked) ? picked : undefined;
  const items = repo === undefined ? waitingAll : waitingAll.filter((x) => repoOf(x) === repo);
  const progress = all.filter(inProgress).length;
  const declinedCount = all.filter(declined).length;
  const assignable = items.filter((x) => x.action === 'assign').map((x) => x.key);
  const trouble = intakeTrouble(s);
  return (
    <Panel title={s.name} icon={Inbox} bodyClassName="space-y-2 text-xs">
      <div data-intake={s.name} className="space-y-2">
        {trouble.paused !== undefined && <p data-intake-paused className="text-warn">Not listing issues: {trouble.paused}</p>}
        {trouble.error !== undefined && (Array.isArray(s.detail?.intake)
          ? <p data-intake-error className="text-destructive">The last sync failed: {trouble.error}. Intake shows what the sync before it listed.</p>
          : <p data-intake-error className="text-destructive">Not listing issues: this source cannot run. {trouble.error}</p>)}
        {trouble.repoErrors.map(([repo, error]) => (
          <p key={repo} data-intake-repo-error={repo} className="text-warn">Not listed: {repo}. GitHub said: {error}. Its issues show here once it is listed again.</p>
        ))}
        {repos.length > 1 && (
          <div data-intake-repo-filter role="group" aria-label="Filter by repository" className="flex flex-wrap items-center gap-1">
            {[{ repo: undefined, label: 'All repositories', count: waitingAll.length }, ...repos].map((r) => (
              <Button key={r.repo ?? ''} size="xs" variant={repo === r.repo ? 'secondary' : 'ghost'} aria-pressed={repo === r.repo}
                title={r.repo ?? 'The issues of every repository'} onClick={() => pick(r.repo)}>
                {r.label} <span className={cn('num', repo !== r.repo && 'text-muted-foreground')}>{r.count}</span>
              </Button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span data-intake-summary className="text-muted-foreground">{items.length === 0 ? 'Nothing waiting for intake' : `${items.length} waiting for intake`}</span>
          {progress > 0 && <a data-intake-in-progress href="#jobs" className="underline">{progress} in progress on Jobs</a>}
          {declinedCount > 0 && <span data-intake-declined className="text-muted-foreground" title="The hopper writes each decline to GitHub: the issue loses the hopper label and gets a comment">{declinedCount} {declinedCount === 1 ? 'request' : 'requests'} declined, written to GitHub soon</span>}
          {canOperate && assignable.length > 1 && (
            <Button size="xs" variant="outline" title="Assigns every labelled issue not assigned to you to your GitHub account"
              onClick={() => void actFor(`/ui/api/sources/${encodeURIComponent(s.name)}/intake`, { kind: 'assign', keys: assignable }, 'Assigned to you', intakeRefusal(assignable))}>
              <Hand />Assign all {assignable.length} to me
            </Button>
          )}
        </div>
        <IntakeGroups items={all} source={s.name} repo={repo} />
      </div>
    </Panel>
  );
}

export function Intake() {
  const sources = useHopper((s) => s.sources);
  const listing = sources.filter(inIntake);
  return (
    <div data-intake-page className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The open labelled issues the job sources list that wait on an intake decision. An issue from someone outside your trusted
        actors waits here as a request until you approve or decline it. An issue the hopper took leaves Intake: its progress is on <a href="#jobs" className="underline">Jobs</a>. <a href="#settings/intake" className="underline">Trusted actors</a> · <a href="/help/needs-you#intake" className="underline">Help</a>
      </p>
      <IntakeTrust />
      {listing.length === 0
        ? <Panel title="Intake" icon={Inbox}><Empty>No job source lists issues yet. When one syncs, each open labelled issue it did not take shows here, with why.</Empty></Panel>
        : listing.map((s) => <SourceIntake key={s.name} s={s} />)}
    </div>
  );
}
