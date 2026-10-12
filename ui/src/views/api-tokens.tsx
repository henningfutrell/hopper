// Settings → API tokens (issues #718, #881): a person mints a **grant** once for an agent that acts for them over the API —
// the routes its scopes name, with a role no higher than theirs — and the agent keeps acting unattended: it trades the
// grant's refresh token for short-lived API tokens, each time for a new refresh token. Both are shown once, here, right
// after the mint. The list shows each live grant: holder, scopes, when it was made, last used and from where, and when it
// ends; Revoke ends it at once, Revoke all ends every one. A box grant's tokens (issue #795) are the only ones that may do
// a box action. The hopper's admin sets how long an API token lives.
import { KeySquare, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { Label } from '@/components/vault-fields';
import { get, post, SessionRejected } from '@/lib/api';
import { apiTokenLine, grantLine, mintableRoles, parseScopes, SCOPE_PRESETS } from '@/model/api-tokens';
import type { ApiGrantMinted, ApiGrantView, ApiTokenSettings, ApiTokenView, UiRole } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdminInstance } from '@/store/selectors';

type Listed = { grants: ApiGrantView[]; tokens: ApiTokenView[] };
type Edit =
  | { action: 'mint'; label: string; holder?: string; role: UiRole; scopes: string[]; box: boolean; days: number | null; minutes?: number }
  | { action: 'revoke'; id: string } | { action: 'revoke-all' };

const fail = (e: unknown): void => {
  if (e instanceof SessionRejected) useHopper.setState({ authed: false });
  toast.error((e as Error).message);
};

