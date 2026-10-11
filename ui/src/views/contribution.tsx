// Contribution (issue #429), in Settings, an admin's: whether a job of a repository its user cannot push to works
// through a fork. The note says what goes out under the user's account; the summary says what is on now. Saved to the
// daemon and read at each request a job makes, without a restart.
import { GitFork, Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { CONTRIBUTION_NOTE, contributionSummary } from '@/model/contribution';
import type { ContributionSettings } from '@/model/wire';
import { useHopper } from '@/store';

/** Read when shown; an answer without `on` is refused, never read as off. */
export function Contribution() {
  const [view, setView] = useState<ContributionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get<ContributionSettings>('/api/contribution').then((v) => { if (typeof v?.on === 'boolean') setView(v); }, () => {}); }, []);
  const save = async (on: boolean) => {
    setBusy(true);
    try {
      setView(await post<ContributionSettings>('/ui/api/contribution', { on }));
      toast.success(on ? 'Contribution on' : 'Contribution off');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes Contribution' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Panel title="Contribution" icon={GitFork} className="max-w-3xl">
      {view ? (
        <div data-slot="contribution" className="space-y-3 text-sm">
          <p role="note" className="flex gap-2 rounded-md border p-3 text-xs text-muted-foreground"><Info className="size-4 shrink-0" />{CONTRIBUTION_NOTE}</p>
          <p data-slot="contribution-summary" className="font-medium">{contributionSummary(view)}</p>
          <label className="flex items-center gap-2">
            <Switch checked={view.on} disabled={busy} aria-label="Contribution" onCheckedChange={(on) => void save(on)} />
            Jobs contribute through a fork to repositories your user cannot push to
          </label>
        </div>
      ) : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
