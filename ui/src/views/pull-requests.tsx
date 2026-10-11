// Pull requests (issue #637): every hopper pull request that waits — a done job's, followed after its end, or one closed
// without a merge — grouped per job repository, with the repository's yolo mode and, for an admin, a switch that turns
// it on or off. The header says how many repositories have yolo mode on, and where merging waits. Read from
// `GET /api/pull-requests`, again every few seconds and after a change. An open card has Merge now and Close PR for an
// operator (issue #677), each confirmed once, and Send back for rework (issue #724): with notes, the pull request becomes
// a draft and a new job reworks it.
import { ExternalLink, GitMerge, GitPullRequest, Undo2, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { GhLink } from '@/components/job';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { StatusBadge, YoloBadge, type Tone } from '@/components/status';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { usePoll } from '@/hooks/use-poll';
import { useNow } from '@/hooks/use-now';
import { get } from '@/lib/api';
import { ago } from '@/model/format';
import { CHECKS_TEXT, MERGEABLE_TEXT, closeQuestion, closesText, mergeQuestion, hasCards, waitingLine, waitsText, yoloLine, yoloNote, yoloToggle } from '@/model/pull-requests';
import type { PullRequestCard, PullRequestsView } from '@/model/wire';
import { act } from '@/store';
import { useCanAdmin, useCanOperate } from '@/store/selectors';

const POLL_MS = 10_000;

const STATE_TONE: Record<PullRequestCard['state'], Tone> = { open: 'busy', merged: 'ok', closed: 'bad' };
const CHECKS_TONE: Record<PullRequestCard['checks'], string> = { passing: 'text-ok', pending: 'text-warn', failing: 'text-bad', none: '', unknown: '' };

/**
 * Merge now and Close PR (issue #677), and Send back for rework (issue #724): an open card with a pull request, for an
 * operator. Rework's notes say what to change; they go to the new job, never to GitHub.
 */
function CardActions({ c, onChanged }: { c: PullRequestCard; onChanged: () => void }) {
  const operator = useCanOperate();
  const [busy, setBusy] = useState(false);
  const [reworking, setReworking] = useState(false);
  const [notes, setNotes] = useState('');
  if (!operator || c.state !== 'open' || !c.pullRequest) return null;
  const run = async (what: 'merge' | 'close') => {
    setBusy(true);
    await act(`/ui/api/pull-requests/${what}`, { jobId: c.jobId }, `#${c.pullRequest!.number} ${what === 'merge' ? 'merged' : 'closed'}`);
    setBusy(false);
    onChanged();
  };
  const rework = async () => {
    setBusy(true);
    const ok = await act(`/ui/api/jobs/${c.jobId}/rework`, { notes: notes.trim() }, `#${c.pullRequest!.number} sent back for rework`);
    setBusy(false);
    if (ok) { setReworking(false); setNotes(''); onChanged(); }
  };
  return (
    <div className="space-y-2 pt-1">
      <div data-slot="pr-actions" className="flex flex-wrap gap-2">
        <Confirm title={mergeQuestion(c)} action="Merge" onConfirm={() => void run('merge')}
          description="The hopper merges it now with a merge commit, whatever yolo mode and its checks say. GitHub still refuses a draft, merge conflicts or a required check.">
          <Button size="sm" variant="outline" disabled={busy}><GitMerge />Merge now</Button>
        </Confirm>
        <Button data-slot="pr-rework" size="sm" variant="outline" disabled={busy || reworking} title="Make it a draft, and a new job reworks it with your notes"
          onClick={() => setReworking(true)}><Undo2 />Send back for rework</Button>
        <Confirm title={closeQuestion(c)} action="Close PR" onConfirm={() => void run('close')}
          description="The pull request closes without a merge. Its issue gets hopper:pr-closed and is not taken again until a person removes the label.">
          <Button size="sm" variant="ghost" disabled={busy}><X />Close PR</Button>
        </Confirm>
      </div>
      {reworking && <>
        <Textarea data-slot="pr-rework-notes" aria-label="Rework notes" className="min-h-16 text-sm" maxLength={8000}
          placeholder="What should change? The new job is told your notes. The pull request becomes a draft until it is reworked."
          value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="flex gap-2">
          <Button data-slot="pr-rework-send" size="xs" disabled={busy || notes.trim() === ''} onClick={() => void rework()}>Send back</Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setReworking(false)}>Cancel</Button>
        </div>
      </>}
    </div>
  );
}

