// The shared rate limiter (issue #436), in Settings, the hopper's admin's: below which share of a GitHub rate limit calls
// slow down, how many calls are kept in reserve, and how many GitHub watches poll at once; and what the limiter sees now —
// each rate-limit bucket, the conditional requests' cache hits and the waits. Saved to the daemon and applied at once,
// without a restart.
import { Gauge } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { bucketLine, cacheLine, rateLimiterPatch, rateLimiterSummary, type RateLimiterDraft } from '@/model/github-rate-limiter';
import type { RateLimiterView } from '@/model/wire';
import { useHopper } from '@/store';

const draftOf = (v: RateLimiterView): RateLimiterDraft => ({
  slowBelowPercent: String(v.settings.slowBelowPercent), reserve: String(v.settings.reserve), batchSize: String(v.settings.batchSize),
  intakeReserve: String(v.settings.intakeReserve),
});

function Form({ view, now, onSaved }: { view: RateLimiterView; now: number; onSaved: (v: RateLimiterView) => void }) {
  const [draft, setDraft] = useState<RateLimiterDraft>(draftOf(view));
  const [busy, setBusy] = useState(false);
  const checked = rateLimiterPatch(view.settings, draft);
  const save = async () => {
    if (!checked.ok || !checked.patch) return;
    setBusy(true);
    try {
      onSaved(await post<RateLimiterView>('/ui/api/github-rate-limiter', checked.patch));
      toast.success('GitHub rate limit saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only the hopper\'s admin changes the GitHub rate limit' : (e as Error).message);
    }
    setBusy(false);
  };
  const field = (key: keyof RateLimiterDraft, label: string, unit: string) => (
    <label className="flex flex-wrap items-center gap-2">
      <span className="min-w-56">{label}</span>
      <Input className="h-8 w-24" inputMode="numeric" aria-label={label} disabled={busy} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      <span className="text-xs text-muted-foreground">{unit}</span>
    </label>
  );
  return (
    <div data-slot="github-rate-limiter" className="space-y-3 text-sm">
      <p data-slot="github-rate-limiter-summary" className="font-medium">{rateLimiterSummary(view.settings)}</p>
      <p className="text-xs text-muted-foreground">
        One limiter for every GitHub call and every GitHub watch. It reads GitHub&apos;s rate-limit headers. Below the share you set, it spreads the calls
        that are left evenly until the limit resets. At the reserve, calls wait for the reset. GitHub watches ask with the last answer&apos;s ETag: an answer
        that did not change costs no call. GitHub watches poll in batches, spread across their interval. Intake — the reads that look for new
        jobs — stops when only the calls kept for job work are left, so a job can still report its end and a rerun can still start.
      </p>
      {field('slowBelowPercent', 'Slow down below', '% of a rate limit')}
      {field('reserve', 'Reserve', 'calls')}
      {field('batchSize', 'Batch size', 'GitHub watches at a time')}
      {field('intakeReserve', 'Kept for job work', 'calls: intake stops at this many left')}
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <Button size="sm" disabled={busy || !checked.ok || !checked.patch} onClick={() => void save()}>Save</Button>
      <div className="space-y-1 border-t pt-3">
        <h3 className="text-xs font-medium uppercase text-muted-foreground">Now</h3>
        {view.buckets.length === 0
          ? <p className="text-xs text-muted-foreground">No GitHub call yet.</p>
          : <ul data-slot="github-rate-limiter-buckets" className="space-y-0.5">{view.buckets.map((b, i) => <li key={i}>{bucketLine(b, now)}</li>)}</ul>}
        <p data-slot="github-rate-limiter-cache">{cacheLine(view.cache)}</p>
        <p className="text-xs text-muted-foreground">{view.waits.count === 0 ? 'No call had to wait.' : `${view.waits.count} calls waited, ${Math.round(view.waits.totalMs / 1000)} s in all.`}</p>
      </div>
    </div>
  );
}

/** Read when shown; keyed by the saved settings, so a save starts the form from them. */
export function GitHubRateLimiter() {
  const [view, setView] = useState<RateLimiterView | null>(null);
  // When the view was read: a bucket's reset is shown from then.
  const [now, setNow] = useState(0);
  const shown = (v: RateLimiterView) => { setView(v); setNow(Date.now()); };
  // An answer without its settings is refused, never read as the defaults.
  useEffect(() => { get<RateLimiterView>('/api/github-rate-limiter').then((v) => { if (typeof v?.settings?.reserve === 'number' && Array.isArray(v.buckets)) shown(v); }, () => {}); }, []);
  return (
    <Panel title="GitHub rate limit" icon={Gauge} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view.settings)} view={view} now={now} onSaved={shown} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
