// Direct jobs (issue #901, design.md "Direct jobs"), the Run a job tab of Ask hopper (#ask/direct-jobs, issues #2375, #2374; ask.tsx): a person submits a job straight to
// the hopper — a title, a brief, routing labels, what they authorize, and the one repository its work may open a pull
// request on —, with no GitHub issue behind it. The list reads each direct job back, newest first, with its job's state,
// its open questions (answered in Questions), its result, its error and its artifacts. The brief and the results stay in
// the hopper until a person promotes them to GitHub (issue #946, direct-job-promotion.tsx); one offered for promotion is
// pinned at the top. A direct query (issue #2184) is left out: it is the Ask a question tab (direct-queries.tsx). The form only for an operator or admin: the daemon refuses the rest. Read when shown, and every 15 s.
import { LogBlock } from '@/components/log-block';
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
import { directDraftProblem, directJobRequest, directJobState, emptyDirectDraft, offeredFirst, resultText, submittedLine, type DirectJobDraft } from '@/model/direct-jobs';
import { onlyDirectJobs } from '@/model/direct-queries';
import type { DirectJobView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanOperate } from '@/store/selectors';
import { Promotion } from './direct-job-promotion';

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
  const set = (k: Exclude<keyof DirectJobDraft, 'promoteWhenDone'>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));
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
    <Panel title="Run a job" icon={Send}>
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
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" aria-label="Offer to promote it to GitHub when done" checked={draft.promoteWhenDone} onChange={(e) => setDraft((d) => ({ ...d, promoteWhenDone: e.target.checked }))} />
            Offer to promote it to GitHub when done
          </label>
          <div className="flex items-center gap-3">
            {problem && <span data-slot="direct-job-problem" className="text-xs text-muted-foreground">{problem}</span>}
            <Button type="submit" size="sm" disabled={busy || problem !== undefined}><Send />Submit</Button>
          </div>
        </div>
      </form>
    </Panel>
  );
}

function Row({ d, canOperate, onChanged }: { d: DirectJobView; canOperate: boolean; onChanged: () => void }) {
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
      {result !== undefined && <div data-slot="direct-job-result"><LogBlock title="Result" copy={result} wrap contentClassName="max-h-48 text-xs">{result}</LogBlock></div>}
      {d.job?.error && <p className="text-xs text-bad">{d.job.error}</p>}
      {d.artifacts.length > 0 && (
        <ul data-slot="direct-job-artifacts" className="grid gap-0.5 text-xs">
          {d.artifacts.map((a) => (
            <li key={a.id}><a className="underline" href={`#artifacts/${a.id}`}>{a.title}</a>{a.summary ? ` — ${a.summary}` : ''} <span className="text-muted-foreground">({a.kind}, revision {a.revision})</span></li>
          ))}
        </ul>
      )}
      <Promotion d={d} canOperate={canOperate} onChanged={onChanged} />
    </li>
  );
}

export function DirectJobs() {
  const canOperate = useCanOperate();
  const [list, setList] = useState<DirectJobView[] | null>(null);
  const load = useCallback(async () => {
    const v = await get<{ directJobs: DirectJobView[] }>('/api/direct-jobs');
    if (Array.isArray(v?.directJobs)) setList(onlyDirectJobs(v.directJobs));
  }, []);
  usePoll(load, POLL_MS);
  return (
    <div className="grid max-w-3xl gap-3">
      {canOperate && <SubmitForm onSubmitted={() => { load().catch(() => {}); }} />}
      <Panel title="Jobs run" icon={Zap} count={list?.length}>
        {list === null
          ? <Empty>loading</Empty>
          : list.length === 0
            ? <Empty>No jobs run here yet.</Empty>
            : <ul>{offeredFirst(list).map((d) => <Row key={d.id} d={d} canOperate={canOperate} onChanged={() => { load().catch(() => {}); }} />)}</ul>}
      </Panel>
    </div>
  );
}
