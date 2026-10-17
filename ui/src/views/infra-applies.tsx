// Infra → Infra applies (issue #1722, design.md "Infra applies off: changes through CI only"): whether this hopper applies
// infrastructure changes. On by default. Off, the vault mints read credentials only and no step applies: a change goes
// through CI. Every person sees it (GET /api/infra-applies); only the hopper's admin turns it on or off (POST /ui/api/infra-applies).
import { ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Switch } from '@/components/ui/switch';
import { get, post, SessionRejected } from '@/lib/api';
import { useHopper } from '@/store';
import { useCanAdminInstance } from '@/store/selectors';

export function InfraApplies() {
  const admin = useCanAdminInstance();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void get<{ on: boolean }>('/api/infra-applies').then((v) => setOn(v.on), (e: unknown) => toast.error((e as Error).message)); }, []);
  const save = async (next: boolean) => {
    setBusy(true);
    try {
      setOn((await post<{ on: boolean }>('/ui/api/infra-applies', { on: next })).on);
      toast.success(next ? 'Infra applies are on' : 'Infra applies are off: changes go through CI');
    } catch (err) {
      if (err instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((err as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <Panel title="Infra applies" icon={ShieldOff}>
      <div data-section="infra-applies" className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          When it is off, the hopper only reads infrastructure. The vault mints read credentials only, and no step applies a plan. An infrastructure change goes through CI: the job pushes it to the infrastructure repository, and its pipeline applies it after its environment approval. Jobs can still record plans for a person to read.
        </p>
        {on === null ? <p className="text-muted-foreground">Loading…</p> : (
          <label className="flex items-center gap-2">
            <Switch checked={on} disabled={busy || !admin} aria-label="Infra applies" onCheckedChange={(next) => void save(next)} />
            {on ? 'The hopper applies approved plans' : 'Off: changes go through CI only'}
            {!admin && <span className="text-xs text-muted-foreground">(the hopper's admin changes it)</span>}
          </label>
        )}
      </div>
    </Panel>
  );
}
