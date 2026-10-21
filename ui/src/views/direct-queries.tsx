// Direct queries (issue #2184, design.md "Direct queries"), the Ask a question tab of Ask hopper (#ask/direct-queries, issues #2375, #2374): every question a caller —
// an agent with a box token, or a person here — asked the hopper straight, with no GitHub issue, answered by a job that
// only looks. Each row reads the query back, newest first: where it stands, who asked it and the way, the webhook
// subscription its callback goes to, its hints, its open questions (answered in Questions; they go to the callback too),
// its answer, its error and its evidence (its job's artifacts, private in the hopper). An operator cancels one whose job is
// not at an end, and asks a question from the form; the daemon refuses the rest. Read when shown, and every 15 s.
import { LogBlock } from '@/components/log-block';
import { MessageSquareText, Send, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { usePoll } from '@/hooks/use-poll';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { resultText, submittedLine } from '@/model/direct-jobs';
import { canCancelQuery, directQueryRequest, emptyQueryDraft, newRequestId, queryDraftProblem, queryStateOf, type DirectQueryDraft } from '@/model/direct-queries';
import type { DirectQueryView } from '@/model/wire';
import { act, useHopper } from '@/store';
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

function AskForm({ onAsked }: { onAsked: () => void }) {
  const [draft, setDraft] = useState<DirectQueryDraft>(emptyQueryDraft);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof DirectQueryDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const problem = queryDraftProblem(draft);
  const ask = async () => {
    setBusy(true);
    try {
      await post('/ui/api/direct-queries', directQueryRequest(draft, newRequestId()));
      toast.success('Question asked');
      setDraft(emptyQueryDraft());
      onAsked();
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an operator or admin asks a direct query' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Panel title="Ask a question" icon={Send}>
      <form data-slot="direct-query-form" className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (!problem) void ask(); }}>
        <p className="text-sm text-muted-foreground">
          A job that only looks answers it, with no GitHub issue. It changes no code, infrastructure or secret. The question and the answer stay in the hopper.
        </p>
        <Field label="Question"><Textarea aria-label="Question" value={draft.question} onChange={set('question')} rows={3} /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Callback" hint="optional, a webhook subscription"><Input aria-label="Callback" value={draft.callback} onChange={set('callback')} /></Field>
          <Field label="Repositories" hint="where to look first"><Input aria-label="Repositories" value={draft.repos} onChange={set('repos')} placeholder="owner/name" /></Field>
          <Field label="Clusters" hint="where to look first"><Input aria-label="Clusters" value={draft.clusters} onChange={set('clusters')} /></Field>
        </div>
        <div className="flex items-center justify-end gap-3">
          {problem && <span data-slot="direct-query-problem" className="text-xs text-muted-foreground">{problem}</span>}
          <Button type="submit" size="sm" disabled={busy || problem !== undefined}><Send />Ask</Button>
        </div>
      </form>
    </Panel>
  );
}

function Row({ q, canOperate }: { q: DirectQueryView; canOperate: boolean }) {
  const state = queryStateOf(q);
  const answer = resultText(q.job?.result);
  const hints = [...(q.query.repos ?? []), ...(q.query.clusters ?? [])];
  return (
    <li data-slot="direct-query-row" className="grid gap-1.5 border-b py-3 text-sm first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium" title={q.brief}>{q.title}</span>
        <StatusBadge status={q.state} label={state.label} tone={state.tone} />
      </div>
      <p className="text-xs text-muted-foreground">
        {submittedLine(q).replace('Submitted', 'Asked')} · {new Date(q.submittedAt).toLocaleString()}{q.query.callback ? ` · callback ${q.query.callback}` : ''}
        {q.job && <> · <a className="underline" href={`#job/${q.job.id}`}>its job</a></>}
      </p>
      {hints.length > 0 && <div className="flex flex-wrap gap-1">{hints.map((h) => <Badge key={h} variant="outline" title="where to look first">{h}</Badge>)}</div>}
      {q.job && q.job.questions.length > 0 && (
        <ul className="grid gap-1">
          {q.job.questions.map((x) => (
            <li key={x.id} className="rounded-md border border-question/25 bg-question/5 px-2 py-1 text-xs">
              {x.text} <a className="underline" href="#questions">Answer in Questions</a>
            </li>
          ))}
        </ul>
      )}
      {answer !== undefined && <div data-slot="direct-query-answer"><LogBlock title="Answer" copy={answer} wrap contentClassName="max-h-48 text-xs">{answer}</LogBlock></div>}
      {q.job?.error && <p className="text-xs text-bad">{q.job.error}</p>}
      {q.artifacts.length > 0 && (
        <ul data-slot="direct-query-evidence" className="grid gap-0.5 text-xs">
          {q.artifacts.map((a) => (
            <li key={a.id}><a className="underline" href={`#artifacts/${a.id}`}>{a.title}</a>{a.summary ? ` — ${a.summary}` : ''} <span className="text-muted-foreground">({a.kind}, revision {a.revision})</span></li>
          ))}
        </ul>
      )}
      {canOperate && canCancelQuery(q) && (
        <div>
          <Confirm title="Cancel this query?" action="Cancel query" onConfirm={() => { void act(`/ui/api/jobs/${encodeURIComponent(q.job!.id)}/cancel`, {}, 'Query cancelled'); }}
            description={<>“{q.title}” ends cancelled, and its callback is told.</>}>
            <Button size="xs" variant="outline"><X />Cancel</Button>
          </Confirm>
        </div>
      )}
    </li>
  );
}

export function DirectQueries() {
  const canOperate = useCanOperate();
  const [list, setList] = useState<DirectQueryView[] | null>(null);
  const load = useCallback(async () => {
    const v = await get<{ directQueries: DirectQueryView[] }>('/api/direct-queries');
    if (Array.isArray(v?.directQueries)) setList(v.directQueries);
  }, []);
  usePoll(load, POLL_MS);
  return (
    <div className="grid max-w-3xl gap-3">
      {canOperate && <AskForm onAsked={() => { load().catch(() => {}); }} />}
      <Panel title="Questions asked" icon={MessageSquareText} count={list?.length}>
        {list === null
          ? <Empty>loading</Empty>
          : list.length === 0
            ? <Empty>No questions yet. Ask one above, or a caller asks one with POST /ui/api/direct-queries.</Empty>
            : <ul>{list.map((q) => <Row key={q.id} q={q} canOperate={canOperate} />)}</ul>}
      </Panel>
    </div>
  );
}