export function ApiTokens() {
  const role = useHopper((s) => s.user?.role);
  const instanceAdmin = useCanAdminInstance();
  const [listed, setListed] = useState<Listed>({ grants: [], tokens: [] });
  const [known, setKnown] = useState<string[]>([]);
  const [settings, setSettings] = useState<ApiTokenSettings | undefined>();
  const [lifetime, setLifetime] = useState(10);
  const [minted, setMinted] = useState<ApiGrantMinted | undefined>();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [holder, setHolder] = useState('');
  const [as, setAs] = useState<UiRole | undefined>();
  const [scopes, setScopes] = useState('*:read');
  const [days, setDays] = useState(90);
  const [forever, setForever] = useState(false);
  const [box, setBox] = useState(false);
  const roles = mintableRoles(role);
  const reload = () => get<Listed & { scopes: string[]; settings: ApiTokenSettings }>('/api/api-tokens').then((r) => {
    setListed({ grants: r.grants, tokens: r.tokens });
    setKnown(r.scopes);
    setSettings(r.settings);
    setLifetime(r.settings.tokenMinutes);
  }, (e: Error) => toast.error(e.message));
  useEffect(() => { void reload(); }, []);

  const send = async (edit: Edit): Promise<void> => {
    setBusy(true);
    try {
      const r = await post<ApiGrantMinted | Listed>('/ui/api/api-tokens', edit);
      if ('refresh' in r) {
        setMinted(r); setAdding(false); setLabel(''); setHolder(''); setBox(false); setForever(false);
        if (r.warning) toast.warning(r.warning);
        await reload();
      } else setListed(r);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const saveLifetime = async (): Promise<void> => {
    setBusy(true);
    try {
      setSettings(await post<ApiTokenSettings>('/ui/api/api-tokens/settings', { tokenMinutes: lifetime }));
      toast.success(`API tokens now live ${lifetime} minutes`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const wanted = parseScopes(scopes);
  const count = listed.grants.length + listed.tokens.length;
  return (
    <Panel title="API tokens" icon={KeySquare} count={count || ''} bodyClassName="space-y-3"
      action={!adding && roles.length ? <Button size="sm" onClick={() => setAdding(true)} disabled={busy}><Plus />Mint grant</Button> : undefined}>
      <p className="text-sm text-muted-foreground">A grant lets an agent act for you over the API, unattended: the routes its scopes name, with the role you give it. The agent trades its refresh token at <code>POST /ui/auth/token/refresh</code> for an API token that lives {settings?.tokenMinutes ?? 10} minutes, and gets a new refresh token each time: it must keep the new one. A refresh token sent twice ends the grant at once. A grant ends when you revoke it, when it is not used for 30 days, or at its end. Send the API token as <code>Authorization: Bearer &lt;token&gt;</code>. Access decides each use.</p>
      {instanceAdmin && settings && (
        <form className="flex flex-wrap items-end gap-2 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void saveLifetime(); }}>
          <label className="block space-y-1"><Label>API-token lifetime in minutes — {settings.min} to {settings.max}</Label>
            <Input className="h-9 w-24 text-sm" type="number" name="access-minutes" min={settings.min} max={settings.max} value={lifetime} onChange={(e) => setLifetime(Number(e.target.value))} /></label>
          <Button type="submit" size="sm" variant="outline" disabled={busy || lifetime === settings.tokenMinutes || !Number.isInteger(lifetime) || lifetime < settings.min || lifetime > settings.max}>Save</Button>
          <span className="text-xs text-muted-foreground">Applies to API tokens issued from now on.</span>
        </form>
      )}
      {minted && (
        <div className="space-y-2 rounded-md border border-warn p-3">
          <p className="text-sm font-medium">{minted.view.label}: copy both now. They are not shown again.</p>
          <Label>Refresh token — the agent keeps it in its own secret store, and replaces it at each refresh</Label>
          <Input readOnly className="h-9 font-mono text-xs" value={minted.refresh} onFocus={(e) => e.target.select()} />
          <Label>API token — works now, until {new Date(minted.expiresAt).toLocaleTimeString()}</Label>
          <Input readOnly className="h-9 font-mono text-xs" value={minted.token} onFocus={(e) => e.target.select()} />
          <Button size="sm" variant="outline" onClick={() => setMinted(undefined)}>Done</Button>
        </div>
      )}
      {adding && (
        <form className="space-y-3 rounded-md border p-3" onSubmit={(e) => {
          e.preventDefault();
          void send({ action: 'mint', label: label.trim(), ...(holder.trim() ? { holder: holder.trim() } : {}), role: as ?? roles[roles.length - 1]!, scopes: wanted, box, days: forever ? null : days });
        }}>
          <label className="block space-y-1"><Label>Label — what it is for</Label>
            <Input className="h-9 text-sm" value={label} required maxLength={64} placeholder="Grok Bot" onChange={(e) => setLabel(e.target.value)} /></label>
          <label className="block space-y-1"><Label>Holder — who keeps it</Label>
            <Input className="h-9 text-sm" value={holder} maxLength={64} placeholder="grok-bot" onChange={(e) => setHolder(e.target.value.toLowerCase())} /></label>
          <label className="block space-y-1"><Label>Role — at most yours</Label>
            <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={as ?? roles[roles.length - 1]} onChange={(e) => setAs(e.target.value as UiRole)}>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select></label>
          <div className="space-y-1">
            <label className="block space-y-1"><Label>Scopes — the routes it may use: area:act, area:*, *:act or *</Label>
              <Input className="h-9 font-mono text-xs" name="scopes" list="token-scopes" value={scopes} onChange={(e) => setScopes(e.target.value)} /></label>
            <datalist id="token-scopes">{known.map((s) => <option key={s} value={s} />)}</datalist>
            <div className="flex flex-wrap gap-1">
              {SCOPE_PRESETS.map((p) => <Button key={p.label} type="button" size="sm" variant="ghost" onClick={() => setScopes(p.scopes)}>{p.label}</Button>)}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block space-y-1"><Label>Lives at most, in days — 1 to 365</Label>
              <Input className="h-9 w-24 text-sm" type="number" min={1} max={365} value={days} disabled={forever} onChange={(e) => setDays(Number(e.target.value))} /></label>
            {role === 'admin' && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={forever} disabled={busy} onChange={(e) => setForever(e.target.checked)} />
                <span>No fixed end — it lives while it is used, until you revoke it</span>
              </label>
            )}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" name="box" checked={box} disabled={busy} onChange={(e) => setBox(e.target.checked)} />
            <span>Box grant — its tokens may also start jobs, run commands, approve or merge, update, and change the work on a machine, where its scopes allow. Without it they do the rest: reads, holds, cancels and settings.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !label.trim() || wanted.length === 0 || (!forever && (days < 1 || days > 365))}>Mint grant</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      )}
      {count === 0 && !adding ? <Empty>No live grants or tokens.</Empty> : (
        <ul className="space-y-2">
          {listed.grants.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
              <span className="text-sm font-medium break-all">{g.label}{g.holder ? ` (${g.holder})` : ''}</span>
              <span className="text-xs text-muted-foreground">{grantLine(g)}</span>
              <span className="w-full font-mono text-xs break-all text-muted-foreground">{g.scopes.join(' ')}</span>
              <Confirm title={`Revoke ${g.label}?`} action="Revoke" onConfirm={() => void send({ action: 'revoke', id: g.id })}
                description="The grant and its tokens stop working at once. The agent that holds it gets a refusal.">
                <Button size="sm" variant="destructive" className="ml-auto" disabled={busy}><Trash2 />Revoke</Button>
              </Confirm>
            </li>
          ))}
          {listed.tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
              <span className="text-sm font-medium break-all">{t.label}</span>
              <span className="text-xs text-muted-foreground">exchanged token · {apiTokenLine(t)}</span>
              <Confirm title={`Revoke ${t.label}?`} action="Revoke" onConfirm={() => void send({ action: 'revoke', id: t.id })}
                description="The token stops working at once. An agent that uses it gets a refusal.">
                <Button size="sm" variant="destructive" className="ml-auto" disabled={busy}><Trash2 />Revoke</Button>
              </Confirm>
            </li>
          ))}
        </ul>
      )}
      {count > 1 && (
        <Confirm title="Revoke every grant and token?" action="Revoke all" onConfirm={() => void send({ action: 'revoke-all' })}
          description="Every grant and API token of yours stops working at once.">
          <Button size="sm" variant="outline" disabled={busy}><Trash2 />Revoke all</Button>
        </Confirm>
      )}
    </Panel>
  );
}
