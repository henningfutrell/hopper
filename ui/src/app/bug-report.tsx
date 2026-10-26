// Report a bug (issue #694): a short form — a title, what happened, what you expected — and the context the hopper fills
// in (the System line only, issue #2478), masked, for the person to
// read and edit before sending. The daemon files it on the hopper's own repository as the person, through their own
// GitHub connection. When open reports look similar it offers them first: add yours to one, or file a new one anyway.
// After filing it shows the link. When GitHub cannot take it now, the hopper keeps it and sends it later: the form says
// so, and where to see it (Your reports, #reports). The user menu opens it (issue #666); the dialog lives outside the menu, so it stays open.
// Every failure, hand-off and question card opens it on its job too (`ReportBugButton`).
import { Bug } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { post } from '@/lib/api';
import { draftProblem, emptyDraft, newResendKey, reportRequest, sentLine, type BugReportAnswer, type BugReportDraft, type SimilarReport } from '@/model/bug-report';
import { useCanOperate } from '@/store/selectors';

type Step = { at: 'form' } | { at: 'similar'; similar: SimilarReport[] } | { at: 'sent'; answer: Extract<BugReportAnswer, { kind: 'filed' | 'commented' }> }
  | { at: 'kept'; problem: string };

const LABEL = 'grid gap-1 text-sm font-medium';

/** The form for one report; `jobId`: the job it is about. */
export function BugReportDialog({ jobId, onClose }: { jobId?: string; onClose: () => void }) {
  const [draft, setDraft] = useState<BugReportDraft>(emptyDraft());
  const [step, setStep] = useState<Step>({ at: 'form' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // One resend key for this form (issue #2813): a second click or a resend is answered the first report.
  const [key] = useState(newResendKey);
  useEffect(() => {
    let live = true;
    post<{ context: string }>('/ui/api/bug-reports/context', {})
      .then((r) => { if (live) setDraft((d) => ({ ...d, context: r.context })); }, (e: unknown) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, []);
  const set = (k: keyof BugReportDraft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const send = async (o: { commentOn?: number; force?: boolean } = {}) => {
    setBusy(true);
    setError(undefined);
    try {
      const answer = await post<BugReportAnswer>('/ui/api/bug-reports', reportRequest(draft, { ...(jobId ? { jobId } : {}), ...o, key }));
      setStep(answer.kind === 'similar' ? { at: 'similar', similar: answer.similar } : answer.kind === 'kept' ? { at: 'kept', problem: answer.problem } : { at: 'sent', answer });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const problem = draftProblem(draft);
  let body: ReactNode;
  let footer: ReactNode;
  if (step.at === 'kept') {
    body = (
      <p data-slot="bug-report-kept" className="text-sm">
        GitHub cannot take the report now: {step.problem}. The hopper keeps your report and sends it later.{' '}
        <a className="underline" href="#reports" onClick={onClose}>See it in Your reports</a>
      </p>
    );
    footer = <Button onClick={onClose}>Done</Button>;
  } else if (step.at === 'sent') {
    body = (
      <p data-slot="bug-report-sent" className="text-sm">
        {sentLine(step.answer)} <a className="underline" href={step.answer.url} target="_blank" rel="noreferrer">Open it on GitHub</a>
      </p>
    );
    footer = <Button onClick={onClose}>Done</Button>;
  } else if (step.at === 'similar') {
    body = (
      <div data-slot="bug-report-similar" className="grid gap-2 text-sm">
        <p>These open reports look similar. Add yours to one of them, or file a new report.</p>
        <ul className="grid gap-2">
          {step.similar.map((s) => (
            <li key={s.number} className="flex min-w-0 items-center justify-between gap-2">
              <a className="min-w-0 truncate underline" href={s.url} target="_blank" rel="noreferrer">#{s.number} {s.title}</a>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void send({ commentOn: s.number })}>Add to #{s.number}</Button>
            </li>
          ))}
        </ul>
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={() => setStep({ at: 'form' })}>Back</Button>
        <Button disabled={busy} onClick={() => void send({ force: true })}>File a new report</Button>
      </>
    );
  } else {
    body = (
      <div className="grid gap-3">
        <label className={LABEL}>Title<Input aria-label="Title" value={draft.title} onChange={set('title')} maxLength={200} /></label>
        <label className={LABEL}>What happened<Textarea aria-label="What happened" value={draft.happened} onChange={set('happened')} /></label>
        <label className={LABEL}>What you expected<Textarea aria-label="What you expected" value={draft.expected} onChange={set('expected')} /></label>
        <label className={LABEL}>
          Context
          <span className="text-xs font-normal text-muted-foreground">The hopper filled this in and masked tokens, keys, host names and IP addresses. Read it, and remove anything you do not want to share.</span>
          <Textarea aria-label="Context" className="font-mono text-xs" value={draft.context} onChange={set('context')} />
        </label>
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={busy || problem !== undefined} title={problem} onClick={() => void send()}>{busy ? 'Sending…' : 'Send report'}</Button>
      </>
    );
  }
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AlertDialogContent data-slot="bug-report" className="max-h-[90dvh] overflow-y-auto data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Report a bug</AlertDialogTitle>
          <AlertDialogDescription>The report goes to the hopper's issues on GitHub, filed with your GitHub account. Anyone can read it there.</AlertDialogDescription>
        </AlertDialogHeader>
        {body}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>{footer}</AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** `open` shows the form, on a job when `jobId` names one; render `dialog` where it outlives the control that opened it. */
export function useBugReport(): { open: (jobId?: string) => void; dialog: ReactNode } {
  const [at, setAt] = useState<{ jobId?: string } | null>(null);
  return {
    open: (jobId) => setAt(jobId ? { jobId } : {}),
    dialog: at && <BugReportDialog {...(at.jobId ? { jobId: at.jobId } : {})} onClose={() => setAt(null)} />,
  };
}

/** Report a bug on one job: the button a failure, hand-off or question card shows, for an operator or admin. */
export function ReportBugButton({ jobId }: { jobId: string }) {
  const canOperate = useCanOperate();
  const report = useBugReport();
  if (!canOperate) return null;
  return (
    <>
      <Button type="button" size="xs" variant="ghost" title="Report a bug in the hopper about this job" onClick={() => report.open(jobId)}><Bug />Report a bug</Button>
      {report.dialog}
    </>
  );
}
