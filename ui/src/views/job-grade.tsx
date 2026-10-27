// A job's grades on its job view (issue #2845): GET /api/jobs/:id/grade, read again as the job's state changes. The
// automatic grade with its breakdown, one line per signal; the user grade, its history and whether the two disagree; and,
// for an operator, the form that grades the job 1 to 5 with a note (POST /ui/api/jobs/:id/grade). Only a job that ended
// done or failed shows the panel: no other end is graded.
import { Award } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { TEXT } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { cn } from '@/lib/utils';
import { gradeLineText, scoreTone, userGradeText } from '@/model/grades';
import type { Job, JobGradeView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanOperate } from '@/store/selectors';

const MAX_NOTE_CHARS = 1000;
const graded = (status: Job['status']): boolean => status === 'finished' || status === 'failed';

function GradeForm({ jobId, onSaved }: { jobId: string; onSaved: (v: JobGradeView) => void }) {
  const [score, setScore] = useState<number | undefined>(undefined);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (score === undefined) return;
    setBusy(true);
    try {
      const text = note.trim();
      onSaved(await post<JobGradeView>(`/ui/api/jobs/${encodeURIComponent(jobId)}/grade`, { score, ...(text ? { note: text } : {}) }));
      setScore(undefined);
      setNote('');
      toast.success('Grade saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an operator grades a job' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="space-y-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-muted-foreground">Your grade</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <Button key={n} size="sm" variant={score === n ? 'default' : 'outline'} aria-pressed={score === n} disabled={busy} onClick={() => setScore(n)}>{n}</Button>
        ))}
      </div>
      <Textarea data-slot="grade-note" aria-label="Note" placeholder="A note (optional)" maxLength={MAX_NOTE_CHARS} disabled={busy} value={note} onChange={(e) => setNote(e.target.value)} />
      <Button size="sm" disabled={busy || score === undefined} onClick={() => void save()}>Save</Button>
    </div>
  );
}

export function JobGrade({ job }: { job: Job }) {
  const operate = useCanOperate();
  const [view, setView] = useState<JobGradeView | null>(null);
  const shown = graded(job.status);
  useEffect(() => {
    if (!shown) return;
    let gone = false;
    get<JobGradeView>(`/api/jobs/${encodeURIComponent(job.id)}/grade`)
      .then((v) => { if (!gone) setView(Array.isArray(v?.history) ? v : null); }, () => { if (!gone) setView(null); });
    return () => { gone = true; };
  }, [job.id, job.status, shown]);
  if (!shown || !view) return null;
  const { grade, user, history } = view;
  return (
    <Panel title="Grade" icon={Award} bodyClassName="space-y-2 p-3 text-sm">
      {grade ? (
        <div className="space-y-1">
          <div className="flex items-baseline gap-2">
            <span data-slot="grade-score" className={cn('text-2xl font-semibold tabular-nums', TEXT[scoreTone(grade.auto.score)])}>{grade.auto.score}</span>
            <span className="text-xs text-muted-foreground">automatic grade, of 100 · {grade.executor}{grade.model ? ` · ${grade.model}` : ''}</span>
          </div>
          <ul className="list-disc pl-5 text-xs">{grade.auto.lines.map((l) => <li key={l.signal} data-slot="grade-line">{gradeLineText(l)}</li>)}</ul>
        </div>
      ) : <p data-slot="grade-none" className="text-xs text-muted-foreground">Not graded yet: the hopper grades a job a minute after it ends.</p>}
      {user && (
        <div className="space-y-0.5">
          <div className="text-xs font-medium text-muted-foreground">User grade</div>
          <div data-slot="grade-user">{userGradeText(user)}</div>
          {view.disagree && <div data-slot="grade-disagree" className="text-xs text-warn">The user grade and the automatic grade disagree.</div>}
          {history.length > 1 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">{history.slice(1).map((g) => <li key={g.at} data-slot="grade-history">{userGradeText(g)}</li>)}</ul>
          )}
        </div>
      )}
      {operate && <GradeForm jobId={job.id} onSaved={setView} />}
    </Panel>
  );
}
