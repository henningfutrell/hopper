// File an issue (issue #471): the person describes a problem or a request, their own signed-in Claude drafts the issue,
// they read and edit it, and only on their confirmation does the hopper file it, with their own GitHub connection, on one
// of their job repositories, with no label and no assignee. Steps: Describe (the repository, their text, a job's context
// attached and editable, and exactly what is sent to Claude on Show what is sent), Drafting (with Cancel, which closes
// the request so the daemon ends the run), Review (the title and the body editable, the body's preview, what was masked,
// Draft again with what to change, Discard), Confirm (where it goes, the title, the body as filed, no labels, no
// assignee, what the scan finds; a public repository ticked first), and Filed (the link). A timeout or Claude's error
// says so plainly and keeps the text. The draft is the file-issue run skill's (issue #472): its notes show, and are never filed;
// the draft constraints it broke show beside it, and the confirm step runs them again on the edited text. The draft lives only in this dialog. The header opens it (`FileIssueButton`; on a
// phone the user menu, `useFileIssue`), and a job's view on that job; the button is off, with the reason, while no provider can draft, and hidden from a viewer.
import { FilePlus } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Markdown } from '@/components/markdown';
import { get, post } from '@/lib/api';
import { newResendKey } from '@/model/bug-report';
import {
  askBody, askProblem, buttonState, confirmProblem, editProblem, findingLine,
  type FiledIssue, type IssueAsk, type IssueCheck, type IssueDraft, type IssueDraftStatus,
} from '@/model/issue-draft';
import { useCanOperate } from '@/store/selectors';

type Step = 'describe' | 'drafting' | 'review' | 'confirm' | 'filed';

const LABEL = 'grid gap-1 text-sm font-medium';
const HINT = 'text-xs font-normal text-muted-foreground';

/** Whether File an issue can run now: read when asked. */
function useIssueDraftStatus(): [IssueDraftStatus | undefined, () => void] {
  const [status, setStatus] = useState<IssueDraftStatus>();
  const read = () => { get<IssueDraftStatus>('/api/issue-drafts').then(setStatus, (e: unknown) => setStatus({ provider: 'claude', available: false, usable: false, reason: (e as Error).message, repos: [] })); };
  useEffect(read, []);
  return [status, read];
}

