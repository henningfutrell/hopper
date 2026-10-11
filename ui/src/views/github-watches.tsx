// GitHub watches (issue #427), in Settings, an admin's: how often each watch of a pointed job polls its item on GitHub,
// and each watch with what its last poll saw. Saved to the daemon and applied at once, without a restart.
import { Eye } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { intervalPatch, intervalWords, watchLine } from '@/model/github-watches';
import type { GitHubWatchView } from '@/model/wire';
import { useHopper } from '@/store';

function Form({ view, onSaved }: { view: GitHubWatchView; onSaved: (v: GitHubWatchView) => void }) {
  const [draft, setDraft] = useState(String(view.settings.intervalSeconds));
  const [busy, setBusy] = useState(false);
  const checked = intervalPatch(view.settings.intervalSeconds, draft);
  const save = async () => {
    if (!checked.ok || !checked.patch) return;
    setBusy(true);
    try {
      onSaved(await post<GitHubWatchView>('/ui/api/github-watches', checked.patch));
      toast.success('GitHub watch interval saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the GitHub watch interval' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="github-watches" className="space-y-3 text-sm">
      <p data-slot="github-watches-summary" className="font-medium">Each GitHub watch polls every {intervalWords(view.settings.intervalSeconds)}.</p>
      <p className="text-xs text-muted-foreground">
        Each pointed job that has not ended has a watch on its issue or pull request. A watch reads its state, labels, comments, reviews and linked pull
        requests, and records an event only when one of them changed. A new interval applies at once: the watches poll now, then on the new interval.
      </p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-32">Interval</span>
        <Input className="h-8 w-24" inputMode="numeric" aria-label="Interval" disabled={busy} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <span className="text-xs text-muted-foreground">seconds</span>
      </label>
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <Button size="sm" disabled={busy || !checked.ok || !checked.patch} onClick={() => void save()}>Save</Button>
      <div className="space-y-1 border-t pt-3">
        <h3 className="text-xs font-medium uppercase text-muted-foreground">Watches</h3>
        {view.watches.length === 0
          ? <p className="text-xs text-muted-foreground">No pointed job is watched.</p>
          : <ul data-slot="github-watches-list" className="space-y-0.5">{view.watches.map((w) => <li key={w.pointedJob} className="break-words">{watchLine(w)}</li>)}</ul>}
      </div>
    </div>
  );
}

/** Read when shown; keyed by the saved interval, so a save starts the form from it. */
export function GitHubWatches() {
  const [view, setView] = useState<GitHubWatchView | null>(null);
  // An answer without its settings is refused, never read as the defaults.
  useEffect(() => { get<GitHubWatchView>('/api/github-watches').then((v) => { if (typeof v?.settings?.intervalSeconds === 'number' && Array.isArray(v.watches)) setView(v); }, () => {}); }, []);
  return (
    <Panel title="GitHub watches" icon={Eye} className="max-w-3xl">
      {view ? <Form key={view.settings.intervalSeconds} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
