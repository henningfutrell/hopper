// Pull requests (issue #637): every hopper pull request that waits — a done job's, followed after its end, or one closed
// without a merge — grouped per job repository, with the repository's yolo mode and a link to its one switch in Settings →
// Yolo mode (issue #897). The header says how many repositories have yolo mode on, where merging waits, and how many have
// merge conflicts (issue #897; the nav badge counts them too). Read from
// `GET /api/pull-requests`, again every few seconds and after a change. An open card has Merge now and Close PR for an
// operator (issue #677), each confirmed once, and Send back for rework (issue #724): with notes, the pull request becomes
// a draft and a new job reworks it. A repository with no checks (issue #677, `GET /api/repo-checks`) is named in the
// header and warned of in its group, with the job that adds them: Queue job files it at once, Dismiss hides it.
// A card the hopper gave up on (its tend job ended failed, cancelled or rejected) has Tend again (issue #1010).
// Landing (issue #1073): the job pull requests merged into the landing branch, each with its batch stage, until a batch run
// moves it to the tested branch. Not tracked (issue #1176): each open pull request of a job repository the hopper does not
// track, with why; one whose issue is not in Intake has Take into Intake, which shows its GitHub write on the row (issue #1194).
// Each card shows its change kind (issue #1076), why in its title. A card with a pull request, and a landing card — a batch's
// culprit among them —, opens its diff in a code block (issue #1169). A long page (issue #2353): Cards or Rows — a row is
// one line, its acts on the card —, each group folds, and a group past one page pages; the mode and the folds are kept
// per browser, and the header with the mode stays in view.
import { ExternalLink, GitMerge, GitPullRequest, LayoutList, List, RotateCw, TriangleAlert, Undo2, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { GhLink } from '@/components/job';
import { Confirm } from '@/components/confirm';
import { JobAct } from '@/components/job-act';
import { PullRequestDiff } from '@/components/pull-request-diff';
import { Empty, Panel } from '@/components/panel';
import { ModeToggle, Pager, usePaged } from '@/components/pager';
import { Button } from '@/components/ui/button';
import { StatusBadge, YoloBadge, type Tone } from '@/components/status';
import { Textarea } from '@/components/ui/textarea';
import { usePoll } from '@/hooks/use-poll';
import { useNow } from '@/hooks/use-now';
import { useGroupOpen, usePagePref } from '@/hooks/use-page-pref';
import { get } from '@/lib/api';
import { ago } from '@/model/format';
import { CARDS_PER_PAGE, ROWS_PER_PAGE } from '@/model/page-prefs';
import { CHANGE_KIND_TEXT, MERGEABLE_TEXT, changeWhy, checksProblemText, checksText, closeQuestion, closesText, conflictedPullRequests, doingText, conflictsLine, mergeQuestion, hasCards, noChecksLine, noChecksNote, waitingLine, waitsText, yoloLine, yoloNote } from '@/model/pull-requests';
import type { ChecksProblem, PullRequestCard, PullRequestsView, RepoChecks, RepoChecksView } from '@/model/wire';
import { act } from '@/store';
import { giveBack, PENDING, useGivingBack } from '@/store/give-back';
import { ACTING, actOnPullRequest, useActingOnPullRequest, type PullRequestAct } from '@/store/pull-request-acts';
import { setPolled } from '@/store/polled';
import { Landing, Untracked } from './pull-requests-landing';
import { useCanOperate } from '@/store/selectors';

const POLL_MS = 10_000;

const MODES = [
  { mode: 'cards', label: 'Cards', icon: LayoutList, title: 'Each pull request with its acts and its diff' },
  { mode: 'rows', label: 'Rows', icon: List, title: 'One line per pull request' },
] as const;
type Mode = (typeof MODES)[number]['mode'];
const MODE_NAMES: readonly Mode[] = MODES.map((m) => m.mode);
const useMode = () => usePagePref<Mode>('pull-requests.mode', 'cards', MODE_NAMES);

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
  const sendingBack = useGivingBack((s) => s[c.jobId] === 'rework');
  const acting = useActingOnPullRequest((s) => s[c.jobId]);
  // A tend job works on it (issue #763): its job follows it no more, so no act until the tend job ends.
  // A direct job's (issue #1068): these acts go through a GitHub source's outbox, which the direct source has not; a person acts on GitHub.
  if (!operator || c.state !== 'open' || !c.pullRequest || c.tendJobId || c.directJob) return null;
  // Answered at once (issue #1194): GitHub merges or closes it after, and the card waits until the stream says so.
  const run = (what: PullRequestAct) => void actOnPullRequest(c.jobId, what, onChanged);
  const waiting = busy || acting !== undefined;
  // Answered at once (issue #1194): the pull request is made a draft after, and the card waits until the stream says so.
  const rework = async () => {
    setBusy(true);
    const ok = await giveBack(c.jobId, 'rework', { body: { notes: notes.trim() }, ended: onChanged });
    setBusy(false);
    if (ok) { setReworking(false); setNotes(''); onChanged(); }
  };
  return (
    <div className="space-y-2 pt-1">
      <div data-slot="pr-actions" className="flex flex-wrap gap-2">
        <Confirm title={mergeQuestion(c)} action="Merge" onConfirm={() => run('merge')}
          description="The hopper merges it now with a merge commit, whatever yolo mode and its checks say. GitHub still refuses a draft, merge conflicts or a required check.">
          <Button size="sm" variant="outline" disabled={waiting}><GitMerge />{acting === 'merge' ? ACTING.merge : 'Merge now'}</Button>
        </Confirm>
        <Button data-slot="pr-rework" size="sm" variant="outline" disabled={waiting || reworking || sendingBack} title="Make it a draft, and a new job reworks it with your notes"
          onClick={() => setReworking(true)}><Undo2 />{sendingBack ? 'Sending back' : 'Send back for rework'}</Button>
        <Confirm title={closeQuestion(c)} action="Close PR" onConfirm={() => run('close')}
          description="The pull request closes without a merge. Its issue gets hopper:pr-closed and is not taken again until a person removes the label.">
          <Button size="sm" variant="ghost" disabled={waiting}><X />{acting === 'close' ? ACTING.close : 'Close PR'}</Button>
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

/**
 * Tend again (issue #1010): the hopper gave up on the card — its tend job ended failed, cancelled or rejected — so its one
 * action, for an operator, tends the same step at once.
 */
function TendAgain({ c, onChanged }: { c: PullRequestCard; onChanged: () => void }) {
  const operator = useCanOperate();
  const tending = useGivingBack((s) => s[c.jobId] === 'tend');
  if (!operator || c.state !== 'open' || c.waits !== 'tend failed' || !c.tendJobId) return null;
  // Answered at once (issue #1194): the tend runs after, and the button waits until the stream says how it ended.
  const run = () => giveBack(c.jobId, 'tend', { path: '/ui/api/pull-requests/tend', body: { jobId: c.jobId }, ended: onChanged });
  return (
    <div data-slot="pr-tend-again" className="flex flex-wrap items-center gap-2 pt-1">
      <Button size="sm" disabled={tending} onClick={() => void run()}><RotateCw />{tending ? PENDING.tend : 'Tend again'}</Button>
      <span className="text-xs text-muted-foreground">A new job takes the same step. Read why it failed first.</span>
    </div>
  );
}

/** A pull request on one line (issue #2353): its number, what it closes, its state, checks, conflicts and what it waits on. */
function Row({ c }: { c: PullRequestCard }) {
  const now = useNow();
  const age = c.openedAt ?? c.since;
  return (
    <li data-pull-request={c.jobId} data-slot="pr-row" className="flex h-9 min-w-0 items-center gap-3 px-4 text-xs text-muted-foreground">
      {c.pullRequest
        ? <GhLink url={c.pullRequest.url} className="shrink-0 text-sm font-medium text-foreground">#{c.pullRequest.number}</GhLink>
        : <span className="shrink-0">not found yet</span>}
      <span className="min-w-0 flex-1 truncate" title={closesText(c)}>{closesText(c)}</span>
      <span data-slot="pr-state" className="shrink-0"><StatusBadge status={c.state} tone={STATE_TONE[c.state]} /></span>
      <span data-slot="pr-checks" className={`hidden w-28 shrink-0 truncate sm:inline ${CHECKS_TONE[c.checks]}`}>{checksText(c)}</span>
      <span data-slot="pr-mergeable" className={`hidden w-28 shrink-0 truncate md:inline ${c.mergeable === 'conflicts' ? 'text-bad' : ''}`}>{MERGEABLE_TEXT[c.mergeable]}</span>
      <span data-slot="pr-waits" className={`hidden w-40 shrink-0 truncate lg:inline ${c.waits === 'ready' ? 'text-ok' : ''}`}>{c.waits ? waitsText(c) : ''}</span>
      <span className="num hidden w-16 shrink-0 truncate text-right md:inline" title={age}>{age ? ago(age, now) : ''}</span>
    </li>
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
        {c.issue
          ? <GhLink url={c.issue.url} className="text-xs">{closesText(c)}</GhLink>
          : c.directJob && <a href={c.directJob.url} className="text-xs text-muted-foreground hover:underline">{closesText(c)}</a>}
        <span data-slot="pr-state"><StatusBadge status={c.state} tone={STATE_TONE[c.state]} /></span>
        <span data-slot="pr-yolo"><YoloBadge on={c.yolo} /></span>
        {c.change && <span data-slot="pr-change-kind"><StatusBadge status={`change-${c.change.kind}`} label={CHANGE_KIND_TEXT[c.change.kind].label} tone={CHANGE_KIND_TEXT[c.change.kind].tone} title={changeWhy(c)} /></span>}
        {c.draft && <StatusBadge status="draft" tone="warn" />}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span data-slot="pr-checks" className={CHECKS_TONE[c.checks]}>{checksText(c)}</span>
        <span data-slot="pr-mergeable" className={c.mergeable === 'conflicts' ? 'text-bad' : ''}>{MERGEABLE_TEXT[c.mergeable]}</span>
        {age && <span title={age}>{c.openedAt ? 'opened' : 'done'} {ago(age, now)}</span>}
        {c.waits && <span data-slot="pr-waits" className={c.waits === 'ready' ? 'text-ok' : ''}>{waitsText(c)}</span>}
      </div>
      {doingText(c, now) && <div data-slot="pr-doing" className={c.gaveUp ? 'text-xs text-bad' : 'text-xs text-muted-foreground'}>{doingText(c, now)}</div>}
      {c.mergeError && <div data-slot="pr-merge-error" className="text-xs text-bad">merge refused: {c.mergeError}</div>}
      <JobAct jobId={c.jobId} />
      <CardActions c={c} onChanged={onChanged} />
      <TendAgain c={c} onChanged={onChanged} />
      {c.pullRequest && <PullRequestDiff repo={c.repo} number={c.pullRequest.number} />}
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

/** A checks read problem (issue #1244): said once for the repository, with the fix, not on each card alone. */
function ChecksUnread({ p }: { p: ChecksProblem }) {
  return (
    <div role="alert" data-slot="repo-checks-unread" className="flex gap-2 border-b border-red-500/40 bg-red-500/10 px-4 py-2 text-xs">
      <TriangleAlert className="size-4 shrink-0 text-bad" />
      <p>{checksProblemText(p)}</p>
    </div>
  );
}

function RepoGroup({ group, checks, unread, onChanged }: { group: PullRequestsView['repos'][number]; checks?: RepoChecks; unread?: ChecksProblem; onChanged: () => void }) {
  const [mode] = useMode();
  const [open, toggle] = useGroupOpen(`pull-requests.group.${group.repo}`);
  const page = usePaged(group.pullRequests, mode === 'rows' ? ROWS_PER_PAGE : CARDS_PER_PAGE, mode);
  return (
    <section data-repo={group.repo}>
      <Panel title={group.repo} icon={GitPullRequest} count={group.pullRequests.length || ''} bodyClassName="p-0" open={open} onToggle={toggle}
        action={<>
          {checks?.state === 'no checks' && <StatusBadge status="no-checks" label="no checks" tone="warn" />}
          <YoloBadge on={group.yolo} />
        </>}>
        <p data-slot="yolo-note" className="border-b px-4 py-2 text-xs text-muted-foreground">
          {yoloNote(group.yolo)} <a data-slot="yolo-settings" href="#settings/yolo-mode" className="underline">Change it in Settings → Yolo mode</a>
        </p>
        {unread && <ChecksUnread p={unread} />}
        {checks?.state === 'no checks' && <NoChecks r={checks} onChanged={onChanged} />}
        {group.pullRequests.length
          ? <ul className="divide-y">{page.shown.map((c) => (mode === 'rows' ? <Row key={c.jobId} c={c} /> : <Card key={c.jobId} c={c} onChanged={onChanged} />))}</ul>
          : <Empty>no pull request waits</Empty>}
        <Pager p={page} onPage={page.setPage} className="border-t px-4 py-2" />
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
  const [mode, setMode] = useMode();
  const reload = () => { load().catch(() => {}); };
  if (!view) return <Panel title="Pull requests" icon={GitPullRequest}><Empty>loading</Empty></Panel>;
  return (
    <div className="space-y-3">
      <Panel title="Pull requests" icon={GitPullRequest} sticky action={<ModeToggle slot="pr-mode" value={mode} choices={MODES} onPick={setMode} />}>
        <div className="space-y-1 text-sm">
          <p data-slot="pr-yolo-line">{yoloLine(view)}</p>
          <p data-slot="pr-waiting-line" className="text-muted-foreground">{waitingLine(view)}</p>
          {conflictsLine(conflictedPullRequests(view)) && <p data-slot="pr-conflicts-line" className="font-medium text-bad">{conflictsLine(conflictedPullRequests(view))}</p>}
          {noChecksLine(checks) && <p data-slot="pr-no-checks-line" className="text-warn">{noChecksLine(checks)}</p>}
          {!hasCards(view) && <p data-slot="pr-empty" className="text-muted-foreground">No pull request waits.</p>}
        </div>
      </Panel>
      {view.landing && view.landing.length > 0 && <Landing cards={view.landing} />}
      {view.untracked && view.untracked.length > 0 && <Untracked prs={view.untracked} reload={reload} />}
      {view.repos.map((g) => <RepoGroup key={g.repo} group={g} checks={checks.repos.find((c) => c.repo.toLowerCase() === g.repo.toLowerCase())}
        unread={view.checksProblems?.find((p) => p.repo.toLowerCase() === g.repo.toLowerCase())} onChanged={reload} />)}
    </div>
  );
}
