// The bug reports the completion reviews recommend (issue #2846 part 2), on Your reports: each that waits for approval, with
// the report it would file and how many jobs found it. Approve files it through Report a bug as a report of the job whose
// review found it, scrubbed as a job's own report; Dismiss asks why, and the same signature is not recommended again.
import { ClipboardCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post } from '@/lib/api';
import { sentLine, type BugReportAnswer } from '@/model/bug-report';
import { recommendationJobs } from '@/model/completion-review';
import type { BugReportRecommendation } from '@/model/wire';
import { RECOMMENDATIONS_PATH, setPolled, useRecommendations } from '@/store/polled';

function Recommendation({ r, canOperate, busy, act }: {
  r: BugReportRecommendation; canOperate: boolean; busy: boolean; act: (r: BugReportRecommendation, how: 'approve' | 'dismiss', reason?: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [dismissing, setDismissing] = useState(false);
  return (
    <li data-slot="recommended-report" className="grid gap-1 border-b py-2 text-sm last:border-b-0">
      <span className="font-medium">{r.title}</span>
      <p className="text-xs text-muted-foreground">
        Found by the completion review of <a className="underline" href={`#jobs/${encodeURIComponent(r.jobId)}`}>its job</a>{recommendationJobs(r)}
      </p>
      <p className="text-xs">{r.description}</p>
      {canOperate && (dismissing
        ? (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); act(r, 'dismiss', reason); }}>
            <Input aria-label="Why dismiss it" placeholder="Why: the same signature is not recommended again" value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button size="sm" type="submit" disabled={busy || reason.trim() === ''}>Dismiss</Button>
            <Button size="sm" variant="outline" type="button" onClick={() => setDismissing(false)}>Back</Button>
          </form>
        )
        : (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => act(r, 'approve')}>Approve</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setDismissing(true)}>Dismiss…</Button>
          </div>
        ))}
    </li>
  );
}

/** Shown only while one waits. `run` says a refusal; `done` reads Your reports again after an Approve. */
export function RecommendedReports({ canOperate, busy, run, done }: {
  canOperate: boolean; busy: boolean; run: (fn: () => Promise<void>, role: string) => Promise<void>; done: () => Promise<unknown>;
}) {
  const view = useRecommendations();
  const open = (Array.isArray(view?.recommendations) ? view.recommendations : []).filter((r) => r.state === 'open');
  if (open.length === 0) return null;
  const act = (r: BugReportRecommendation, how: 'approve' | 'dismiss', reason?: string) => void run(async () => {
    if (how === 'approve') {
      const a = await post<BugReportAnswer>('/ui/api/completion-review/recommendations/approve', { signature: r.signature });
      toast.success(a.kind === 'filed' || a.kind === 'commented' ? sentLine(a) : a.kind === 'kept' ? `Kept to send later: ${a.problem}` : 'Approved');
      await done();
    } else {
      await post('/ui/api/completion-review/recommendations/dismiss', { signature: r.signature, reason });
      toast.success('Recommendation dismissed');
    }
    setPolled(RECOMMENDATIONS_PATH, await get(RECOMMENDATIONS_PATH));
  }, 'an operator or admin');
  return (
    <section data-slot="recommended-reports" className="space-y-1 rounded-md border p-2">
      <h3 className="flex items-center gap-1 text-sm font-medium"><ClipboardCheck className="size-4" />Recommended by completion reviews</h3>
      <p className="text-xs text-muted-foreground">A completion review found that a run hit a hopper defect. Read the report: Approve posts it publicly on GitHub, as you, scrubbed as a job's report; Dismiss keeps why.</p>
      <ul>{open.map((r) => <Recommendation key={r.signature} r={r} canOperate={canOperate} busy={busy} act={act} />)}</ul>
    </section>
  );
}
