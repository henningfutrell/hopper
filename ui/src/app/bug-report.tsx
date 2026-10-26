// Report a bug (issue #694): the public warning first (issue #2818), then a short form — a short title and a short
// description — and the context every report carries, read-only (the OS and the hopper's version, issue #2818). Review
// shows the report as it would be posted, scrubbed and masked; only Send posts it. Off until an admin turns public bug
// reports on: the form says so. The daemon files it on the hopper's own repository as the person, through their own
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
import {
  draftProblem, emptyDraft, MAX_DESCRIPTION, MAX_TITLE, newResendKey, PUBLIC_REPORT_WARNING, removedLine, reportRequest, sentLine,
  type BugReportAnswer, type BugReportContext, type BugReportDraft, type BugReportPreview, type SimilarReport,
} from '@/model/bug-report';
import { useCanOperate } from '@/store/selectors';

type Step = { at: 'form' } | { at: 'review'; preview: BugReportPreview } | { at: 'similar'; similar: SimilarReport[] } | { at: 'sent'; answer: Extract<BugReportAnswer, { kind: 'filed' | 'commented' }> }
  | { at: 'kept'; problem: string };

const LABEL = 'grid gap-1 text-sm font-medium';

/** The form for one report; `jobId`: the job it is about. */
export function BugReportDialog({ jobId, onClose }: { jobId?: string; onClose: () => void }) {
  const [draft, setDraft] = useState<BugReportDraft>(emptyDraft());
  const [context, setContext] = useState<BugReportContext>();
  const [step, setStep] = useState<Step>({ at: 'form' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // One resend key for this form (issue #2813): a second click or a resend is answered the first report.
  const [key] = useState(newResendKey);
  useEffect(() => {
    let live = true;
    post<BugReportContext>('/ui/api/bug-reports/context', {})
      .then((r) => { if (live) setContext(r); }, (e: unknown) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, []);
  const set = (k: keyof BugReportDraft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const review = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setStep({ at: 'review', preview: await post<BugReportPreview>('/ui/api/bug-reports/preview', draft) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
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
  const off = context?.on === false;
  const problem = off ? 'Public bug reports are off' : draftProblem(draft);
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
  } else if (step.at === 'review') {
    const removed = removedLine(step.preview.removed);
    body = (
      <div data-slot="bug-report-review" className="grid gap-2 text-sm">
        <p>This is the report as it will be posted. Read it. Send posts it; Back lets you change it.</p>
        <p className="font-medium break-words">{step.preview.title}</p>
        <pre data-slot="bug-report-review-body" className="max-h-64 overflow-auto rounded-md border p-2 text-xs whitespace-pre-wrap break-words">{step.preview.body}</pre>
        {removed && <p className="text-xs text-muted-foreground">{removed}</p>}
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={() => setStep({ at: 'form' })}>Back</Button>
        <Button disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send report'}</Button>
      </>
    );
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
        {off && <p data-slot="bug-report-off" className="text-sm">Public bug reports are off. An admin turns them on in <a className="underline" href="#reports" onClick={onClose}>Your reports</a>.</p>}
        <label className={LABEL}>Title<Input aria-label="Title" value={draft.title} onChange={set('title')} maxLength={MAX_TITLE} /></label>
        <label className={LABEL}>
          Description
          <span className="text-xs font-normal text-muted-foreground">A short, general description of what the hopper did wrong.</span>
          <Textarea aria-label="Description" value={draft.description} onChange={set('description')} maxLength={MAX_DESCRIPTION} />
        </label>
        <div className={LABEL}>
          System
          <span className="text-xs font-normal text-muted-foreground">The hopper adds this to every report, and nothing else.</span>
          <pre data-slot="bug-report-context" className="rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">{context?.context ?? '…'}</pre>
        </div>
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={busy || problem !== undefined} title={problem} onClick={() => void review()}>{busy ? 'Checking…' : 'Review report'}</Button>
      </>
    );
  }
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AlertDialogContent data-slot="bug-report" className="max-h-[90dvh] overflow-y-auto data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Report a bug</AlertDialogTitle>
          <AlertDialogDescription>The report goes to the hopper's issues on GitHub, filed with your GitHub account.</AlertDialogDescription>
          <p role="alert" data-slot="bug-report-warning" className="rounded-md border border-destructive/50 p-2 text-sm font-medium">{PUBLIC_REPORT_WARNING}</p>
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
