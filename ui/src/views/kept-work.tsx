// Work not pushed (issue #1010, design.md "Work not pushed"): in Failures, each ended job whose reap kept work not pushed —
// where its work tree is, and the repositories holding the work —, with Push it (its own session goes on in its kept work
// tree, told to push and open the pull request; a note for it) and Discard (asked first: the work is lost), or why Push
// it is not taken now. Each repository says why it was kept: changes not committed, a stash, commits not pushed (issue
// #2494). Shown only when there is some. A discard shows at once as removed on the machine (issue #1194): the
// daemon answers before the removal, which the entry follows — under way, or failed with why and Discard again.
import { GitBranch, Loader2, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/confirm';
import { Textarea } from '@/components/ui/textarea';
import { JobTitle } from '@/components/job';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { ago } from '@/model/format';
import type { KeptReason, KeptWorkView } from '@/model/wire';
import { failureAct } from '@/store';
import { giveBack, PENDING, useGivingBack } from '@/store/give-back';
import { useCanOperate, useJobIndex } from '@/store/selectors';
import { ReportBugButton } from '@/app/bug-report';

/** Why the reap kept a repository (issue #2494), in plain words. */
const KEPT_WHY: Record<KeptReason, string> = { dirty: 'changes not committed', stash: 'a stash', unpushed: 'commits not pushed' };

/** One job's work not pushed (issue #1010): where it is, and its ways out — or why not now. */
function KeptWorkRow({ k }: { k: KeptWorkView }) {
  const canAct = useCanOperate();
  const job = useJobIndex().get(k.jobId);
  const now = useNow();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // A discard sent shows as removing at once, until the daemon's answer and the view read after it.
  const [discardSent, setDiscardSent] = useState(false);
  const id = encodeURIComponent(k.jobId);
  const removing = discardSent || k.discarding?.state === 'removing';
  const pushing = useGivingBack((s) => s[k.jobId] !== undefined);
  const run = async (path: string, body: unknown, done: string): Promise<boolean> => {
    setBusy(true);
    const ok = await failureAct(`/ui/api/failures/kept-work/${id}/${path}`, body, done);
    if (ok) setNote('');
    setBusy(false);
    return ok;
  };
  // Answered at once (issue #1194): its source takes the item back after, and the stream says how it ended.
  const push = async () => {
    if (await giveBack(k.jobId, 'push', { path: `/ui/api/failures/kept-work/${id}/push`, body: note.trim() ? { note: note.trim() } : {} })) setNote('');
  };
  return (
    <li data-kept-work={k.jobId} className="space-y-2 px-4 py-3">
      <div className="flex items-start gap-2">
        {job ? <JobTitle job={job} /> : <span className="font-mono text-xs text-muted-foreground">job {k.jobId.slice(0, 8)}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <StatusBadge status={k.status} />
          <ReportBugButton jobId={k.jobId} />
        </span>
      </div>
      <p className="text-sm">The job ended with work that is not pushed. Its work tree is kept{k.machineId ? <> on <span className="font-mono">{k.machineId}</span></> : ''}.</p>
      {removing && <p data-slot="kept-work-removing" className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />Discarded: removing the work tree on its machine</p>}
      {!removing && k.discarding?.state === 'failed' && <p data-slot="kept-work-discard-failed" role="alert" className="text-sm text-bad">The discard failed: {k.discarding.error}. The work is still kept.</p>}
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {k.paths.map((p) => (
          <li key={p} className="flex flex-wrap items-center gap-1.5">
            <GitBranch className="size-3 shrink-0" aria-hidden /><span className="break-all font-mono">{p}</span>
            {k.reasons?.[p]?.length ? <span data-slot="kept-why">— {k.reasons[p].map((r) => KEPT_WHY[r]).join(', ')}</span> : null}
          </li>
        ))}
      </ul>
      {canAct && !removing && (
        <div className="space-y-2">
          {k.actions.push.ok && <Textarea aria-label="Note for the job" placeholder="Note for the job (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="text-sm" />}
          <div className="flex flex-wrap items-center gap-2">
            {k.actions.push.ok
              ? <Button size="sm" disabled={busy || pushing} onClick={() => void push()}><Upload />{pushing ? PENDING.push : 'Push it'}</Button>
              : <span data-slot="push-why" className="text-xs text-muted-foreground">Push it: not now — {k.actions.push.why}.</span>}
            {k.actions.discard.ok && !pushing && (
              <Confirm title="Discard the work?" action="Discard" onConfirm={() => { setDiscardSent(true); void run('discard', {}, 'Discard sent: the work tree is removed on its machine').then(() => setDiscardSent(false)); }}
                description="The job's work tree is removed on its machine with all its work that is not pushed. You cannot undo this.">
                <Button size="sm" variant="outline" disabled={busy}><Trash2 />Discard</Button>
              </Confirm>
            )}
          </div>
          {k.actions.push.ok && <p className="text-xs text-muted-foreground">Push it: the job goes on in its own session and work tree. It pushes the work and opens the pull request, as a draft when the work is not finished.{k.handoffId ? ' Its hand-off in Needs a person closes as Continue.' : ''}</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="num" title={k.at}>kept {ago(k.at, now)}</span>
      </div>
    </li>
  );
}

/** Work not pushed (issue #1010): only when there is some. */
export function WorkNotPushed({ kept }: { kept: KeptWorkView[] }) {
  if (!kept.length) return null;
  return (
    <div data-section="work-not-pushed">
      <Panel title="Work not pushed" icon={GitBranch} count={kept.length} bodyClassName="p-0" className="border-warn/40">
        <ul className="divide-y">{kept.map((k) => <KeptWorkRow key={k.jobId} k={k} />)}</ul>
      </Panel>
    </div>
  );
}
