// Settings → API tokens (issue #718): a person mints a short-lived token for an agent that acts for them over the API —
// every action the UI has, with a role no higher than theirs, for an hour at most, and Access decides each use. The token
// is shown once, here, right after the mint. The list shows each live token's label, role and end; Revoke ends one.
import { KeySquare, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { Label } from '@/components/vault-fields';
import { get, post, SessionRejected } from '@/lib/api';
import { apiTokenLine, mintableRoles } from '@/model/api-tokens';
import type { ApiTokenMinted, ApiTokenView, UiRole } from '@/model/wire';
import { useHopper } from '@/store';

type Edit = { action: 'mint'; label: string; role: UiRole; minutes: number } | { action: 'revoke'; id: string };

export function ApiTokens() {
  const role = useHopper((s) => s.user?.role);
  const [tokens, setTokens] = useState<ApiTokenView[]>([]);
  const [minted, setMinted] = useState<ApiTokenMinted | undefined>();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [as, setAs] = useState<UiRole | undefined>();
  const [minutes, setMinutes] = useState(15);
  const roles = mintableRoles(role);
  const reload = () => get<{ tokens: ApiTokenView[] }>('/api/api-tokens').then((r) => setTokens(r.tokens), (e: Error) => toast.error(e.message));
  useEffect(() => { void reload(); }, []);

  const send = async (edit: Edit): Promise<void> => {
    setBusy(true);
    try {
      const r = await post<ApiTokenMinted | { tokens: ApiTokenView[] }>('/ui/api/api-tokens', edit);
      if ('token' in r) { setMinted(r); setAdding(false); setLabel(''); await reload(); } else setTokens(r.tokens);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="API tokens" icon={KeySquare} count={tokens.length || ''} bodyClassName="space-y-3"
      action={!adding && roles.length ? <Button size="sm" onClick={() => setAdding(true)} disabled={busy}><Plus />Mint token</Button> : undefined}>
      <p className="text-sm text-muted-foreground">A token lets an agent act for you over the API: everything you can do here, with the role you give it, for an hour at most. Send it as <code>Authorization: Bearer &lt;token&gt;</code>. Access decides each use. An agent with a sign-in of its own can exchange it for a token instead.</p>
      {minted && (
        <div className="space-y-2 rounded-md border border-warn p-3">
          <p className="text-sm font-medium">{minted.label}: copy the token now. It is not shown again.</p>
          <Input readOnly className="h-9 font-mono text-xs" value={minted.token} onFocus={(e) => e.target.select()} />
          <Button size="sm" variant="outline" onClick={() => setMinted(undefined)}>Done</Button>
        </div>
      )}
      {adding && (
        <form className="space-y-3 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void send({ action: 'mint', label: label.trim(), role: as ?? roles[roles.length - 1]!, minutes }); }}>
          <label className="block space-y-1"><Label>Label — who or what uses it</Label>
            <Input className="h-9 text-sm" value={label} required maxLength={64} placeholder="Grok Bot" onChange={(e) => setLabel(e.target.value)} /></label>
          <label className="block space-y-1"><Label>Role — at most yours</Label>
            <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={as ?? roles[roles.length - 1]} onChange={(e) => setAs(e.target.value as UiRole)}>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select></label>
          <label className="block space-y-1"><Label>Lifetime in minutes — 1 to 60</Label>
            <Input className="h-9 w-24 text-sm" type="number" min={1} max={60} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !label.trim() || minutes < 1 || minutes > 60}>Mint token</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      )}
      {tokens.length === 0 && !adding ? <Empty>No live tokens.</Empty> : (
        <ul className="space-y-2">
          {tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
              <span className="text-sm font-medium break-all">{t.label}</span>
              <span className="text-xs text-muted-foreground">{apiTokenLine(t)}</span>
              <Confirm title={`Revoke ${t.label}?`} action="Revoke" onConfirm={() => void send({ action: 'revoke', id: t.id })}
                description="The token stops working at once. An agent that uses it gets a refusal.">
                <Button size="sm" variant="destructive" className="ml-auto" disabled={busy}><Trash2 />Revoke</Button>
              </Confirm>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
