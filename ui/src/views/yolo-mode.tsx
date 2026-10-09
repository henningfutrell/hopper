// Yolo mode (issue #579), in Settings, an admin's: whether jobs merge their own pull requests once the repo's checks
// pass — off unless turned on, for every job repository or per repository. The warning says what it allows; the
// summary says what is on now. Saved to the daemon, read for each job's prompt from then on, without a restart.
import { TriangleAlert, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import type { YoloModeView } from '@/model/wire';
import { YOLO_WARNING, yoloPatch, yoloRows, yoloSummary, type YoloDraft, type YoloSetting } from '@/model/yolo-mode';
import { useHopper } from '@/store';

const SETTING_LABEL: Record<YoloSetting, (on: boolean) => string> = {
  default: (on) => `As above (${on ? 'merges' : 'does not merge'})`,
  on: () => 'Merges',
  off: () => 'Does not merge',
};

function Form({ view, onSaved }: { view: YoloModeView; onSaved: (v: YoloModeView) => void }) {
  const rows = yoloRows(view);
  const [draft, setDraft] = useState<YoloDraft>({ on: view.on, repos: Object.fromEntries(rows.map((r) => [r.repo, r.setting])) });
  const [busy, setBusy] = useState(false);
  const patch = yoloPatch(view, draft);
  const save = async () => {
    if (!patch) return;
    setBusy(true);
    try {
      onSaved(await post<YoloModeView>('/ui/api/yolo-mode', patch));
      toast.success('Yolo mode saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes yolo mode' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="yolo-mode" className="space-y-3 text-sm">
      <p role="note" data-slot="yolo-warning" className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
        <TriangleAlert className="size-4 shrink-0 text-amber-600" />{YOLO_WARNING}
      </p>
      <p data-slot="yolo-summary" className="font-medium">{yoloSummary(view)}</p>
      <label className="flex items-center gap-2">
        <Switch checked={draft.on} disabled={busy} aria-label="Yolo mode for every job repository" onCheckedChange={(on) => setDraft({ ...draft, on })} />
        Jobs merge their own pull requests in every job repository
      </label>
      {rows.length > 0 && (
        <fieldset className="grid gap-1">
          <legend className="text-xs text-muted-foreground">Per repository</legend>
          {rows.map((r) => (
            <label key={r.repo} className="flex flex-wrap items-center gap-2">
              <span className="min-w-48 font-mono text-xs">{r.repo}</span>
              <select className="h-8 rounded-md border bg-background px-2 text-xs" aria-label={`Yolo mode for ${r.repo}`} disabled={busy}
                value={draft.repos[r.repo] ?? 'default'} onChange={(e) => setDraft({ ...draft, repos: { ...draft.repos, [r.repo]: e.target.value as YoloSetting } })}>
                {(['default', 'on', 'off'] as const).map((s) => <option key={s} value={s}>{SETTING_LABEL[s](draft.on)}</option>)}
              </select>
            </label>
          ))}
        </fieldset>
      )}
      <Button size="sm" disabled={busy || !patch} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; keyed by the saved values, so a save starts the form from them. */
export function YoloMode() {
  const [view, setView] = useState<YoloModeView | null>(null);
  // An answer without its settings is refused, never read as off.
  useEffect(() => { get<YoloModeView>('/api/yolo-mode').then((v) => { if (typeof v?.on === 'boolean' && Array.isArray(v.choices?.repos)) setView(v); }, () => {}); }, []);
  return (
    <Panel title="Yolo mode" icon={Zap} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