function Card({ c, onChanged }: { c: PullRequestCard; onChanged: () => void }) {
  const now = useNow();
  const age = c.openedAt ?? c.since;
  return (
    <li data-pull-request={c.jobId} className="space-y-1 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {c.pullRequest
          ? <GhLink url={c.pullRequest.url} className="font-medium text-foreground">#{c.pullRequest.number}<ExternalLink className="size-3 opacity-60" /></GhLink>
          : <span className="text-muted-foreground">pull request not found yet</span>}
        <GhLink url={c.issue.url} className="text-xs">{closesText(c)}</GhLink>
        <span data-slot="pr-state"><StatusBadge status={c.state} tone={STATE_TONE[c.state]} /></span>
        <span data-slot="pr-yolo"><YoloBadge on={c.yolo} /></span>
        {c.draft && <StatusBadge status="draft" tone="warn" />}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span data-slot="pr-checks" className={CHECKS_TONE[c.checks]}>{CHECKS_TEXT[c.checks]}</span>
        <span data-slot="pr-mergeable" className={c.mergeable === 'conflicts' ? 'text-bad' : ''}>{MERGEABLE_TEXT[c.mergeable]}</span>
        {age && <span title={age}>{c.openedAt ? 'opened' : 'done'} {ago(age, now)}</span>}
        {c.waits && <span data-slot="pr-waits" className={c.waits === 'ready' ? 'text-ok' : ''}>{waitsText(c)}</span>}
      </div>
      {c.mergeError && <div data-slot="pr-merge-error" className="text-xs text-bad">merge refused: {c.mergeError}</div>}
      <CardActions c={c} onChanged={onChanged} />
    </li>
  );
}

function RepoGroup({ group, onChanged }: { group: PullRequestsView['repos'][number]; onChanged: () => void }) {
  const admin = useCanAdmin();
  const [busy, setBusy] = useState(false);
  const toggle = async (on: boolean) => {
    setBusy(true);
    await act('/ui/api/yolo-mode', yoloToggle(group.repo, on), `Yolo mode ${on ? 'on' : 'off'} for ${group.repo}`);
    setBusy(false);
    onChanged();
  };
  return (
    <section data-repo={group.repo}>
      <Panel title={group.repo} icon={GitPullRequest} count={group.pullRequests.length || ''} bodyClassName="p-0"
        action={<>
          <YoloBadge on={group.yolo} />
          <Switch checked={group.yolo} disabled={!admin || busy} aria-label={`Yolo mode for ${group.repo}`}
            title={admin ? undefined : 'Only an admin changes yolo mode'} onCheckedChange={(on) => void toggle(on)} />
        </>}>
        <p data-slot="yolo-note" className="border-b px-4 py-2 text-xs text-muted-foreground">{yoloNote(group.yolo)}</p>
        {group.pullRequests.length
          ? <ul className="divide-y">{group.pullRequests.map((c) => <Card key={c.jobId} c={c} onChanged={onChanged} />)}</ul>
          : <Empty>no pull request waits</Empty>}
      </Panel>
    </section>
  );
}

export function PullRequests() {
  const [view, setView] = useState<PullRequestsView | undefined>();
  const load = useCallback(async () => setView(await get<PullRequestsView>('/api/pull-requests')), []);
  usePoll(load, POLL_MS);
  const reload = () => { load().catch(() => {}); };
  if (!view) return <Panel title="Pull requests" icon={GitPullRequest}><Empty>loading</Empty></Panel>;
  return (
    <div className="space-y-3">
      <Panel title="Pull requests" icon={GitPullRequest}>
        <div className="space-y-1 text-sm">
          <p data-slot="pr-yolo-line">{yoloLine(view)}</p>
          <p data-slot="pr-waiting-line" className="text-muted-foreground">{waitingLine(view)}</p>
          {!hasCards(view) && <p data-slot="pr-empty" className="text-muted-foreground">No pull request waits.</p>}
        </div>
      </Panel>
      {view.repos.map((g) => <RepoGroup key={g.repo} group={g} onChanged={reload} />)}
    </div>
  );
}
