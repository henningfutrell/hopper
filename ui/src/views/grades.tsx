// The Grades tab of Jobs (issue #2845): GET /api/grades, the user's graded jobs rolled up by the group picked — executor,
// model, repository, work kind or machine —, the best mean automatic grade first, with the sum of all above them; then the
// graded jobs, newest first, each with its two grades and linked to its job view. Read again when the group changes.
import { Award } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { TEXT } from '@/components/status';
import { Button } from '@/components/ui/button';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';
import { GROUP_NAMES, GROUPS, scoreTone } from '@/model/grades';
import { jobHref } from '@/model/job';
import type { GradeGroup, GradesView } from '@/model/wire';

const jobs = (n: number): string => `${n} ${n === 1 ? 'job' : 'jobs'}`;

function totalText(t: GradesView['total']): string {
  const user = t.userGraded > 0 && t.user !== undefined ? ` (mean ${t.user} of 5)` : '';
  return `${t.jobs} graded ${t.jobs === 1 ? 'job' : 'jobs'}, mean automatic grade ${t.auto}, ${t.userGraded} graded by a person${user}, ${t.disagreements} disagree`;
}

const Score = ({ n }: { n: number }) => <span className={cn('tabular-nums', TEXT[scoreTone(n)])}>{n}</span>;

export function Grades() {
  const [by, setBy] = useState<GradeGroup>('executor');
  const [view, setView] = useState<GradesView | null>(null);
  useEffect(() => {
    let gone = false;
    get<GradesView>(`/api/grades?by=${by}`).then((v) => { if (!gone) setView(Array.isArray(v?.groups) ? v : null); }, () => { if (!gone) setView(null); });
    return () => { gone = true; };
  }, [by]);
  const toolbar = (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Group by">
      {GROUPS.map((g) => <Button key={g} size="sm" variant={g === by ? 'default' : 'outline'} aria-pressed={g === by} onClick={() => setBy(g)}>{GROUP_NAMES[g]}</Button>)}
    </div>
  );
  return (
    <div className="space-y-3">
      <Panel title="Grades" icon={Award} toolbar={toolbar} bodyClassName="space-y-2 p-3 text-sm">
        <p className="text-xs text-muted-foreground">
          The hopper grades each job that ended done or failed from its outcome, checks, pull request, rework, cost and time.
          A person can grade a job too, on its page.
        </p>
        {!view ? <p className="text-muted-foreground">Loading…</p> : view.groups.length === 0 ? <Empty>no graded job yet</Empty> : (
          <>
            <p data-slot="grades-total" className="font-medium">{totalText(view.total)}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr><th className="py-1 pr-3">{GROUP_NAMES[by]}</th><th className="pr-3">Jobs</th><th className="pr-3">Automatic</th><th className="pr-3">Graded by a person</th><th className="pr-3">User grade</th><th>Disagree</th></tr>
                </thead>
                <tbody>
                  {view.groups.map((g) => (
                    <tr key={g.key} data-slot="grades-group" className="border-t">
                      <td className="py-1 pr-3 font-mono break-all">{g.key}</td><td className="pr-3">{jobs(g.jobs)}</td><td className="pr-3"><Score n={g.auto} /></td>
                      <td className="pr-3">{g.userGraded}</td><td className="pr-3">{g.user === undefined ? '—' : `${g.user} of 5`}</td><td>{g.disagreements}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
      {view && view.jobs.length > 0 && (
        <Panel title="Graded jobs" icon={Award} count={view.jobs.length} bodyClassName="p-3">
          <ul className="divide-y text-xs">
            {view.jobs.map((j) => (
              <li key={j.jobId} data-slot="grades-job" className="flex flex-wrap items-baseline gap-x-3 py-1">
                <a className="font-mono underline-offset-2 hover:underline" href={jobHref(j.jobId)}>{j.jobId}</a>
                <Score n={j.auto} />
                {j.user !== undefined && <span>{j.user} of 5{j.disagree ? <span className="text-warn"> · disagree</span> : null}</span>}
                <span className="text-muted-foreground">{[j.executor, j.model, j.repo, j.kind, j.machine].filter(Boolean).join(' · ')}</span>
                <span className="text-muted-foreground">{j.endedAt.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
