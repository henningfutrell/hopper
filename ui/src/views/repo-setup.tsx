// Repository setup in Sources (issue #652, design.md "Repository setup"): each job repository's setup as the hopper reads
// it from GitHub (`GET /api/repo-checks`, read in the background, again every minute here), with a warning and each
// problem for a repository not set up, and what GitHub did not show. Nothing to show with no job repository, or when
// the checks cannot be read.
import { ShieldAlert } from 'lucide-react';
import { useCallback, useState } from 'react';
import { StatusBadge, type Tone } from '@/components/status';
import { usePoll } from '@/hooks/use-poll';
import { get } from '@/lib/api';
import { SETUP_ASKS, UNREAD_WHY, setupLine } from '@/model/repo-setup';
import type { RepoChecks, RepoChecksView } from '@/model/wire';
import { Panel } from '@/components/panel';

const POLL_MS = 60_000;
const TONE: Record<RepoChecks['setup']['state'], Tone> = { 'set up': 'ok', 'not set up': 'warn', unknown: 'muted' };

function Repo({ r }: { r: RepoChecks }) {
  const s = r.setup;
  return (
    <li data-repo-setup-repo={r.repo} data-repo-setup={s.state} className="space-y-1 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono">{r.repo}</span>
        <StatusBadge status={s.state} tone={TONE[s.state]} />
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
  if (repos.length === 0) return null;
  const warn = repos.some((r) => r.setup.state === 'not set up');
  return (
    <section className="space-y-2" aria-labelledby="sources-repo-setup">
      <div>
        <h2 id="sources-repo-setup" className="text-sm font-semibold">Repository setup</h2>
        <p data-repo-setup-line className={`text-xs ${warn ? 'text-warn' : 'text-muted-foreground'}`}>{setupLine(repos)}</p>
      </div>
      <Panel title="Job repositories" icon={ShieldAlert} bodyClassName="space-y-1">
        <p className="text-xs text-muted-foreground">{SETUP_ASKS}</p>
        <ul className="divide-y">{repos.map((r) => <Repo key={r.repo} r={r} />)}</ul>
      </Panel>
    </section>
  );
}
