// Promote to GitHub (issue #946, design.md "Promote to GitHub"), on a direct job's row: the offer once its job finished,
// the promotion with what changed since and a revoke, and the promote form — the repository and the target first, then a
// preview the person edits (the title, the text, the labels, which artifacts to link) and confirms. Nothing is posted
// before the confirm; a public repository and personal data each need their own tick. Posted with the person's own
// GitHub connection. Only for an operator or admin: the daemon refuses the rest. Part 2: a small text artifact is committed
// to the promotion's branch when the person ticks it; the job view (job.tsx) shows this part for a direct job's job too.
import { CloudUpload, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { get, post, SessionRejected } from '@/lib/api';
import {
  fromPreview, offerLine, previewProblem, previewRequest, promotable, promoteProblem, promoteRequest, promotionLine, startEdits, type PromoteEdits,
} from '@/model/promotions';
import type { DirectJobView, PromotionDraft } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanOperate } from '@/store/selectors';

const failed = (e: unknown) => {
  if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
  toast.error((e as Error).message);
};

function Tick({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function PromoteForm({ d, onDone }: { d: DirectJobView; onDone: () => void }) {
  const [e, setE] = useState<PromoteEdits>(() => startEdits(d));
  const [draft, setDraft] = useState<PromotionDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof PromoteEdits>(k: K, v: PromoteEdits[K]) => setE((x) => ({ ...x, [k]: v }));
  const text = (k: 'repo' | 'number' | 'title' | 'body' | 'labels') => (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k, ev.target.value);
  const problem = draft ? promoteProblem(e, draft) : previewProblem(e);
  const preview = async () => {
    setBusy(true);
    try {
      const p = await post<PromotionDraft>(`/ui/api/direct-jobs/${d.id}/promotion/preview`, previewRequest(e));
      setDraft(p);
      setE((x) => fromPreview(x, p));
    } catch (err) { failed(err); }
    setBusy(false);
  };
  const confirm = async () => {
    setBusy(true);
    try {
      await post(`/ui/api/direct-jobs/${d.id}/promotion`, promoteRequest(e));
      toast.success(d.promotion ? 'Promotion updated on GitHub' : 'Promoted to GitHub');
      onDone();
    } catch (err) { failed(err); }
    setBusy(false);
  };
  return (
    <div data-slot="promote-form" className="grid gap-2 rounded-md border p-2 text-xs">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <Input aria-label="Promote to repository" placeholder="owner/name" value={e.repo} onChange={text('repo')} disabled={d.promotion !== undefined} />
        <select aria-label="Promote as" className="rounded-md border bg-background px-2" value={e.target} disabled={d.promotion !== undefined}
          onChange={(ev) => set('target', ev.target.value === 'comment' ? 'comment' : 'issue')}>
          <option value="issue">a new issue</option>
          <option value="comment">a comment on an issue</option>
        </select>
        {e.target === 'comment' && <Input aria-label="Issue number" className="w-24" inputMode="numeric" value={e.number} onChange={text('number')} disabled={d.promotion !== undefined} />}
      </div>
      <Tick label="Name the requester" checked={e.includeRequester} onChange={(v) => set('includeRequester', v)} />
      {draft && (
        <div data-slot="promote-preview" className="grid gap-2">
          <p className="flex flex-wrap items-center gap-1">
            <Badge variant={draft.visibility === 'public' ? 'destructive' : 'secondary'}>{draft.visibility}</Badge> {draft.repo}
            {draft.update && <span className="text-muted-foreground"> · updates {draft.update.kind === 'issue' ? 'issue' : 'the comment on'} #{draft.update.number}</span>}
          </p>
          <Input aria-label="Issue title" value={e.title} onChange={text('title')} maxLength={256} />
          <Textarea aria-label="Text to post" value={e.body} onChange={text('body')} rows={8} />
          {e.target === 'issue' && <Input aria-label="Labels to carry" value={e.labels} onChange={text('labels')} placeholder="sme:identity" />}
          {draft.artifacts.map((a) => (
            <div key={a.id} className="grid gap-1">
              <Tick label={`Link ${a.title} (revision ${a.revision})`} checked={e.artifacts.includes(a.id)}
                onChange={(v) => set('artifacts', v ? [...e.artifacts, a.id] : e.artifacts.filter((x) => x !== a.id))} />
              <div className="pl-5">
                {'branch' in a.commit
                  ? e.artifacts.includes(a.id) && <Tick label={`Commit ${a.title} to ${a.commit.branch}`} checked={e.commit.includes(a.id)}
                    onChange={(v) => set('commit', v ? [...e.commit, a.id] : e.commit.filter((x) => x !== a.id))} />
                  : <p className="text-muted-foreground">Linked only: {a.commit.no}.</p>}
              </div>
            </div>
          ))}
          <pre className="max-h-32 overflow-auto rounded-md bg-muted/50 p-2 whitespace-pre-wrap" title="added below the text">{draft.footer}</pre>
          {draft.findings.map((f) => <p key={f.kind} className="text-bad">The text holds {f.what}.</p>)}
          {draft.notes.map((n) => <p key={n} className="text-muted-foreground">{n}</p>)}
          {draft.visibility === 'public'
            ? <Tick label="Post to this public repository" checked={e.confirmPublic} onChange={(v) => set('confirmPublic', v)} />
            : <Tick label="Allow personal data in this private repository" checked={e.allowPersonalData} onChange={(v) => set('allowPersonalData', v)} />}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {problem && <span data-slot="promote-problem" className="text-muted-foreground">{problem}</span>}
        {draft
          ? <Button size="sm" disabled={busy || problem !== undefined} onClick={() => { void confirm(); }}><CloudUpload />Confirm and post</Button>
          : <Button size="sm" variant="outline" disabled={busy || problem !== undefined} onClick={() => { void preview(); }}>Preview</Button>}
      </div>
    </div>
  );
}

/** The promotion part of a direct job's row. */
export function Promotion({ d, canOperate, onChanged }: { d: DirectJobView; canOperate: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const offer = offerLine(d);
  const line = promotionLine(d);
  const revoke = async () => {
    try {
      const r = await post<{ note: string }>(`/ui/api/direct-jobs/${d.id}/promotion/revoke`);
      toast.success(r.note);
      onChanged();
    } catch (err) { failed(err); }
  };
  if (!promotable(d) && !line) return null;
  return (
    <div data-slot="direct-job-promotion" className="grid gap-1.5">
      {offer && <p data-slot="promote-offer" className="rounded-md border border-question/25 bg-question/5 px-2 py-1 text-xs">{offer}</p>}
      {line && d.promotion && (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <a className="underline" href={d.promotion.url} target="_blank" rel="noreferrer">{line}</a>
          {d.promotion.stale.length > 0 && <Badge variant="outline">stale</Badge>}
          {canOperate && (
            <Confirm title="Revoke the promotion?" action="Revoke" onConfirm={() => { void revoke(); }}
              description="The link in the hopper ends. Nothing is unpublished: GitHub keeps the issue or the comment, and its text, until a person removes it there.">
              <Button size="xs" variant="ghost"><Undo2 />Revoke</Button>
            </Confirm>
          )}
        </p>
      )}
      {canOperate && promotable(d) && (open
        ? <PromoteForm d={d} onDone={() => { setOpen(false); onChanged(); }} />
        : <Button size="xs" variant="outline" className="justify-self-start" onClick={() => setOpen(true)}><CloudUpload />{d.promotion ? 'Promote again' : 'Promote to GitHub'}</Button>)}
    </div>
  );
}

/** The promotion part on a direct job's job view (issue #935): its direct job read, then the same part as in Direct jobs. */
export function JobPromotion({ directJobId }: { directJobId: string }) {
  const canOperate = useCanOperate();
  const [d, setD] = useState<DirectJobView | null>(null);
  const load = useCallback(() => get<DirectJobView>(`/api/direct-jobs/${encodeURIComponent(directJobId)}`).then(setD, () => setD(null)), [directJobId]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return null;
  return (
    <div data-slot="job-promotion" className="grid gap-1.5 border-t pt-2">
      <p className="text-xs text-muted-foreground">Direct job: <a className="underline" href="#ask/direct-jobs">{d.title}</a></p>
      <Promotion d={d} canOperate={canOperate} onChanged={() => { void load(); }} />
    </div>
  );
}
