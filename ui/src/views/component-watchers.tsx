// Component watchers (issue #1077), in Settings, an admin's: whether a drift files a drift issue on the hopper's own
// repository, and each watcher with its last check and the drift it found now, each item by its key. Saved to the daemon
// and read at the next check, without a restart.
import { Info, Radar } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { COMPONENT_WATCHERS_NOTE, componentWatchersSummary, driftItemLine, driftLine, watcherLine } from '@/model/component-watchers';
import type { ComponentWatchersView } from '@/model/wire';
import { useHopper } from '@/store';

/** Read when shown; an answer without its settings is refused, never read as off. */
export function ComponentWatchers() {
  const [view, setView] = useState<ComponentWatchersView | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get<ComponentWatchersView>('/api/component-watchers').then((v) => { if (typeof v?.settings?.fileIssues === 'boolean' && Array.isArray(v.watchers)) setView(v); }, () => {}); }, []);
  const save = async (fileIssues: boolean) => {
    setBusy(true);
    try {
      setView(await post<ComponentWatchersView>('/ui/api/component-watchers', { fileIssues }));
      toast.success(fileIssues ? 'Drift issues on' : 'Drift issues off');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the component watchers' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Panel title="Component watchers" icon={Radar} className="max-w-3xl">
      {view ? (
        <div data-slot="component-watchers" className="space-y-3 text-sm">
          <p role="note" className="flex gap-2 rounded-md border p-3 text-xs text-muted-foreground"><Info className="size-4 shrink-0" />{COMPONENT_WATCHERS_NOTE}</p>
          <p data-slot="component-watchers-summary" className="font-medium">{componentWatchersSummary(view.settings)}</p>
          <label className="flex items-center gap-2">
            <Switch checked={view.settings.fileIssues} disabled={busy} aria-label="Drift issues" onCheckedChange={(on) => void save(on)} />
            File an issue for each kind of drift
          </label>
          <ul data-slot="component-watchers-list" className="space-y-2 border-t pt-3">
            {view.watchers.map((w) => (
              <li key={w.name} data-watcher={w.name} className="space-y-1">
                <p className="break-words">{watcherLine(w)}</p>
                {w.issueError && <p role="alert" className="text-xs text-destructive">Its drift issue could not be written: {w.issueError}</p>}
                {w.drifts.map((d) => (
                  <details key={d.kind} data-drift={d.kind} className="ml-4 text-xs">
                    <summary className="cursor-pointer">{driftLine(d)} {d.issue && <a className="underline" href={d.issue.url} target="_blank" rel="noreferrer">Open the issue</a>}</summary>
                    <ul className="mt-1 space-y-0.5">{d.list.map((i) => <li key={i.key} className="break-words">{driftItemLine(w, i)}</li>)}</ul>
                  </details>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
