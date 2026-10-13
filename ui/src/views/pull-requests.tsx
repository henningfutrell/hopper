// Pull requests (issue #637): every hopper pull request that waits — a done job's, followed after its end, or one closed
// without a merge — grouped per job repository, with the repository's yolo mode and a link to its one switch in Settings →
// Yolo mode (issue #897). The header says how many repositories have yolo mode on, where merging waits, and how many have
// merge conflicts (issue #897; the nav badge counts them too). Read from
// `GET /api/pull-requests`, again every few seconds and after a change. An open card has Merge now and Close PR for an
// operator (issue #677), each confirmed once, and Send back for rework (issue #724): with notes, the pull request becomes
// a draft and a new job reworks it. A repository with no checks (issue #677, `GET /api/repo-checks`) is named in the
// header and warned of in its group, with the job that adds them: Queue job files it at once, Dismiss hides it.
import { ExternalLink, GitMerge, GitPullRequest, TriangleAlert, Undo2, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { GhLink } from '@/components/job';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { StatusBadge, YoloBadge, type Tone } from '@/components/status';
import { Textarea } from '@/components/ui/textarea';
import { usePoll } from '@/hooks/use-poll';
import { useNow } from '@/hooks/use-now';
import { get } from '@/lib/api';
import { ago } from '@/model/format';
import { MERGEABLE_TEXT, checksText, closeQuestion, closesText, conflictedPullRequests, doingText, conflictsLine, mergeQuestion, hasCards, noChecksLine, noChecksNote, waitingLine, waitsText, yoloLine, yoloNote } from '@/model/pull-requests';
import type { PullRequestCard, PullRequestsView, RepoChecks, RepoChecksView } from '@/model/wire';
import { act } from '@/store';
import { setPolled } from '@/store/polled';
import { useCanOperate } from '@/store/selectors';

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
  // A tend job works on it (issue #763): its job follows it no more, so no act until the tend job ends.
  if (!operator || c.state !== 'open' || !c.pullRequest || c.tendJobId) return null;
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
        <span data-slot="pr-checks" className={CHECKS_TONE[c.checks]}>{checksText(c)}</span>
        <span data-slot="pr-mergeable" className={c.mergeable === 'conflicts' ? 'text-bad' : ''}>{MERGEABLE_TEXT[c.mergeable]}</span>
        {age && <span title={age}>{c.openedAt ? 'opened' : 'done'} {ago(age, now)}</span>}
        {c.waits && <span data-slot="pr-waits" className={c.waits === 'ready' ? 'text-ok' : ''}>{waitsText(c)}</span>}
      </div>
      {doingText(c) && <div data-slot="pr-doing" className={c.gaveUp ? 'text-xs text-bad' : 'text-xs text-muted-foreground'}>{doingText(c)}</div>}
      {c.mergeError && <div data-slot="pr-merge-error" className="text-xs text-bad">merge refused: {c.mergeError}</div>}
      <CardActions c={c} onChanged={onChanged} />
    </li>
  );
}

/** A repository with no checks (issue #677): the warning, and the recommended job with Queue job and Dismiss for an operator. */
function NoChecks({ r, onChanged }: { r: RepoChecks; onChanged: () => void }) {
  const operator = useCanOperate();
  const [busy, setBusy] = useState(false);
  const send = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    await act(path, body, done);
    setBusy(false);
    onChanged();
  };
  const job = r.recommendation;
  return (
    <div role="note" data-slot="repo-no-checks" className="flex gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs">
      <TriangleAlert className="size-4 shrink-0 text-amber-600" />
      <div className="space-y-1">
        <p>{noChecksNote(r)}</p>
        {job && (
          <div data-slot="repo-checks-job" className="flex flex-wrap items-center gap-2">
            <span>Recommended job: <span className="font-medium">{job.title}</span></span>
            {job.queued
              ? <GhLink url={job.queued.url}>queued as #{job.queued.number}</GhLink>
              : operator && <Button size="xs" variant="outline" disabled={busy} title="File it as an issue with the hopper label, assigned to you"
                onClick={() => void send('/ui/api/repo-checks/queue', { repo: r.repo }, `Queued: ${job.title}`)}>Queue job</Button>}
            {operator && <Button size="xs" variant="ghost" disabled={busy} title="Hide this job for this repository; the warning stays"
              onClick={() => void send('/ui/api/repo-checks/dismiss', { repo: r.repo, dismissed: true }, `Dismissed for ${r.repo}`)}>Dismiss</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

function RepoGroup({ group, checks, onChanged }: { group: PullRequestsView['repos'][number]; checks?: RepoChecks; onChanged: () => void }) {
  return (
    <section data-repo={group.repo}>
      <Panel title={group.repo} icon={GitPullRequest} count={group.pullRequests.length || ''} bodyClassName="p-0"
        action={<>
          {checks?.state === 'no checks' && <StatusBadge status="no-checks" label="no checks" tone="warn" />}
          <YoloBadge on={group.yolo} />
        </>}>
        <p data-slot="yolo-note" className="border-b px-4 py-2 text-xs text-muted-foreground">
          {yoloNote(group.yolo)} <a data-slot="yolo-settings" href="#settings/yolo-mode" className="underline">Change it in Settings → Yolo mode</a>
        </p>
        {checks?.state === 'no checks' && <NoChecks r={checks} onChanged={onChanged} />}
        {group.pullRequests.length
          ? <ul className="divide-y">{group.pullRequests.map((c) => <Card key={c.jobId} c={c} onChanged={onChanged} />)}</ul>
          : <Empty>no pull request waits</Empty>}
      </Panel>
    </section>
  );
}

export function PullRequests() {
  const [view, setView] = useState<PullRequestsView | undefined>();
  const [checks, setChecks] = useState<RepoChecksView>({ repos: [] });
  const load = useCallback(async () => {
    const v = await get<PullRequestsView>('/api/pull-requests');
    setView(v);
    setPolled('/api/pull-requests', v);
    // The checks are read in the background on the daemon: a failed read leaves the last answer.
    const c = await get<RepoChecksView>('/api/repo-checks').catch(() => undefined);
    if (Array.isArray(c?.repos)) setChecks(c);
  }, []);
  usePoll(load, POLL_MS);
  const reload = () => { load().catch(() => {}); };
  if (!view) return <Panel title="Pull requests" icon={GitPullRequest}><Empty>loading</Empty></Panel>;
  return (
    <div className="space-y-3">
      <Panel title="Pull requests" icon={GitPullRequest}>
        <div className="space-y-1 text-sm">
          <p data-slot="pr-yolo-line">{yoloLine(view)}</p>
          <p data-slot="pr-waiting-line" className="text-muted-foreground">{waitingLine(view)}</p>
          {conflictsLine(conflictedPullRequests(view)) && <p data-slot="pr-conflicts-line" className="font-medium text-bad">{conflictsLine(conflictedPullRequests(view))}</p>}
          {noChecksLine(checks) && <p data-slot="pr-no-checks-line" className="text-warn">{noChecksLine(checks)}</p>}
          {!hasCards(view) && <p data-slot="pr-empty" className="text-muted-foreground">No pull request waits.</p>}
        </div>
      </Panel>
      {view.repos.map((g) => <RepoGroup key={g.repo} group={g} checks={checks.repos.find((c) => c.repo.toLowerCase() === g.repo.toLowerCase())} onChanged={reload} />)}
    </div>
  );
}
