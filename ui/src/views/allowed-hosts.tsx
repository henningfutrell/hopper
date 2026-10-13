// Allowed hosts (issue #1024), in Settings, the hopper's admin's: the host names and addresses the UI answers to beyond the
// LAN names. The hopper finds this host's Tailscale name and addresses itself; the admin adds any other host here, never in
// a file. A request that names one still needs a sign-in or a token.
import { Network } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { hostsOf, tailnetLine } from '@/model/allowed-hosts';
import type { AllowedHostsView } from '@/model/wire';
import { useHopper } from '@/store';

function Form({ view, onSaved }: { view: AllowedHostsView; onSaved: (v: AllowedHostsView) => void }) {
  const [text, setText] = useState(view.hosts.join('\n'));
  const [busy, setBusy] = useState(false);
  const hosts = hostsOf(text);
  const changed = hosts.join('\n') !== view.hosts.join('\n');
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await post<AllowedHostsView>('/ui/api/allowed-hosts', { hosts }));
      toast.success('Allowed hosts saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only the hopper\'s admin changes the allowed hosts' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="allowed-hosts" className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        The host names and addresses the hopper answers to, beyond localhost{view.lan.length ? ` and its LAN names (${view.lan.join(', ')})` : ''}.
        A request to one of them still needs a sign-in or an API token.
      </p>
      <p data-slot="allowed-hosts-tailnet" className={view.tailnet.on ? 'font-medium' : 'text-xs text-muted-foreground'}>{tailnetLine(view)}</p>
      <label className="block space-y-1">
        <span>More hosts, one a line: a host name or an address, with no port</span>
        <Textarea aria-label="Allowed hosts" rows={4} className="font-mono text-xs" placeholder="hopper.example.net" disabled={busy} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="text-xs text-muted-foreground">Each is answered on port {view.port}. A device must also reach this host: from loopback, a LAN peer range, or this host&apos;s tailnet.</p>
      <Button size="sm" disabled={busy || !changed} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown and every 30 s: the tailnet may come up after the hopper. */
export function AllowedHosts() {
  const [view, setView] = useState<AllowedHostsView | null>(null);
  useEffect(() => {
    const read = () => get<AllowedHostsView>('/api/allowed-hosts').then((v) => { if (Array.isArray(v?.hosts) && v.tailnet) setView(v); }, () => {});
    void read();
    const timer = setInterval(() => void read(), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Panel title="Allowed hosts" icon={Network} className="max-w-3xl">
      {view ? <Form key={view.hosts.join('\n')} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
