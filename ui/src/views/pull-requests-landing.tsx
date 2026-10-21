// The Pull requests view's two lists of rows (issues #1073, #1176, #2353): Landing — the job pull requests merged into the
// landing branch, each with its batch stage — and Not tracked — each open pull request of a job repository the hopper does
// not track, with why and, for an operator, Take into Intake. Each folds and pages; the fold is kept per browser.
import { ExternalLink, GitBranch, GitPullRequest, Inbox, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { GhLink } from '@/components/job';
import { Panel } from '@/components/panel';
import { Pager, usePaged } from '@/components/pager';
import { PullRequestDiff } from '@/components/pull-request-diff';
import { Button } from '@/components/ui/button';
import { useNow } from '@/hooks/use-now';
import { useGroupOpen } from '@/hooks/use-page-pref';
import { ago } from '@/model/format';
import { ROWS_PER_PAGE } from '@/model/page-prefs';
import { landingText, untrackedText } from '@/model/pull-requests';
import type { LandingCard, UntrackedPullRequest } from '@/model/wire';
import { actFor } from '@/store';
import { intakeRefusal } from '@/store/intake';
import { useCanOperate } from '@/store/selectors';

const LANDING_TONE: Record<LandingCard['stage'], string> = {
  waiting: 'text-muted-foreground', batch_run: 'text-warn', bisecting: 'text-warn', culprit: 'text-bad', reverted: 'text-bad', promoted: 'text-ok',
};

/** Landing (issue #1073): each job pull request merged into the landing branch, and where it stands on its way to the tested branch. */
export function Landing({ cards }: { cards: LandingCard[] }) {
  const now = useNow();
  const [open, toggle] = useGroupOpen('pull-requests.landing');
  const page = usePaged(cards, ROWS_PER_PAGE);
  return (
    <section data-slot="landing">
      <Panel title="Landing" icon={GitBranch} count={cards.length} bodyClassName="p-0" open={open} onToggle={toggle}>
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          Merged into the landing branch. A batch run of the full test suite moves them to the tested branch. <a href="#settings/landing-batches" className="underline">Settings → Landing batches</a>
        </p>
        <ul className="divide-y">
          {page.shown.map((c) => (
            <li key={`${c.repo}#${c.pullRequest.number}`} data-landing={c.jobId ?? c.issue} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
              <GhLink url={c.pullRequest.url} className="font-medium text-foreground">{c.repo}#{c.pullRequest.number}<ExternalLink className="size-3 opacity-60" /></GhLink>
              <span data-slot="landing-stage" className={`text-xs ${LANDING_TONE[c.stage]}`}>{landingText(c)}</span>
              {c.fixIssue && <GhLink url={c.fixIssue} className="text-xs">fix issue</GhLink>}
              <span className="text-xs text-muted-foreground" title={c.since}>{ago(c.since, now)}</span>
              <PullRequestDiff repo={c.repo} number={c.pullRequest.number} />
            </li>
          ))}
        </ul>
        <Pager p={page} onPage={page.setPage} className="border-t px-4 py-2" />
      </Panel>
    </section>
  );
}

const UNTRACKED_TONE: Record<UntrackedPullRequest['reason'], string> = {
  no_issue: 'text-muted-foreground', issue_not_in_intake: 'text-warn', wrong_base: 'text-warn', second_pull_request: 'text-warn', not_by_a_job: 'text-muted-foreground',
};

/**
 * Take into Intake on one row (issue #1194): the daemon answers before its GitHub write. From the click on, the row says
 * the write runs and offers Take into Intake no more, until a list read after the click says how it ended: a failure, with
 * why, offers it again; the issue in Intake offers it no more. A write the daemon says runs shows the same.
 */
function TakeIn({ u, reload }: { u: UntrackedPullRequest; reload: () => void }) {
  const [sent, setSent] = useState<UntrackedPullRequest>();
  const ended = sent !== undefined && u !== sent && (u.writeBehind?.state === 'failed' || u.offer !== 'take_in');
  if (ended) setSent(undefined);
  const running = (sent && !ended) || u.writeBehind?.state === 'running';
  const failed = !running && u.writeBehind?.state === 'failed' ? u.writeBehind : undefined;
  const takeIn = async () => {
    setSent(u);
    const key = u.issue!.url;
    const r = await actFor(`/ui/api/sources/${encodeURIComponent(u.source!)}/intake`, { kind: 'take_in', keys: [key] }, `#${u.issue!.number}: taking into Intake`, intakeRefusal([key]));
    if (!r.ok) setSent(undefined);
    reload();
  };
  if (running) return <span data-write-behind="running" className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" />taking into Intake on GitHub</span>;
  if (u.offer !== 'take_in' || !u.source || !u.issue) return null;
  return (
    <>
      {failed && <span data-write-behind="failed" className="text-xs text-destructive">taking into Intake on GitHub failed: {failed.error}</span>}
      <Button size="xs" variant="outline" title="Gives the issue the hopper label and assigns it to your GitHub account: Intake lists it as a request card for you to approve" onClick={() => void takeIn()}><Inbox />Take into Intake</Button>
    </>
  );
}

/**
 * Not tracked (issue #1176): each open pull request of a job repository that no job names and the ledger does not hold, with
 * why. One whose issue is not in Intake has Take into Intake for an operator: its source labels and assigns the issue.
 */
export function Untracked({ prs, reload }: { prs: UntrackedPullRequest[]; reload: () => void }) {
  const operator = useCanOperate();
  const [open, toggle] = useGroupOpen('pull-requests.untracked');
  const page = usePaged(prs, ROWS_PER_PAGE);
  return (
    <section data-slot="untracked">
      <Panel title="Not tracked" icon={GitPullRequest} count={prs.length} bodyClassName="p-0" open={open} onToggle={toggle}>
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          Open pull requests of your job repositories that the hopper does not rebase, land or close.
        </p>
        <ul className="divide-y">
          {page.shown.map((u) => (
            <li key={u.url} data-untracked={u.url} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
              <GhLink url={u.url} className="font-medium text-foreground">{u.repo}#{u.url.split('/').pop()}<ExternalLink className="size-3 opacity-60" /></GhLink>
              {u.title && <span className="text-muted-foreground">{u.title}</span>}
              <span data-slot="untracked-reason" className={`text-xs ${UNTRACKED_TONE[u.reason]}`}>{untrackedText(u)}</span>
              {operator && <TakeIn u={u} reload={reload} />}
            </li>
          ))}
        </ul>
        <Pager p={page} onPage={page.setPage} className="border-t px-4 py-2" />
      </Panel>
    </section>
  );
}
