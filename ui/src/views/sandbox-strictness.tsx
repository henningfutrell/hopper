// Vault, sandbox strictness (issue #655 part 8, brake 2), an admin's: which sandbox runs need a person — by
// default, for a blast radius level, or for a template. Standard by default. A change applies at once: a run approved
// with no person no longer counts where a person is now asked.
import { Gauge, Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { formatTemplates, parseTemplates, RADIUS, SANDBOX_STRICTNESS, SANDBOX_STRICTNESS_TEXT } from '@/model/sandbox-strictness';
import type { RadiusLevel, SandboxStrictness as Settings, SandboxStrictnessLevel } from '@/model/wire';
import { useHopper } from '@/store';

/** Read when shown; an answer without `default` is refused, never read as standard. */
export function SandboxStrictness() {
  const [view, setView] = useState<Settings | null>(null);
  const [lines, setLines] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<Settings>('/api/sandbox-strictness').then((v) => { if (v?.default) { setView(v); setLines(formatTemplates(v)); } }, () => {});
  }, []);
  const save = async (next: Settings) => {
    setBusy(true);
    try {
      const v = await post<Settings>('/ui/api/sandbox-strictness', next);
      setView(v); setLines(formatTemplates(v));
      toast.success('Sandbox strictness saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the sandbox strictness' : (e as Error).message);
    }
    setBusy(false);
  };
  const setRadius = (level: RadiusLevel, to: SandboxStrictnessLevel | '') => {
    if (!view) return;
    const radius = { ...view.radius };
    if (to === '') delete radius[level]; else radius[level] = to;
    void save({ ...view, radius });
  };
  const parsed = parseTemplates(lines);
  return (
    <Panel title="Sandbox strictness" icon={Gauge} className="max-w-3xl">
      {view ? (
        <div data-slot="sandbox-strictness" className="space-y-3 text-sm">
          <p role="note" className="flex gap-2 rounded-md border p-3 text-xs text-muted-foreground"><Info className="size-4 shrink-0" />
            Which sandbox runs, need steps and standing read grants need a person. A template line wins over its blast radius level, and that over the default.
            Tighter, a run approved with no person stops counting. A run a person approved still counts.</p>
          <fieldset className="space-y-1">
            <legend className="font-medium">Default</legend>
            {SANDBOX_STRICTNESS.map((s) => (
              <label key={s} className="flex items-start gap-2">
                <input type="radio" name="sandbox-strictness-default" value={s} checked={view.default === s} disabled={busy} className="mt-1"
                  onChange={() => void save({ ...view, default: s })} />
                <span className="text-muted-foreground">{SANDBOX_STRICTNESS_TEXT[s]}</span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-3">
            {RADIUS.map((level) => (
              <label key={level} className="flex items-center gap-2 text-xs">
                <span className="capitalize">{level} blast radius</span>
                <select aria-label={`Strictness for ${level} blast radius`} value={view.radius[level] ?? ''} disabled={busy}
                  className="rounded-md border bg-background px-2 py-1" onChange={(e) => setRadius(level, e.target.value as SandboxStrictnessLevel | '')}>
                  <option value="">as the default</option>
                  {SANDBOX_STRICTNESS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            ))}
          </div>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">For a template, one per line: its name, then relaxed, standard, strict or locked</span>
            <Textarea aria-label="Strictness by template" rows={4} value={lines} disabled={busy} placeholder="aws-prod locked"
              onChange={(e) => setLines(e.target.value)} />
          </label>
          {!parsed.ok && <p role="alert" className="text-xs text-destructive">{parsed.error}</p>}
          <Button size="sm" disabled={busy || !parsed.ok || lines.trim() === formatTemplates(view)}
            onClick={() => { if (parsed.ok) void save({ ...view, templates: parsed.templates }); }}>Save lines</Button>
        </div>
      ) : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
