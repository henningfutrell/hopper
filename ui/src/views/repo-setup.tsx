// Repository setup in Sources (issue #652, design.md "Repository setup"): each job repository's setup as the hopper last
// read it from GitHub, with when (`GET /api/repo-checks`, from the hopper's database: a load never reads GitHub, issue
// #1250), a warning and each problem for a repository not set up, and what GitHub did not show. Refresh asks the hopper to
// read GitHub again in the background (`POST /ui/api/repo-checks/refresh`); while a read is under way the list is read
// again every few seconds. Nothing to show with no job repository, or when the checks cannot be read.
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { StatusBadge, type Tone } from '@/components/status';
import { Button } from '@/components/ui/button';
import { usePoll } from '@/hooks/use-poll';
import { get, post } from '@/lib/api';
import { ago } from '@/model/format';
import { useServerNow } from '@/store/selectors';
import { SETUP_ASKS, UNREAD_WHY, setupLine } from '@/model/repo-setup';
import type { RepoChecks, RepoChecksView } from '@/model/wire';
import { FoldSection, Panel } from '@/components/panel';

const POLL_MS = 60_000;
/** While a read is under way: how soon the list is read again. */
const READING_MS = 2_000;
const TONE: Record<RepoChecks['setup']['state'], Tone> = { 'set up': 'ok', 'not set up': 'warn', unknown: 'muted' };

/** When the hopper read the repository from GitHub last. */
function ReadAt({ r, now }: { r: RepoChecks; now: number }) {
  const cls = 'text-muted-foreground';
  if (r.reading) return <span data-repo-setup-read className={cls}>reading GitHub…</span>;
  if (!r.checkedAt) return <span data-repo-setup-read className={cls}>not read yet</span>;
  return <time data-repo-setup-read dateTime={r.checkedAt} title={r.checkedAt} className={cls}>read {ago(r.checkedAt, now)}</time>;
}

function Repo({ r, now }: { r: RepoChecks; now: number }) {
  const s = r.setup;
  return (
    <li data-repo-setup-repo={r.repo} data-repo-setup={s.state} className="space-y-1 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono">{r.repo}</span>
        <StatusBadge status={s.state} tone={TONE[s.state]} />
        <ReadAt r={r} now={now} />
      </div>
      {s.problems.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-warn">{s.problems.map((p) => <li key={p} data-repo-setup-problem>{p}</li>)}</ul>
      )}
      {s.unread.length > 0 && <p className="text-xs text-muted-foreground">GitHub did not show: {s.unread.join(', ')}. {UNREAD_WHY}</p>}
      {r.error && <p className="text-xs text-muted-foreground">not read: {r.error}</p>}
    </li>
  );
}

export function RepoSetupSection() {
  const [repos, setRepos] = useState<RepoChecks[]>([]);
  const load = useCallback(async () => {
    // A failed read leaves the last answer; a daemon without the route shows nothing.
    const v = await get<RepoChecksView>('/api/repo-checks').catch(() => undefined);
    if (Array.isArray(v?.repos)) setRepos(v.repos.filter((r) => r.setup));
  }, []);
  usePoll(load, POLL_MS);
  const reading = repos.some((r) => r.reading);
  useEffect(() => {
    if (!reading) return;
    const t = setTimeout(() => void load(), READING_MS);
    return () => clearTimeout(t);
  }, [reading, repos, load]);
  const refresh = useCallback(async () => {
    const v = await post<RepoChecksView>('/ui/api/repo-checks/refresh').catch(() => undefined);
    if (Array.isArray(v?.repos)) setRepos(v.repos.filter((r) => r.setup));
  }, []);
  const now = useServerNow();
  if (repos.length === 0) return null;
  const warn = repos.some((r) => r.setup.state === 'not set up');
  return (
    <FoldSection id="sources-repo-setup" title="Repository setup" fold="sources.repo-setup"
      line={<p data-repo-setup-line className={`text-xs ${warn ? 'text-warn' : 'text-muted-foreground'}`}>{setupLine(repos)}</p>}>
      <Panel title="Job repositories" icon={ShieldAlert} bodyClassName="space-y-1"
        action={<Button data-repo-setup-refresh size="sm" variant="ghost" disabled={reading} onClick={() => void refresh()}><RefreshCw />Refresh</Button>}>
        <p className="text-xs text-muted-foreground">{SETUP_ASKS}</p>
        <ul className="divide-y">{repos.map((r) => <Repo key={r.repo} r={r} now={now} />)}</ul>
      </Panel>
    </FoldSection>
  );
}
