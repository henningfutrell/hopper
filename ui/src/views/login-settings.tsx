// Below the Logins view's cards (issue #477): Earlier logins — the ended ones, a compact list; their codes are
// never kept — and, for an admin, the logins settings: what a job does when its login expires, and how long before
// a code runs out the view warns. Keyed by the saved values, so a save starts the form from them again.
import { History, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Panel } from '@/components/panel';
import { RaisedOn } from '@/components/raised-by';
import { StatusBadge, toneOf } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FIELD } from '@/components/plugin-form';
import { clock } from '@/model/format';
import type { LoginSettings, LoginView } from '@/model/wire';
import { saveLoginSettings, useHopper } from '@/store';

const TONE: Record<string, 'ok' | 'bad' | 'muted'> = { completed: 'ok', expired: 'bad', failed: 'bad' };

export function LoginHistory({ logins }: { logins: LoginView[] }) {
  const machines = useHopper((s) => s.machines);
  return (
    <Panel title="Earlier logins" icon={History} count={logins.length} list>
      <ul data-slot="login-history" className="divide-y text-sm">
        {logins.map((l) => {
          const name = machines.find((m) => m.id === l.machineId)?.label;
          return (
            <li key={l.id} data-earlier-login={l.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
              <span className="font-mono">{l.tool}</span>
              <RaisedOn raisedBy={l.machineId ? { machineId: l.machineId, ...(name ? { name } : {}) } : undefined} className="text-xs text-muted-foreground" />
              <StatusBadge status={l.status} tone={TONE[l.status] ?? toneOf(l.status)} />
              {l.reason && <span className="min-w-0 truncate text-xs text-muted-foreground" title={l.reason}>{l.reason}</span>}
              <span className="num ml-auto text-xs text-muted-foreground">{clock(l.endedAt ?? l.expiresAt)}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function SettingsForm({ settings }: { settings: LoginSettings }) {
  const [onExpiry, setOnExpiry] = useState(settings.onExpiry);
  const [warnSec, setWarnSec] = useState(String(settings.warnSec));
  const [busy, setBusy] = useState(false);
  const changed = onExpiry !== settings.onExpiry || Number(warnSec) !== settings.warnSec;
  const save = async () => {
    setBusy(true);
    await saveLoginSettings({ onExpiry, warnSec: Number(warnSec) });
    setBusy(false);
  };
  return (
    <div data-section="login-settings" className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        A card warns {settings.warnSec} seconds before its code runs out, or at a fifth of the code's life when that is longer. When a code expires, the job {settings.onExpiry === 'fail' ? 'fails' : 'waits for a new code until its own timeout'}.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">When a code expires</span>
          <select className={`${FIELD} h-8 w-56 text-sm`} aria-label="When a code expires" value={onExpiry} disabled={busy} onChange={(e) => setOnExpiry(e.target.value as LoginSettings['onExpiry'])}>
            <option value="fail">the job fails</option>
            <option value="hold">the job waits for a new code</option>
          </select></label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Warn before (seconds)</span>
          <Input type="number" min="10" max="3600" step="1" className="h-8 w-28" aria-label="Warn this many seconds before a code expires" value={warnSec} disabled={busy} onChange={(e) => setWarnSec(e.target.value)} /></label>
        <Button size="sm" disabled={busy || !changed} onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}

export function LoginSettingsPanel({ settings }: { settings: LoginSettings }) {
  return (
    <Panel title="Logins settings" icon={Settings2}>
      <SettingsForm key={`${settings.onExpiry}:${settings.warnSec}`} settings={settings} />
    </Panel>
  );
}
