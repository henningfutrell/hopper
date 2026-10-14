// Settings → Host link (issue #712), the hopper's admin's: the address people open, apart from the LAN names containers
// and boxes use. A notification's question link, a UI link and an artifact's link are built on it when the user set no
// link base (Settings → Artifacts) and the hopper has no public URL. Empty: the default, localhost on the computer that
// runs the hopper. Saved to the daemon; applies to the next link, without a restart. In WSL it also shows how to test the
// link from Windows, and the .wslconfig fixes: the daemon cannot reach the Windows side to check it itself.
import { Link } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import type { HostLinkView } from '@/model/wire';
import { useHopper } from '@/store';

/** In WSL: how a person tests the link from Windows, and what to change when it fails. */
function WslHint({ base }: { base: string }) {
  return (
    <div data-slot="host-link-wsl" className="space-y-1 rounded-md border p-2 text-xs">
      <p className="font-medium">This hopper runs in WSL. Test the link from Windows.</p>
      <p>In PowerShell on this computer, run <code className="font-mono">Invoke-WebRequest {base}/job/address</code>. It must answer 204.</p>
      <p>
        If it fails, edit <code className="font-mono">.wslconfig</code> in your Windows user folder. Under <code className="font-mono">[wsl2]</code>, set{' '}
        <code className="font-mono">localhostForwarding=true</code>, or set <code className="font-mono">networkingMode=mirrored</code>.
        Then run <code className="font-mono">wsl --shutdown</code> and start the hopper again.
      </p>
      <p>
        Or run <code className="font-mono">hopper doctor</code> in PowerShell, with the hopper CLI from Windows (install page, On Windows). It
        checks the link, the WSL setup and the keep-alive shortcut, and gives the fix for each check that fails.
      </p>
      <p className="text-muted-foreground">A client in this distro makes the check automatic: Add machine → A computer.</p>
    </div>
  );
}

function Form({ view, onSaved }: { view: HostLinkView; onSaved: (v: HostLinkView) => void }) {
  const [draft, setDraft] = useState(view.hostLinkBase);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await post<HostLinkView>('/ui/api/host-link', { hostLinkBase: draft.trim() }));
      toast.success('Host link saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only the hopper\'s admin changes the host link' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="host-link" className="space-y-2 text-sm">
      <label className="flex flex-wrap items-center gap-2">
        <span className="w-40 text-muted-foreground">Host link base</span>
        <Input className="h-8 w-72" value={draft} placeholder={view.default} aria-label="Host link base" disabled={busy}
          onChange={(e) => setDraft(e.target.value)} />
        <Button size="sm" disabled={busy} onClick={() => void save()}>Save</Button>
      </label>
      <p className="text-xs">Now: {view.hostLinkBase || `${view.default} (the default)`}</p>
      <p className="text-xs text-muted-foreground">
        The address people open: links in notifications and to artifacts use it when a user set no link base and the hopper has no public URL.
        Give an address this hopper answers to. Empty: localhost on the computer that runs the hopper. Containers keep the LAN names.
      </p>
      {view.wsl && <WslHint base={view.hostLinkBase || view.default} />}
    </div>
  );
}

export function HostLink() {
  const [view, setView] = useState<HostLinkView | undefined>();
  useEffect(() => { void get<HostLinkView>('/api/host-link').then((v) => { if (typeof v?.default === 'string') setView(v); }, () => {}); }, []);
  return (
    <Panel title="Host link" icon={Link} className="max-w-3xl">
      {view ? <Form key={view.hostLinkBase} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
