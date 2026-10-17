// Settings → Intake, intake strictness (issue #655 part 3, brake 1), an admin's: the trust a job's item needs before the
// job runs — by default, and for a job source or a repository. Standard by default. A change applies at the next
// Decision: a waiting job it no longer lets through is held, and says why.
import { Gauge, Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { formatOverrides, parseOverrides, STRICTNESS, STRICTNESS_TEXT } from '@/model/intake-strictness';
import type { IntakeStrictness as Settings, Strictness } from '@/model/wire';
import { useHopper } from '@/store';

/** Read when shown; an answer without `default` is refused, never read as standard. */
export function IntakeStrictness() {
  const [view, setView] = useState<Settings | null>(null);
  const [lines, setLines] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<Settings>('/api/intake-strictness').then((v) => { if (v?.default) { setView(v); setLines(formatOverrides(v)); } }, () => {});
  }, []);
  const save = async (next: Settings) => {
    setBusy(true);
    try {
      const v = await post<Settings>('/ui/api/intake-strictness', next);
      setView(v); setLines(formatOverrides(v));
      toast.success('Intake strictness saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the intake strictness' : (e as Error).message);
    }
    setBusy(false);
  };
  const parsed = parseOverrides(lines);
  return (
    <Panel title="Intake: strictness" icon={Gauge} className="max-w-3xl">
      {view ? (
        <div data-slot="intake-strictness" className="space-y-3 text-sm">
          <p role="note" className="flex gap-2 rounded-md border p-3 text-xs text-muted-foreground"><Info className="size-4 shrink-0" />
            The trust a job&apos;s item needs before the job runs. A repository line wins over a source line, and a source line over the default.
            A waiting job that no longer passes is held, and says why. A running job keeps going.</p>
          <fieldset className="space-y-1">
            <legend className="font-medium">Default</legend>
            {STRICTNESS.map((s: Strictness) => (
              <label key={s} className="flex items-start gap-2">
                <input type="radio" name="intake-strictness-default" value={s} checked={view.default === s} disabled={busy} className="mt-1"
                  onChange={() => void save({ ...view, default: s })} />
                <span className="text-muted-foreground">{STRICTNESS_TEXT[s]}</span>
              </label>
            ))}
          </fieldset>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">For a job source or a repository, one per line: its name or owner/name, then open, standard, strict or closed</span>
            <Textarea aria-label="Strictness by source or repository" rows={4} value={lines} disabled={busy} placeholder="octo/tools strict"
              onChange={(e) => setLines(e.target.value)} />
          </label>
          {!parsed.ok && <p role="alert" className="text-xs text-destructive">{parsed.error}</p>}
          <Button size="sm" disabled={busy || !parsed.ok || lines.trim() === formatOverrides(view)}
            onClick={() => { if (parsed.ok) void save({ default: view.default, sources: parsed.sources, repos: parsed.repos }); }}>Save lines</Button>
        </div>
      ) : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
