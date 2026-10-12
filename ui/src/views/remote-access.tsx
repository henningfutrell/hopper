// Remote access (issue #880), in Settings, the hopper's admin's: the tunnel that lets an agent reach the hopper's API from
// anywhere. The admin sets the ngrok authtoken (kept in the hopper's vault, never shown again) and the domain reserved at
// ngrok, turns it on or off, and starts it again — no file on the host to edit, so it works from a phone. The status says
// whether it is up, at which URL, and ngrok's last error. Read again every 10 s while shown: the tunnel service picks a
// change up within that.
import { Globe, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { authtokenLine, remoteAccessSave, remoteAccessStatusLine, type RemoteAccessDraft } from '@/model/remote-access';
import type { RemoteAccessChange, RemoteAccessView } from '@/model/wire';
import { useHopper } from '@/store';

const STATE_TONE: Record<RemoteAccessView['status']['state'], string> = {
  off: 'text-muted-foreground', up: 'text-emerald-600', down: 'text-destructive', 'no-service': 'text-amber-600',
};

function Form({ view, onSaved }: { view: RemoteAccessView; onSaved: (v: RemoteAccessView) => void }) {
  const [draft, setDraft] = useState<RemoteAccessDraft>({ domain: view.domain ?? '', authtoken: '' });
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
    }
    setBusy(false);
  };
  const ready = view.domain !== undefined && view.authtoken !== undefined;
  return (
    <div data-slot="remote-access" className="space-y-3 text-sm">
      <p data-slot="remote-access-status" className={`font-medium ${STATE_TONE[view.status.state]}`}>{remoteAccessStatusLine(view)}</p>
      <p className="text-xs text-muted-foreground">
        An ngrok tunnel lets an agent (Grok Bot) reach the hopper&apos;s API from anywhere, with no open port on this machine. Only the API goes
        through it, and each caller is rate limited. The tunnel service in the hopper&apos;s compose stack asks for these settings every 10 s.
      </p>
      {!view.service && <p role="note" className="text-xs text-amber-600">This hopper runs no tunnel service. The compose stack runs one: see docs/deploy.md &quot;Remote access&quot;.</p>}
      {view.problem && <p role="alert" className="text-xs text-destructive">{view.problem}</p>}
      <label className="flex items-center gap-2">
        <Switch checked={view.enabled} disabled={busy || (!view.enabled && !ready)} aria-label="Remote access"
          onCheckedChange={(enabled) => void send({ enabled }, enabled ? 'Remote access on' : 'Remote access off')} />
        Remote access {view.enabled ? 'on' : 'off'}
        {!view.enabled && !ready && <span className="text-xs text-muted-foreground">(set the domain and the authtoken first)</span>}
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-32">Domain</span>
        <Input className="h-8 w-72" aria-label="Domain" placeholder="hopper.example.ngrok.app" disabled={busy} value={draft.domain}
          onChange={(e) => setDraft({ ...draft, domain: e.target.value })} />
        <a className="text-xs underline" href="https://dashboard.ngrok.com/domains" target="_blank" rel="noreferrer">Reserve one at ngrok</a>
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-32">Authtoken</span>
        <Input className="h-8 w-72" type="password" autoComplete="off" aria-label="Authtoken" placeholder={view.authtoken ? 'Type a new one to replace it' : 'Paste the authtoken'}
          disabled={busy} value={draft.authtoken} onChange={(e) => setDraft({ ...draft, authtoken: e.target.value })} />
        <a className="text-xs underline" href="https://dashboard.ngrok.com/get-started/your-authtoken" target="_blank" rel="noreferrer">Copy it from ngrok</a>
      </label>
      <p data-slot="remote-access-authtoken" className="text-xs text-muted-foreground">{authtokenLine(view)} Kept sealed in the hopper&apos;s vault; never shown again.</p>
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !checked.ok || !checked.change} onClick={() => { if (checked.ok && checked.change) void send(checked.change, 'Remote access saved'); }}>Save</Button>
        <Button size="sm" variant="outline" disabled={busy || !view.enabled} onClick={() => void send({ restart: true }, 'The tunnel starts again within 10 s')}>
          <RotateCw className="size-4" />Restart the tunnel
        </Button>
        {view.authtoken && !view.enabled && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void send({ authtoken: null }, 'Authtoken removed')}>Remove the authtoken</Button>
        )}
      </div>
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
  return (
    <Panel title="Remote access" icon={Globe} className="max-w-3xl">
      {view ? <Form key={`${view.domain ?? ''}|${view.authtoken?.setAt ?? ''}`} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
