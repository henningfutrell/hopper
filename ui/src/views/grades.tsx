// The Grades tab of Jobs (issue #2845): GET /api/grades, the user's graded jobs rolled up by the group picked — executor,
// model, repository, work kind or machine —, the best mean automatic grade first, with the sum of all above them; then the
// graded jobs, newest first, each with its two grades and linked to its job view. Read again when the group changes.
// Part 5: Items in place of Jobs rolls up the graded work items (GET /api/grades/items), each linked to its issue.
import { Award } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { TEXT } from '@/components/status';
import { Button } from '@/components/ui/button';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';
import { GROUP_NAMES, GROUPS, scoreTone } from '@/model/grades';
import { jobHref } from '@/model/job';
import type { GradeGroup, GradesView, ItemGradesView } from '@/model/wire';

type Of = 'jobs' | 'items';
const noun = (n: number, of: Of): string => (of === 'jobs' ? (n === 1 ? 'job' : 'jobs') : (n === 1 ? 'item' : 'items'));
const count = (n: number, of: Of): string => `${n} ${noun(n, of)}`;

function totalText(t: GradesView['total'], of: Of): string {
  const user = t.userGraded > 0 && t.user !== undefined ? ` (mean ${t.user} of 5)` : '';
  return `${t.jobs} graded ${noun(t.jobs, of)}, mean automatic grade ${t.auto}, ${t.userGraded} graded by a person${user}, ${t.disagreements} disagree`;
}

const Score = ({ n }: { n: number }) => <span className={cn('tabular-nums', TEXT[scoreTone(n)])}>{n}</span>;

export function Grades() {
  const [by, setBy] = useState<GradeGroup>('executor');
  const [of, setOf] = useState<Of>('jobs');
  const [read, setRead] = useState<{ of: Of; view: GradesView | ItemGradesView } | null>(null);
  useEffect(() => {
    let gone = false;
    get<GradesView | ItemGradesView>(`${of === 'jobs' ? '/api/grades' : '/api/grades/items'}?by=${by}`)
      .then((v) => { if (!gone) setRead(Array.isArray(v?.groups) ? { of, view: v } : null); }, () => { if (!gone) setRead(null); });
    return () => { gone = true; };
  }, [by, of]);
  // A read of the other list is not shown while this one loads.
  const view = read?.of === of ? read.view : null;
  const toolbar = (
    <div className="flex flex-wrap gap-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Grades of">
        {(['jobs', 'items'] as const).map((o) => <Button key={o} size="sm" variant={o === of ? 'default' : 'outline'} aria-pressed={o === of} onClick={() => setOf(o)}>{o === 'jobs' ? 'Jobs' : 'Items'}</Button>)}
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Group by">
        {GROUPS.map((g) => <Button key={g} size="sm" variant={g === by ? 'default' : 'outline'} aria-pressed={g === by} onClick={() => setBy(g)}>{GROUP_NAMES[g]}</Button>)}
      </div>
    </div>
  );
  const jobList = view && 'jobs' in view ? view.jobs : [];
  const itemList = view && 'items' in view ? view.items : [];
  return (
    <div className="space-y-3">
      <Panel title="Grades" icon={Award} toolbar={toolbar} bodyClassName="space-y-2 p-3 text-sm">
        <p className="text-xs text-muted-foreground">
          The hopper grades each job that ended done or failed from its outcome, checks, pull request, rework, cost and time.
          A person can grade a job too, on its page. An item — the whole work of one issue — is graded over its jobs once it
          ended done or failed.
        </p>
        {!view ? <p className="text-muted-foreground">Loading…</p> : view.groups.length === 0 ? <Empty>{of === 'jobs' ? 'no graded job yet' : 'no graded item yet'}</Empty> : (
          <>
            <p data-slot="grades-total" className="font-medium">{totalText(view.total, of)}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr><th className="py-1 pr-3">{GROUP_NAMES[by]}</th><th className="pr-3">{of === 'jobs' ? 'Jobs' : 'Items'}</th><th className="pr-3">Automatic</th><th className="pr-3">Graded by a person</th><th className="pr-3">User grade</th><th>Disagree</th></tr>
                </thead>
                <tbody>
                  {view.groups.map((g) => (
                    <tr key={g.key} data-slot="grades-group" className="border-t">
                      <td className="py-1 pr-3 font-mono break-all">{g.key}</td><td className="pr-3">{count(g.jobs, of)}</td><td className="pr-3"><Score n={g.auto} /></td>
                      <td className="pr-3">{g.userGraded}</td><td className="pr-3">{g.user === undefined ? '—' : `${g.user} of 5`}</td><td>{g.disagreements}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
      {itemList.length > 0 && (
        <Panel title="Graded items" icon={Award} count={itemList.length} bodyClassName="p-3">
          <ul className="divide-y text-xs">
            {itemList.map((i) => (
              <li key={i.key} data-slot="grades-item" className="flex flex-wrap items-baseline gap-x-3 py-1">
                <a className="font-mono break-all underline-offset-2 hover:underline" href={i.key} target="_blank" rel="noreferrer">{i.key}</a>
                <Score n={i.auto} />
                {i.user !== undefined && <span>{i.user} of 5{i.disagree ? <span className="text-warn"> · disagree</span> : null}</span>}
                <span className="text-muted-foreground">{i.state} · {count(i.jobs, 'jobs')}</span>
                <span className="text-muted-foreground">{[i.executor, i.model, i.repo, i.kind, i.machine].filter(Boolean).join(' · ')}</span>
                <span className="text-muted-foreground">{i.endedAt.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {jobList.length > 0 && (
        <Panel title="Graded jobs" icon={Award} count={jobList.length} bodyClassName="p-3">
          <ul className="divide-y text-xs">
            {jobList.map((j) => (
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
