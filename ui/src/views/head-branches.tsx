// Head branch deletion (issue #2914), in Settings, an admin's: per job repository, whether the hopper deletes a pull request's
// branch after its merge and sweeps old ones. On by default. Saved to the daemon and read at each deletion, without a restart.
import { GitBranch, Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { HEAD_BRANCHES_NOTE, headBranchesOn } from '@/model/head-branches';
import type { HeadBranchView } from '@/model/wire';
import { useHopper } from '@/store';

/** Read when shown; an answer without `repos` is refused, never read as on. */
export function HeadBranches() {
  const [view, setView] = useState<HeadBranchView | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get<HeadBranchView>('/api/head-branches').then((v) => { if (v?.repos && v.choices?.repos) setView(v); }, () => {}); }, []);
  const save = async (repo: string, on: boolean) => {
    setBusy(true);
    try {
      setView(await post<HeadBranchView>('/ui/api/head-branches', { repos: { [repo]: on } }));
      toast.success(`Head branch deletion ${on ? 'on' : 'off'} for ${repo}`);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes head branch deletion' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Panel title="Head branches" icon={GitBranch} className="max-w-3xl">
      {view ? (
        <div data-slot="head-branches" className="space-y-3 text-sm">
          <p role="note" className="flex gap-2 rounded-md border p-3 text-xs text-muted-foreground"><Info className="size-4 shrink-0" />{HEAD_BRANCHES_NOTE}</p>
          {view.choices.repos.length === 0 ? <p className="text-muted-foreground">No job repositories yet.</p> : null}
          {view.choices.repos.map((repo) => (
            <label key={repo} className="flex items-center gap-2">
              <Switch checked={headBranchesOn(view, repo)} disabled={busy} aria-label={`Delete head branches after merge in ${repo}`} onCheckedChange={(on) => void save(repo, on)} />
              Delete head branches after merge in {repo}
            </label>
          ))}
        </div>
      ) : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
