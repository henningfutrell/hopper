// Completion reviews (issue #2846), in Settings, an admin's: whether the hopper reviews ended jobs, which ends, whether a job
// of a work item with more than one job is reviewed whatever its end, and the run time below which a first run is trivial.
// Saved to the daemon and read by the review pass at each pass, without a restart.
import { ClipboardCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { completionReviewPatch, completionReviewSummary, OUTCOME_NAMES, OUTCOMES, type CompletionReviewDraft } from '@/model/completion-review';
import type { CompletionReviewSettings } from '@/model/wire';
import { useHopper } from '@/store';

function Form({ view, onSaved }: { view: CompletionReviewSettings; onSaved: (v: CompletionReviewSettings) => void }) {
  const [draft, setDraft] = useState<CompletionReviewDraft>({ on: view.on, outcomes: view.outcomes, multiJob: view.multiJob, minRunMinutes: String(view.minRunMinutes) });
  const [busy, setBusy] = useState(false);
  const checked = completionReviewPatch(view, draft);
  const save = async () => {
    if (!checked.ok || !checked.patch) return;
    setBusy(true);
    try {
      onSaved(await post<CompletionReviewSettings>('/ui/api/completion-review', checked.patch));
      toast.success('Completion reviews saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the completion reviews' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="completion-review-settings" className="space-y-3 text-sm">
      <p data-slot="completion-review-summary" className="font-medium">{completionReviewSummary(view)}</p>
      <p className="text-xs text-muted-foreground">
        When a job ends, the hopper reviews its run from what it kept: where its time went, what went well, where it stalled,
        its restarts and waste signals, and the changes that would have helped. The review shows on the job&apos;s page.
        It reads no text of the job&apos;s session and uses no model.
      </p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-56">Review ended jobs</span>
        <Switch checked={draft.on} disabled={busy} aria-label="Review ended jobs" onCheckedChange={(on) => setDraft({ ...draft, on })} />
      </label>
      {OUTCOMES.map((o) => (
        <label key={o} className="flex flex-wrap items-center gap-2">
          <span className="min-w-56">{OUTCOME_NAMES[o]} jobs</span>
          <Switch checked={draft.outcomes.includes(o)} disabled={busy} aria-label={`${OUTCOME_NAMES[o]} jobs`}
            onCheckedChange={(on) => setDraft({ ...draft, outcomes: on ? [...draft.outcomes, o] : draft.outcomes.filter((x) => x !== o) })} />
        </label>
      ))}
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-56">Every job of a work item with more than one job</span>
        <Switch checked={draft.multiJob} disabled={busy} aria-label="Every job of a work item with more than one job" onCheckedChange={(multiJob) => setDraft({ ...draft, multiJob })} />
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-56">Minimum run time</span>
        <Input className="h-8 w-24" inputMode="decimal" aria-label="Minimum run time" disabled={busy} value={draft.minRunMinutes} onChange={(e) => setDraft({ ...draft, minRunMinutes: e.target.value })} />
        <span className="text-xs text-muted-foreground">minutes: a shorter first run is skipped</span>
      </label>
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <Button size="sm" disabled={busy || !checked.ok || !checked.patch} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; keyed by the saved values, so a save starts the form from them. */
export function CompletionReviewSettingsView() {
  const [view, setView] = useState<CompletionReviewSettings | null>(null);
  // An answer without every part is refused, never read as off.
  useEffect(() => {
    get<CompletionReviewSettings>('/api/completion-review').then((v) => {
      if (typeof v?.on === 'boolean' && Array.isArray(v.outcomes) && typeof v.multiJob === 'boolean' && typeof v.minRunMinutes === 'number') setView(v);
    }, () => {});
  }, []);
  return (
    <Panel title="Completion reviews" icon={ClipboardCheck} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
