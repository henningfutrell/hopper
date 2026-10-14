// The TL;DR (issue #569), in Settings, an admin's: whether a cheap model (Claude Haiku) writes one or two plain
// sentences on top of every long question, research report and hand-off, and notifications lead with them. A proposal
// leads with its own TL;DR part (issue #651).
// Saved to the daemon at once and read on every sweep and read, without a restart.
import { TextQuote } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import type { TldrSettings as TldrSettingsView } from '@/model/wire';
import { useHopper } from '@/store';

function Form({ view, onSaved }: { view: TldrSettingsView; onSaved: (v: TldrSettingsView) => void }) {
  const [busy, setBusy] = useState(false);
  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      onSaved(await post<TldrSettingsView>('/ui/api/tldr', { enabled }));
      toast.success(enabled ? 'TL;DR on' : 'TL;DR off');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the TL;DR' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="tldr-settings" className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        A cheap model (Claude Haiku) writes one or two plain sentences for every long question, research report and
        hand-off: what is asked and what you decide. A proposal starts with its own TL;DR, written by the agent. The card shows them first, and the agent's text behind Show all.
        Notifications lead with them. Without the model, a card shows the agent's own summary.
      </p>
      <label className="flex items-center gap-2">
        <Switch checked={view.enabled} disabled={busy} aria-label="Write a TL;DR for long cards" onCheckedChange={(on) => void save(on)} />
        Write a TL;DR for long cards
      </label>
    </div>
  );
}

/** Read when shown. */
export function TldrSettings() {
  const [view, setView] = useState<TldrSettingsView | null>(null);
  // An answer without the setting is refused, never read as off.
  useEffect(() => { get<TldrSettingsView>('/api/tldr').then((v) => { if (typeof v?.enabled === 'boolean') setView(v); }, () => {}); }, []);
  return (
    <Panel title="TL;DR" icon={TextQuote} className="max-w-3xl">
      {view ? <Form view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
