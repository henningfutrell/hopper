// Yolo mode (issue #579), in Settings, an admin's: whether jobs merge their own pull requests once the repo's checks
// pass — off unless turned on, for every job repository or per repository. The warning says what it allows; the
// summary says what is on now. Saved to the daemon, read for each job's prompt from then on, without a restart. This is
// yolo mode's one switch (issue #897): the header and Pull requests show it and link here.
// Change kinds (issue #1076): below it, each kind's merge gate under the built-in rule, and the admin's own rules over it
// as JSON — per repository or for every one —, saved whole; empty is the built-in rule again.
// Direct push (issue #1806): below them, the repositories where a job may push straight to the target branch, one a line,
// with the warning that says what it allows.
import { JsonBlock } from '@/components/json-block';
import { TriangleAlert, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import type { ChangeKind, YoloModeView } from '@/model/wire';
import { DIRECT_PUSH_WARNING, YOLO_WARNING, changeKindsText, directPushPatch, directPushText, gateText, parseChangeKinds, yoloPatch, yoloRows, yoloSummary, type YoloDraft, type YoloSetting } from '@/model/yolo-mode';
import { useHopper } from '@/store';
import { setPolled } from '@/store/polled';

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
        Jobs and the hopper merge ready pull requests in every job repository
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

const KIND_LABEL: Record<ChangeKind, string> = { docs: 'Docs or comments only', tests: 'Tests only', low_risk: 'Low-risk files', code: 'Code', sensitive: 'Sensitive' };

/** The change-kind rules (issue #1076): each kind's gate under the built-in rule, and the admin's own rules as JSON. */
function ChangeKinds({ view, onSaved }: { view: YoloModeView; onSaved: (v: YoloModeView) => void }) {
  const [text, setText] = useState(changeKindsText(view));
  const [busy, setBusy] = useState(false);
  const parsed = parseChangeKinds(text);
  const builtIn = view.choices.changeRule;
  const save = async () => {
    if (!parsed.ok) return;
    setBusy(true);
    try {
      onSaved(await post<YoloModeView>('/ui/api/yolo-mode', { changeKinds: parsed.value }));
      toast.success('Change rules saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the change rules' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="change-kinds" className="space-y-2 border-t pt-3 text-sm">
      <p className="font-medium">Change kinds</p>
      <p className="text-xs text-muted-foreground">
        The hopper reads what each pull request changes and gives it a kind. The kind decides how its merge is gated. The most sensitive file decides the kind.
      </p>
      {builtIn && (
        <ul data-slot="change-gates" className="grid gap-0.5 text-xs">
          {(Object.keys(KIND_LABEL) as ChangeKind[]).map((k) => <li key={k}><span className="font-medium">{KIND_LABEL[k]}</span>: {gateText(builtIn.merge[k])}</li>)}
        </ul>
      )}
      <label className="grid gap-1 text-xs">
        Your rules over the built-in rule (JSON; empty: the built-in rule). A list you name replaces the built-in list.
        <Textarea aria-label="Change rules" rows={8} className="font-mono text-xs" disabled={busy} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'{ "default": { "lowRisk": ["ui/**"] },\n  "repos": { "owner/repo": { "sensitive": ["src/**"], "merge": { "sensitive": "person" } } } }'} />
      </label>
      {!parsed.ok && <p role="alert" className="text-xs text-bad">{parsed.error}</p>}
      {builtIn && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">The built-in rule</summary>
          <div data-slot="change-built-in" className="mt-1"><JsonBlock value={builtIn} label="The built-in rule" className="max-h-64" /></div>
        </details>
      )}
      <Button size="sm" disabled={busy || !parsed.ok || text === changeKindsText(view)} onClick={() => void save()}>Save change rules</Button>
    </div>
  );
}

/** Direct push (issue #1806): the repositories where a job may push straight to the target branch, one a line. */
function DirectPush({ view, onSaved }: { view: YoloModeView; onSaved: (v: YoloModeView) => void }) {
  const [text, setText] = useState(directPushText(view));
  const [busy, setBusy] = useState(false);
  const parsed = directPushPatch(view, text);
  const save = async () => {
    if (!parsed.ok || !parsed.value) return;
    setBusy(true);
    try {
      onSaved(await post<YoloModeView>('/ui/api/yolo-mode', parsed.value));
      toast.success('Direct push saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes direct push' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="direct-push" className="space-y-2 border-t pt-3 text-sm">
      <p className="font-medium">Direct push</p>
      <p role="note" data-slot="direct-push-warning" className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
        <TriangleAlert className="size-4 shrink-0 text-amber-600" />{DIRECT_PUSH_WARNING}
      </p>
      <label className="grid gap-1 text-xs">
        Repositories where a job may push straight to the target branch (owner/repo, one a line; empty: none)
        <Textarea aria-label="Direct push repositories" rows={3} className="font-mono text-xs" disabled={busy} value={text} onChange={(e) => setText(e.target.value)} placeholder="owner/repo" />
      </label>
      {!parsed.ok && <p role="alert" className="text-xs text-bad">{parsed.error}</p>}
      <Button size="sm" disabled={busy || !parsed.ok || !parsed.value} onClick={() => void save()}>Save direct push</Button>
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
      {view ? (
        <div className="space-y-4">
          <Form key={JSON.stringify(view)} view={view} onSaved={(v) => { setView(v); setPolled('/api/yolo-mode', v); }} />
          <ChangeKinds key={`kinds-${JSON.stringify(view.changeKinds ?? null)}`} view={view} onSaved={(v) => { setView(v); setPolled('/api/yolo-mode', v); }} />
          <DirectPush key={`push-${JSON.stringify(view.push ?? [])}`} view={view} onSaved={(v) => { setView(v); setPolled('/api/yolo-mode', v); }} />
        </div>
      ) : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
