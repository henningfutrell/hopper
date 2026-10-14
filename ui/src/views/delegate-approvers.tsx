// Access requests, Delegate approvers (issue #1138): the owner hands approvals to an agent. A delegate approver is a grant of
// the preset delegate-approver: it approves, declines or denies only what waits here — a job's vault grant ask, a template,
// a sandbox request —, never settings, secrets or the master key. Its approver policy names what stays the owner's (e.g.
// prod). Mint shows its refresh token once, with the command an agent runs; each delegate is listed with its policy, and
// Revoke ends it at once. Each approval a delegate makes names it and the person it acts for, on its card here.
import { Bot, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/vault-fields';
import { get, post, SessionRejected } from '@/lib/api';
import { grantLine } from '@/model/api-tokens';
import { DELEGATE_PRESET, delegateCommand, delegatesOf, denyOf, policyText } from '@/model/delegates';
import type { ApiGrantMinted, ApiGrantView } from '@/model/wire';
import { useHopper } from '@/store';

const fail = (e: unknown): void => {
  if (e instanceof SessionRejected) useHopper.setState({ authed: false });
  toast.error((e as Error).message);
};

export function DelegateApprovers() {
  const [grants, setGrants] = useState<ApiGrantView[]>([]);
  const [minted, setMinted] = useState<ApiGrantMinted | undefined>();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [deny, setDeny] = useState('');
  const [days, setDays] = useState(30);
  const reload = () => get<{ grants: ApiGrantView[] }>('/api/api-tokens').then((r) => setGrants(r.grants), fail);
  useEffect(() => { void reload(); }, []);

  const act = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    try {
      const r = await post<ApiGrantMinted | { grants: ApiGrantView[] }>('/ui/api/api-tokens', body);
      if ('refresh' in r) {
        setMinted(r); setAdding(false); setName(''); setDeny('');
        await reload();
      } else setGrants(r.grants);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const delegates = delegatesOf(grants);
  return (
    <div data-slot="delegate-approvers">
      <Panel title="Delegate approvers" icon={Bot} count={delegates.length || ''} bodyClassName="space-y-3"
        action={!adding ? <Button size="sm" disabled={busy} onClick={() => setAdding(true)}><Plus />Mint delegate</Button> : undefined}>
        <p className="text-sm text-muted-foreground">A delegate approver lets an agent approve for you what waits here — vault grant asks, templates, sandbox runs — and nothing else: no settings, no secrets, no master key. Its policy names what stays yours. Each approval it makes shows its name and yours. Revoke ends it at once.</p>
        {minted && (
          <div className="space-y-2 rounded-md border border-warn p-3">
            <p className="text-sm font-medium">{minted.view.label}: copy the refresh token now. It is not shown again.</p>
            <Label>Refresh token — the agent keeps it in a file of its own; the hopper CLI writes the new one there at each use</Label>
            <Input readOnly className="h-9 font-mono text-xs" value={minted.refresh} onFocus={(e) => e.target.select()} />
            <p className="text-xs break-all text-muted-foreground">Then: <code>{delegateCommand(location.origin)}</code>, <code>hopper grant deny</code>, <code>hopper sandbox approve</code>, <code>hopper template approve</code>.</p>
            <Button size="sm" variant="outline" onClick={() => setMinted(undefined)}>Done</Button>
          </div>
        )}
        {adding && (
          <form className="space-y-3 rounded-md border p-3" onSubmit={(e) => {
            e.preventDefault();
            void act({ action: 'mint', label: name.trim(), preset: DELEGATE_PRESET, deny: denyOf(deny), days });
          }}>
            <label className="block space-y-1"><Label>Name — the agent that approves for you</Label>
              <Input className="h-9 text-sm" name="delegate-name" value={name} required maxLength={64} placeholder="Chief of Staff" onChange={(e) => setName(e.target.value)} /></label>
            <label className="block space-y-1"><Label>Never approves what names — comma separated, e.g. prod</Label>
              <Input className="h-9 text-sm" name="delegate-deny" value={deny} maxLength={2000} placeholder="prod" onChange={(e) => setDeny(e.target.value)} /></label>
            <label className="block space-y-1"><Label>Lives at most, in days — 1 to 365</Label>
              <Input className="h-9 w-24 text-sm" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !name.trim() || days < 1 || days > 365}>Mint delegate</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </form>
        )}
        {delegates.length === 0 && !adding ? <Empty>No delegate approver. Mint one to let an agent approve for you.</Empty> : (
          <ul className="space-y-2">{delegates.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
              <span className="text-sm font-medium break-all">{g.label}</span>
              <span className="text-xs text-muted-foreground">{grantLine(g)}</span>
              <span className="w-full text-xs text-muted-foreground">{policyText(g.delegate?.deny ?? [])}</span>
              <Confirm title={`Revoke ${g.label}?`} action="Revoke" onConfirm={() => void act({ action: 'revoke', id: g.id })}
                description="The delegate stops working at once. The agent that holds it gets a refusal.">
                <Button size="sm" variant="destructive" className="ml-auto" disabled={busy}><Trash2 />Revoke</Button>
              </Confirm>
            </li>
          ))}</ul>
        )}
      </Panel>
    </div>
  );
}
