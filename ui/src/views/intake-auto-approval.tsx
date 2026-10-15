// Settings → Intake, auto-approval (issue #1268), an admin's: whether the hopper approves a request card itself when the
// user's own act already asks for it — a trusted actor reopened it, wrote it, or labelled it hopper:high, or a listed app
// wrote it —, and the apps and bots trusted to act for the user. On by default. A card a guard flags still waits.
import { Info, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import type { IntakeAutoApproval as Settings } from '@/model/wire';
import { useHopper } from '@/store';

export const AUTO_APPROVAL_NOTE = 'The hopper approves a request card itself when a trusted actor reopened it after its job was done, '
  + 'wrote it, or added hopper:high to it, or when a listed app or bot wrote it. A card a job filed, that someone else edited, '
  + 'or whose text changed since a person approved it, still waits for you.';

/** The apps as typed: one per line or comma, each lowercased, with no [bot]. */
export const parseApps = (text: string): string[] =>
  [...new Set(text.split(/[\s,]+/).map((a) => a.trim().toLowerCase().replace(/\[bot\]$/, '')).filter((a) => a !== ''))].sort();

/** Read when shown; an answer without `on` is refused, never read as off. */
export function IntakeAutoApproval() {
  const [view, setView] = useState<Settings | null>(null);
  const [apps, setApps] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<Settings>('/api/intake-auto-approval').then((v) => { if (typeof v?.on === 'boolean') { setView(v); setApps(v.apps.join(', ')); } }, () => {});
  }, []);
  const save = async (next: Settings) => {
    setBusy(true);
    try {
      const v = await post<Settings>('/ui/api/intake-auto-approval', next);
      setView(v); setApps(v.apps.join(', '));
      toast.success(v.on ? 'Auto-approval on' : 'Auto-approval off');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes auto-approval' : (e as Error).message);
    }
    setBusy(false);
  };
  const typed = parseApps(apps);
  return (
    <Panel title="Intake: auto-approval" icon={ShieldCheck} className="max-w-3xl">
      {view ? (
        <div data-slot="intake-auto-approval" className="space-y-3 text-sm">
          <p role="note" className="flex gap-2 rounded-md border p-3 text-xs text-muted-foreground"><Info className="size-4 shrink-0" />{AUTO_APPROVAL_NOTE}</p>
          <label className="flex items-center gap-2">
            <Switch checked={view.on} disabled={busy} aria-label="Auto-approval" onCheckedChange={(on) => void save({ on, apps: view.apps })} />
            The hopper approves request cards your own acts already ask for
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Apps and bots trusted to act for you (their slug, comma between them)</span>
            <Input aria-label="Trusted apps" value={apps} disabled={busy} placeholder="none" onChange={(e) => setApps(e.target.value)} />
          </label>
          <Button size="sm" disabled={busy || typed.join() === view.apps.join()} onClick={() => void save({ on: view.on, apps: typed })}>Save apps</Button>
        </div>
      ) : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
