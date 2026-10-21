// Users & access → Access, a minimum trust (issue #655, part 15): each operation profile with one, with Clear, and a form
// that sets one. No job whose trust stamp is below a profile's minimum gets that operation on its asset, whatever its
// template's approvals say. A box and a person are no job: the minimum does not gate them. The daemon checks it in
// OpenFGA; the UI only sets and shows it.
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Empty, Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { post } from '@/lib/api';
import { clock } from '@/model/format';
import type { AccessView, AssetKind, MinTrust, Operation } from '@/model/wire';

type Level = MinTrust['level'];

/** The levels a minimum may name, highest first (src/authz/trust.ts MIN_TRUST_LEVELS). */
export const MIN_LEVELS: Level[] = ['owner', 'trusted', 'approved', 'screened', 'untrusted'];

const profileText = (m: Pick<MinTrust, 'profile'>) => `${m.profile.operation} on ${m.profile.asset.kind} ${m.profile.asset.name}`;

export function MinTrustPanel({ view, operations, kinds, onChanged, fold }: {
  view: AccessView; operations: Operation[]; kinds: AssetKind[]; onChanged: (v: AccessView) => void; fold?: string;
}) {
  const [operation, setOperation] = useState<Operation>('write');
  const [kind, setKind] = useState<AssetKind>('cluster');
  const [asset, setAsset] = useState('');
  const [level, setLevel] = useState<Level>('trusted');
  const [busy, setBusy] = useState(false);
  const send = async (m: Pick<MinTrust, 'profile'> & { level: Level | null }) => {
    setBusy(true);
    try {
      onChanged(await post<AccessView>('/ui/api/access', { action: 'min-trust', operation: m.profile.operation, asset: m.profile.asset, level: m.level }));
      toast.success(m.level ? `Minimum trust set: ${profileText(m)} needs ${m.level}` : `Minimum trust cleared: ${profileText(m)}`);
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };
  return (
    <Panel title="Minimum trust" icon={ShieldCheck} count={view.minTrust.length} fold={fold}
      summary={view.minTrust.length ? `${view.minTrust.length} ${view.minTrust.length === 1 ? 'operation has' : 'operations have'} a minimum trust` : 'no operation has a minimum trust'}>
      <div data-slot="access-min-trust" className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          A job whose trust stamp is below an operation's minimum does not get that operation on its asset, whatever its template's approvals say. A box and a person are no job: the minimum does not apply to them.
        </p>
        {view.minTrust.length === 0 ? <Empty>No operation has a minimum trust.</Empty> : (
          <ul className="divide-y rounded-lg border">
            {view.minTrust.map((m) => (
              <li key={profileText(m)} data-min-trust={`${m.profile.operation}/${m.profile.asset.kind}/${m.profile.asset.name}`} className="flex min-w-0 flex-wrap items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="font-medium break-words">{profileText(m)}: needs {m.level} or higher</div>
                  <div className="text-xs text-muted-foreground">set by {m.setBy} at {clock(m.setAt)}</div>
                </div>
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void send({ profile: m.profile, level: null })}>Clear</Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Operation</span>
            <select name="min-operation" className={`${FIELD} w-28`} value={operation} disabled={busy} onChange={(e) => setOperation(e.target.value as Operation)}>
              {operations.map((o) => <option key={o} value={o}>{o}</option>)}
            </select></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Asset kind</span>
            <select name="min-kind" className={`${FIELD} w-48`} value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as AssetKind)}>
              {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Asset</span>
            <Input name="min-asset" className="h-8 w-44" value={asset} disabled={busy} onChange={(e) => setAsset(e.target.value)} /></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Minimum trust</span>
            <select name="min-level" className={`${FIELD} w-32`} value={level} disabled={busy} onChange={(e) => setLevel(e.target.value as Level)}>
              {MIN_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select></label>
          <Button size="sm" disabled={busy || asset === ''} onClick={() => void send({ profile: { operation, asset: { kind, name: asset } }, level })}>Set minimum</Button>
        </div>
      </div>
    </Panel>
  );
}