/** The dialog for one issue; `jobId`: the job attached as its context. */
export function FileIssueDialog({ jobId, status, onClose }: { jobId?: string; status: IssueDraftStatus; onClose: () => void }) {
  const [ask, setAsk] = useState<IssueAsk>({ repo: status.repos[0] ?? '', text: '', context: '' });
  const [prompt, setPrompt] = useState<string>();
  const [step, setStep] = useState<Step>('describe');
  const [draft, setDraft] = useState<IssueDraft>();
  const [edit, setEdit] = useState({ title: '', body: '' });
  const [preview, setPreview] = useState(false);
  const [change, setChange] = useState('');
  const [check, setCheck] = useState<IssueCheck>();
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [allowPersonal, setAllowPersonal] = useState(false);
  const [filed, setFiled] = useState<FiledIssue>();
  // One resend key for this dialog (issue #2813): a second click or a resend is answered the first issue.
  const [key] = useState(newResendKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    post<{ context: string }>('/ui/api/issue-drafts/context', { jobId })
      .then((r) => { if (live) setAsk((a) => ({ ...a, context: r.context })); }, (e: unknown) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [jobId]);
  // Closing the dialog mid-draft cancels the run.
  useEffect(() => () => running.current?.abort(), []);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const showPrompt = () => act(async () => { setPrompt((await post<{ prompt: string }>('/ui/api/issue-drafts/prompt', askBody(ask))).prompt); });
  const runDraft = async (again: boolean) => {
    const controller = new AbortController();
    running.current = controller;
    const back: Step = again ? 'review' : 'describe';
    setError(undefined);
    setStep('drafting');
    try {
      const body = askBody(again ? { ...ask, instructions: change, previous: edit } : ask);
      const d = await post<IssueDraft>('/ui/api/issue-drafts/draft', body, { signal: controller.signal });
      setDraft(d);
      setEdit({ title: d.title, body: d.body });
      setChange('');
      setStep('review');
    } catch (e) {
      // Cancel: back where the person was, with their text. A timeout or Claude's error: said plainly, the text kept.
      setStep(back);
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      running.current = null;
    }
  };
  const cancel = () => running.current?.abort();
  const toConfirm = () => act(async () => {
    const c = await post<IssueCheck>('/ui/api/issue-drafts/check', { repo: ask.repo, ...edit, ...(allowPersonal ? { allowPersonalData: true } : {}) });
    setCheck(c);
    setStep('confirm');
  });
  const recheck = (allow: boolean) => {
    setAllowPersonal(allow);
    void act(async () => { setCheck(await post<IssueCheck>('/ui/api/issue-drafts/check', { repo: ask.repo, ...edit, ...(allow ? { allowPersonalData: true } : {}) })); });
  };
  const file = () => act(async () => {
    const f = await post<FiledIssue>('/ui/api/issue-drafts', {
      repo: ask.repo, ...edit, confirmed: true, key,
      ...(confirmPublic ? { confirmPublic: true } : {}), ...(allowPersonal ? { allowPersonalData: true } : {}), ...(jobId ? { jobId } : {}),
    });
    setFiled(f);
    setStep('filed');
  });
  const set = (k: 'text' | 'context') => (e: { target: { value: string } }) => { setPrompt(undefined); setAsk((a) => ({ ...a, [k]: e.target.value })); };

  let body: ReactNode;
  let footer: ReactNode;
  if (step === 'filed' && filed) {
    body = (
      <p data-slot="file-issue-filed" className="text-sm">
        Filed as {filed.repo}#{filed.number}. <a className="underline" href={filed.url} target="_blank" rel="noreferrer">Open it on GitHub</a>
      </p>
    );
    footer = <Button onClick={onClose}>Done</Button>;
  } else if (step === 'confirm' && check) {
    const problem = confirmProblem(check, { confirmPublic });
    body = (
      <div data-slot="file-issue-confirm" className="grid gap-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Repository</dt><dd className="min-w-0 break-words font-mono">{check.repo} ({check.visibility})</dd>
          <dt className="text-muted-foreground">Labels</dt><dd>{check.labels.length ? check.labels.join(', ') : 'none'}</dd>
          <dt className="text-muted-foreground">Assignee</dt><dd>{check.assignees.length ? check.assignees.join(', ') : 'none: it starts no job'}</dd>
        </dl>
        <p className="font-semibold">{check.title}</p>
        <div className="max-h-64 overflow-y-auto rounded-md border p-2"><Markdown text={check.body} /></div>
        {check.findings.length > 0 && (
          <ul data-slot="file-issue-findings" className="grid gap-1 text-warn">
            {check.findings.map((f) => <li key={f.constraint}>{findingLine(f, 'check')}</li>)}
          </ul>
        )}
        {check.refusal && <p data-slot="file-issue-refusal" role="alert" className="text-destructive">{check.refusal}</p>}
        {check.visibility !== 'public' && check.findings.some((f) => f.constraint === 'no-personal-data') && (
          <label className="flex items-center gap-2"><input type="checkbox" className="size-4" checked={allowPersonal} onChange={(e) => recheck(e.target.checked)} />File the personal data on this private repository</label>
        )}
        {check.visibility === 'public' && (
          <label className="flex items-center gap-2"><input type="checkbox" className="size-4" checked={confirmPublic} onChange={(e) => setConfirmPublic(e.target.checked)} />File on this public repository: anybody can read it</label>
        )}
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={() => setStep('review')}>Back to edit</Button>
        <Button disabled={busy || problem !== undefined} title={problem} onClick={() => void file()}>{busy ? 'Filing…' : 'Confirm and file'}</Button>
      </>
    );
  } else if (step === 'review' && draft) {
    const problem = editProblem(edit);
    body = (
      <div data-slot="file-issue-review" className="grid gap-3">
        <label className={LABEL}>Title<Input aria-label="Title" value={edit.title} maxLength={256} onChange={(e) => setEdit((d) => ({ ...d, title: e.target.value }))} /></label>
        <div className={LABEL}>
          <span className="flex items-center justify-between">Body
            <Button type="button" size="xs" variant="ghost" onClick={() => setPreview((p) => !p)}>{preview ? 'Edit' : 'Preview'}</Button>
          </span>
          {preview
            ? <div data-slot="file-issue-preview" className="max-h-72 overflow-y-auto rounded-md border p-2 font-normal"><Markdown text={edit.body} /></div>
            : <Textarea aria-label="Body" className="min-h-48 font-mono text-xs" value={edit.body} onChange={(e) => setEdit((d) => ({ ...d, body: e.target.value }))} />}
        </div>
        {draft.findings.length > 0 && (
          <ul data-slot="file-issue-findings" className="grid gap-1 text-sm text-warn">
            {draft.findings.map((f) => <li key={f.constraint}>{findingLine(f, 'draft')}</li>)}
          </ul>
        )}
        {draft.notes && <p data-slot="file-issue-notes" className="text-sm text-muted-foreground">Claude's notes (not filed): {draft.notes}</p>}
        <label className={LABEL}>
          Draft again
          <span className={HINT}>Say what to change. Claude gets your edited draft and this.</span>
          <Input aria-label="What to change" value={change} onChange={(e) => setChange(e.target.value)} />
        </label>
        <p className={HINT}>Drafted by {draft.provider}{draft.model ? ` (${draft.model})` : ''}. Nothing is filed until you confirm.</p>
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={onClose}>Discard</Button>
        <Button variant="outline" disabled={busy || change.trim() === ''} onClick={() => void runDraft(true)}>Draft again</Button>
        <Button disabled={busy || problem !== undefined} title={problem} onClick={() => void toConfirm()}>Review and file</Button>
      </>
    );
  } else if (step === 'drafting') {
    body = <p data-slot="file-issue-drafting" role="status" className="text-sm">Claude drafts the issue. This can take a minute…</p>;
    footer = <Button variant="outline" onClick={cancel}>Cancel</Button>;
  } else {
    const problem = askProblem(ask);
    body = (
      <div data-slot="file-issue-describe" className="grid gap-3">
        <label className={LABEL}>
          Repository
          <select aria-label="Repository" className="h-9 rounded-md border bg-background px-2 text-sm font-normal" value={ask.repo}
            onChange={(e) => { setPrompt(undefined); setAsk((a) => ({ ...a, repo: e.target.value })); }}>
            {status.repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className={LABEL}>
          What is the issue?
          <span className={HINT}>Describe the problem or the request in your own words.</span>
          <Textarea aria-label="What is the issue" value={ask.text} onChange={set('text')} />
        </label>
        <label className={LABEL}>
          Context
          <span className={HINT}>{jobId ? 'The hopper filled in this job and masked secrets and personal data. Remove anything you do not want to send.' : 'Optional: anything else Claude should know.'}</span>
          <Textarea aria-label="Context" className="font-mono text-xs" value={ask.context ?? ''} onChange={set('context')} />
        </label>
        <Button type="button" size="xs" variant="ghost" className="justify-self-start" disabled={busy || problem !== undefined} onClick={() => void showPrompt()}>Show what is sent to Claude</Button>
        {prompt && <pre data-slot="file-issue-prompt" className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 text-xs">{prompt}</pre>}
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={busy || problem !== undefined} title={problem} onClick={() => void runDraft(false)}>Draft with Claude</Button>
      </>
    );
  }
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AlertDialogContent data-slot="file-issue" className="max-h-[90dvh] overflow-y-auto data-[size=default]:sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>File an issue</AlertDialogTitle>
          <AlertDialogDescription>Your own Claude drafts it. You read and edit it, and it is filed with your GitHub account only when you confirm.</AlertDialogDescription>
        </AlertDialogHeader>
        {body}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>{footer}</AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** File an issue's state and its dialog: `open` shows it, on a job when `jobId` names one; render `dialog` where it outlives the control that opened it. */
export function useFileIssue(): { state: ReturnType<typeof buttonState>; open: (jobId?: string) => void; dialog: ReactNode } {
  const canOperate = useCanOperate();
  const [status, refresh] = useIssueDraftStatus();
  const [at, setAt] = useState<{ jobId?: string } | null>(null);
  return {
    state: buttonState(canOperate, status),
    open: (jobId) => { refresh(); setAt(jobId ? { jobId } : {}); },
    dialog: at && status?.usable && <FileIssueDialog {...(at.jobId ? { jobId: at.jobId } : {})} status={status} onClose={() => setAt(null)} />,
  };
}

/**
 * The File an issue button: in the header from tablet width up (a phone has it in the user menu, issue #666), or on a job
 * (`jobId`) as its context. Hidden from a viewer; off, with why, while it cannot run.
 */
export function FileIssueButton({ jobId, compact }: { jobId?: string; compact?: boolean }) {
  const { state, open, dialog } = useFileIssue();
  if (!state.show) return null;
  return (
    <>
      <Button type="button" data-slot="file-issue-button" size={compact ? 'icon-sm' : 'xs'} variant="ghost" disabled={state.disabled} title={state.title}
        className={compact ? 'max-sm:hidden' : undefined} aria-label={compact ? `File an issue${state.disabled ? `: ${state.title}` : ''}` : undefined}
        onClick={() => open(jobId)}>
        <FilePlus />{compact ? null : 'File an issue'}
      </Button>
      {dialog}
    </>
  );
}
