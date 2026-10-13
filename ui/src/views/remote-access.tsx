// Remote access (issues #880, #968), in Settings, the hopper's admin's: the tunnel that lets an agent reach the hopper's
// API from anywhere. Off by default. The admin picks a provider — Cloudflare Tunnel or ngrok, equal alternatives —, gives
// its one credential (kept in the hopper's vault, never shown again) and turns it on: the hopper mints the tunnel, its
// host name and, at Cloudflare, its DNS record. Off or switched, it removes them again. No file on the host to edit, so it
// works from a phone. The copy-out panel shows the URLs an agent calls; the status says whether the tunnel is up, and why
// not. Read again every 10 s while shown: the tunnel services pick a change up within that.
import { Copy, Globe, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import {
  copyOut, CREDENTIAL_HELP, credentialLine, draftOf, PROVIDER_NAME, PROVIDERS, remoteAccessSave, remoteAccessStatusLine, type RemoteAccessDraft,
} from '@/model/remote-access';
import type { RemoteAccessChange, RemoteAccessView } from '@/model/wire';
import { useHopper } from '@/store';

const STATE_TONE: Record<RemoteAccessView['status']['state'], string> = {
  off: 'text-muted-foreground', up: 'text-emerald-600', down: 'text-destructive', 'no-service': 'text-amber-600',
};

const copy = (value: string) => navigator.clipboard?.writeText(value).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked: select and copy it'));

/** The public URL and the URLs an agent calls, each with a copy button, and the status. */
function CopyOut({ view }: { view: RemoteAccessView }) {
  const lines = copyOut(view);
  if (lines.length === 0) return null;
  return (
    <div data-slot="remote-access-copy-out" className="space-y-1 rounded-lg border p-3">
      {lines.map((l) => (
        <div key={l.label} className="flex flex-wrap items-center gap-2">
          <span className="min-w-36 text-xs text-muted-foreground">{l.label}</span>
          <span className="font-mono text-xs break-all">{l.value}</span>
          <Button size="sm" variant="ghost" aria-label={`Copy ${l.label}`} onClick={() => void copy(l.value)}><Copy className="size-4" /></Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-36 text-xs text-muted-foreground">Status</span>
        <span className={`text-xs ${STATE_TONE[view.status.state]}`}>{remoteAccessStatusLine(view)}</span>
      </div>
      <p className="text-xs text-muted-foreground">The hopper takes no inbound webhooks: it pulls its jobs. An agent calls the API at these URLs with an API token.</p>
    </div>
  );
}

function Form({ view, onSaved }: { view: RemoteAccessView; onSaved: (v: RemoteAccessView) => void }) {
  const [draft, setDraft] = useState<RemoteAccessDraft>(draftOf(view));
  const [busy, setBusy] = useState(false);
  const checked = remoteAccessSave(view, draft);
  const send = async (change: RemoteAccessChange, done: string) => {
    setBusy(true);
    try {
      onSaved(await post<RemoteAccessView>('/ui/api/remote-access', change));
      toast.success(done);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only the hopper\'s admin changes remote access' : (e as Error).message);
      // A refusal may still have changed the settings (a credential kept, remote access left off): read them again.
      void get<RemoteAccessView>('/api/remote-access').then((v) => { if (typeof v?.enabled === 'boolean') onSaved(v); }, () => {});
    }
    setBusy(false);
  };
  const help = CREDENTIAL_HELP[draft.provider];
  const kept = view.credentials[draft.provider];
  const pending = checked.ok ? checked.change : undefined;
  // The switch turns it on with the form's provider, credential and host name: the hopper mints the tunnel then.
  const ready = kept !== undefined || draft.credential.trim() !== '' || (view.provisioned?.provider === draft.provider);
  return (
    <div data-slot="remote-access" className="space-y-3 text-sm">
      <p data-slot="remote-access-status" className={`font-medium ${STATE_TONE[view.status.state]}`}>{remoteAccessStatusLine(view)}</p>
      <p className="text-xs text-muted-foreground">
        Optional, and off by default. A tunnel lets an agent (Grok Bot) reach the hopper&apos;s API from anywhere, with no open port on this machine.
        Pick a provider and give its one credential; the hopper makes the tunnel, its address and its DNS record itself, and removes them when you turn
        it off. Only the API goes through it, and each caller is rate limited.{' '}
        <a className="underline" href="/help/remote-access" target="_blank" rel="noopener">Help: Remote access</a>
      </p>
      {!view.service && <p role="note" className="text-xs text-amber-600">This hopper runs no tunnel service. The compose stack runs them: see docs/deploy.md &quot;Remote access&quot;.</p>}
      {view.problem && <p role="alert" className="text-xs text-destructive">{view.problem}</p>}
      {view.leftover && (
        <div role="alert" data-slot="remote-access-leftover" className="text-xs text-destructive">
          The hopper could not remove these at the provider. Remove them there:
          <ul className="ml-4 list-disc">{view.leftover.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      )}
      <fieldset className="flex flex-wrap items-center gap-2" disabled={busy}>
        <legend className="sr-only">Provider</legend>
        <span className="min-w-32">Provider</span>
        {PROVIDERS.map((p) => (
          <label key={p} className="flex items-center gap-1">
            <input type="radio" name="remote-access-provider" value={p} checked={draft.provider === p} onChange={() => setDraft({ ...draft, provider: p, credential: '' })} />
            {PROVIDER_NAME[p]}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-32">{help.name}</span>
        <Input className="h-8 w-72" type="password" autoComplete="off" aria-label={help.name} placeholder={kept ? 'Type a new one to replace it' : `Paste the ${PROVIDER_NAME[draft.provider]} ${help.name}`}
          disabled={busy} value={draft.credential} onChange={(e) => setDraft({ ...draft, credential: e.target.value })} />
        <a className="text-xs underline" href={help.where} target="_blank" rel="noreferrer">Make one</a>
      </label>
      <p className="text-xs text-muted-foreground">{help.needs}</p>
      <p data-slot="remote-access-credential" className="text-xs text-muted-foreground">{credentialLine(draft.provider, kept)} Kept sealed in the hopper&apos;s vault; never shown again.</p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-32">Host name</span>
        <Input className="h-8 w-72" aria-label="Host name" placeholder={draft.provider === 'cloudflare' ? 'hopper.<your zone> (empty: the hopper picks)' : 'the account\'s domain (empty: the hopper picks)'} disabled={busy} value={draft.domain}
          onChange={(e) => setDraft({ ...draft, domain: e.target.value })} />
      </label>
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <label className="flex items-center gap-2">
        <Switch checked={view.enabled} disabled={busy || !checked.ok || (!view.enabled && !ready)} aria-label="Remote access"
          onCheckedChange={(enabled) => void send({ ...(enabled ? pending : {}), enabled }, enabled ? 'Remote access on' : 'Remote access off: what the hopper made is removed')} />
        Remote access {view.enabled ? `on, through ${PROVIDER_NAME[view.provisioned?.provider ?? view.provider ?? draft.provider]}` : 'off'}
        {!view.enabled && !ready && <span className="text-xs text-muted-foreground">(give the {help.name} first)</span>}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !pending} onClick={() => { if (pending) void send(pending, view.enabled ? 'Saved: the tunnel is made again with it' : 'Remote access saved'); }}>Save</Button>
        <Button size="sm" variant="outline" disabled={busy || !view.enabled} onClick={() => void send({ restart: true }, 'The tunnel starts again within 10 s')}>
          <RotateCw className="size-4" />Restart the tunnel
        </Button>
        {kept && !(view.enabled && view.provisioned?.provider === draft.provider) && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void send({ provider: draft.provider, credential: null }, `${help.name} removed`)}>Remove the {help.name}</Button>
        )}
      </div>
      <CopyOut view={view} />
    </div>
  );
}

/** Read when shown and every 10 s; keyed by the saved settings, so a save starts the form from them. */
export function RemoteAccess() {
  const [view, setView] = useState<RemoteAccessView | null>(null);
  useEffect(() => {
    const read = () => get<RemoteAccessView>('/api/remote-access').then((v) => { if (typeof v?.enabled === 'boolean' && v.status) setView(v); }, () => {});
    void read();
    const timer = setInterval(() => void read(), 10_000);
    return () => clearInterval(timer);
  }, []);
  const key = view ? `${view.provider ?? ''}|${view.domain ?? ''}|${Object.values(view.credentials).map((c) => c?.setAt).join(',')}` : '';
  return (
    <Panel title="Remote access" icon={Globe} className="max-w-3xl">
      {view ? <Form key={key} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
