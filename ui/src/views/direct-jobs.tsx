// Direct jobs (issue #901, design.md "Direct jobs"), a view of its own (#direct-jobs): a person submits a job straight to
// the hopper — a title, a brief, routing labels, what they authorize, and the one repository its work may open a pull
// request on —, with no GitHub issue behind it. The list reads each direct job back, newest first, with its job's state,
// its open questions (answered in Questions), its result and its error. The brief and the results stay in the hopper.
// The form only for an operator or admin: the daemon refuses the rest. Read when shown, and every 15 s.
import { Send, Zap } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { usePoll } from '@/hooks/use-poll';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { directDraftProblem, directJobRequest, directJobState, emptyDirectDraft, resultText, submittedLine, type DirectJobDraft } from '@/model/direct-jobs';
import type { DirectJobView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanOperate } from '@/store/selectors';

const POLL_MS = 15_000;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}{hint && <span className="text-muted-foreground/70"> · {hint}</span>}</span>
      {children}
    </label>
  );
}

function SubmitForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [draft, setDraft] = useState<DirectJobDraft>(emptyDirectDraft);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof DirectJobDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const problem = directDraftProblem(draft);
  const submit = async () => {
    setBusy(true);
    try {
      await post('/ui/api/direct-jobs', directJobRequest(draft));
      toast.success('Job submitted');
      setDraft(emptyDirectDraft());
      onSubmitted();
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an operator or admin submits a job' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Panel title="Submit a job" icon={Send}>
      <form data-slot="direct-job-form" className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (!problem) void submit(); }}>
        <p className="text-sm text-muted-foreground">
          The job goes straight to the hopper, with no GitHub issue. Its brief and results stay in the hopper. It passes the same gates as any job.
        </p>
        <Field label="Title"><Input aria-label="Title" value={draft.title} onChange={set('title')} maxLength={300} /></Field>
        <Field label="Brief" hint="what to do"><Textarea aria-label="Brief" value={draft.brief} onChange={set('brief')} rows={5} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Labels" hint="for routing, split with commas"><Input aria-label="Labels" value={draft.labels} onChange={set('labels')} placeholder="sme:identity" /></Field>
          <Field label="Repository" hint="optional, owner/name"><Input aria-label="Repository" value={draft.repo} onChange={set('repo')} /></Field>
        </div>
        <Field label="Authorizations" hint="what you authorize it to do or reach, one per line; vault grants it the vault">
          <Textarea aria-label="Authorizations" value={draft.authorizations} onChange={set('authorizations')} rows={2} />
        </Field>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Field label="Priority" hint="0–100, optional"><Input aria-label="Priority" className="w-24" inputMode="numeric" value={draft.priority} onChange={set('priority')} placeholder="50" /></Field>
          <div className="flex items-center gap-3">
            {problem && <span data-slot="direct-job-problem" className="text-xs text-muted-foreground">{problem}</span>}
            <Button type="submit" size="sm" disabled={busy || problem !== undefined}><Send />Submit</Button>
          </div>
        </div>
      </form>
    </Panel>
  );
}

function Row({ d }: { d: DirectJobView }) {
  const state = directJobState(d);
  const result = resultText(d.job?.result);
  return (
    <li data-slot="direct-job-row" className="grid gap-1.5 border-b py-3 text-sm first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium">{d.title}</span>
        <StatusBadge status={state.status} label={state.label} />
      </div>
      <p className="text-xs text-muted-foreground">
        {submittedLine(d)} · {new Date(d.submittedAt).toLocaleString()}{d.repo ? ` · ${d.repo}` : ''}
        {d.job && <> · <a className="underline" href={`#job/${d.job.id}`}>its job</a></>}
      </p>
      {(d.labels.length > 0 || d.authorizations.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {d.labels.map((l) => <Badge key={`l:${l}`} variant="secondary">{l}</Badge>)}
          {d.authorizations.map((a) => <Badge key={`a:${a}`} variant="outline" title="authorized">{a}</Badge>)}
        </div>
      )}
      {d.job && d.job.questions.length > 0 && (
        <ul className="grid gap-1">
          {d.job.questions.map((q) => (
            <li key={q.id} className="rounded-md border border-question/25 bg-question/5 px-2 py-1 text-xs">
              {q.text} <a className="underline" href="#questions">Answer in Questions</a>
            </li>
          ))}
        </ul>
      )}
      {result !== undefined && <pre data-slot="direct-job-result" className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap">{result}</pre>}
      {d.job?.error && <p className="text-xs text-bad">{d.job.error}</p>}
    </li>
  );
}

export function DirectJobs() {
  const canOperate = useCanOperate();
  const [list, setList] = useState<DirectJobView[] | null>(null);
  const load = useCallback(async () => {
    const v = await get<{ directJobs: DirectJobView[] }>('/api/direct-jobs');
    if (Array.isArray(v?.directJobs)) setList(v.directJobs);
  }, []);
  usePoll(load, POLL_MS);
  return (
    <div className="grid max-w-3xl gap-3">
      {canOperate && <SubmitForm onSubmitted={() => { load().catch(() => {}); }} />}
      <Panel title="Direct jobs" icon={Zap} count={list?.length}>
        {list === null
          ? <Empty>loading</Empty>
          : list.length === 0
            ? <Empty>No direct jobs yet.</Empty>
            : <ul>{list.map((d) => <Row key={d.id} d={d} />)}</ul>}
      </Panel>
    </div>
  );
}
