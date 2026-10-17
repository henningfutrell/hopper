// The cloud link (issue #467), in Settings, the hopper's admin's: link this install to an account at hopper.io, or unlink
// it, while the hopper runs. A link writes one record on this install and moves no data; an unlink removes the record.
// While linked, the admin gets a one-time registration code (issue #465) to enter at hopper.io, shown here once.
import { Cloud } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import type { CloudLinkView, RegistrationCodeMinted } from '@/model/wire';
import { useHopper } from '@/store';

export function CloudLink() {
  const [view, setView] = useState<CloudLinkView | null>(null);
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<RegistrationCodeMinted | null>(null);
  useEffect(() => { void get<CloudLinkView>('/api/cloud-link').then((v) => { if (v && 'link' in v) setView(v); }, (e: unknown) => toast.error((e as Error).message)); }, []);
  const act = async (path: string, body: object, done: string) => {
    setBusy(true);
    try {
      setView(await post<CloudLinkView>(path, body));
      setAccount('');
      setMinted(null);
      toast.success(done);
    } catch (e) {
      refused(e);
    }
    setBusy(false);
  };
  const refused = (e: unknown) => {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error(e instanceof RoleRefused ? 'Only the hopper\'s admin links this install to hopper.io' : (e as Error).message);
  };
  const mint = async () => {
    setBusy(true);
    try {
      setMinted(await post<RegistrationCodeMinted>('/ui/api/cloud-link/registration-code', {}));
    } catch (e) {
      refused(e);
    }
    setBusy(false);
  };
  const link = view?.link;
  return (
    <Panel title="hopper.io" icon={Cloud} className="max-w-3xl">
      <div data-slot="cloud-link" className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Link this hopper to your account at hopper.io. The link is one small record on this hopper. No jobs, users or settings move, and no running job stops. Unlink removes the record, and the hopper is as it was before.
        </p>
        {view === null ? <p className="text-muted-foreground">Loading…</p> : link ? (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Account</dt><dd data-slot="cloud-link-account" className="font-mono">{link.account}</dd>
              <dt className="text-muted-foreground">State</dt><dd data-slot="cloud-link-state">{link.state === 'registered' ? `Registered at hopper.io${link.registeredAt ? ` on ${new Date(link.registeredAt).toLocaleString()}` : ''}` : 'Not registered at hopper.io yet'}</dd>
              <dt className="text-muted-foreground">Instance id</dt><dd className="font-mono text-xs">{link.installId}</dd>
              <dt className="text-muted-foreground">Linked</dt><dd>{new Date(link.linkedAt).toLocaleString()} by {link.by}</dd>
            </dl>
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                To register this hopper, get a registration code and enter it at hopper.io, signed in as {link.account}. The code works once, for 10 minutes. A new code replaces the old one. To register again later, get a new code: this hopper keeps its instance id, so it stays one entry at hopper.io.
              </p>
              {minted ? (
                <div className="space-y-1">
                  <p className="text-xs">Copy this code now. It is not shown again.</p>
                  <code data-slot="cloud-registration-code" className="block break-all rounded bg-muted p-2 font-mono text-xs select-all">{minted.code}</code>
                  <p className="text-xs text-muted-foreground">Expires {new Date(minted.expiresAt).toLocaleTimeString()}</p>
                </div>
              ) : view.registrationCode ? (
                <p className="text-xs text-muted-foreground">A code is open until {new Date(view.registrationCode.expiresAt).toLocaleTimeString()}.</p>
              ) : null}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void mint()}>Get a registration code</Button>
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('/ui/api/cloud-link/unlink', {}, 'Unlinked from hopper.io')}>Unlink</Button>
          </>
        ) : (
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act('/ui/api/cloud-link', { account }, 'Linked to hopper.io'); }}>
            <label className="flex-1 space-y-1">
              <span>Your hopper.io account</span>
              <Input aria-label="hopper.io account" placeholder="octo-cat" disabled={busy} value={account} onChange={(e) => setAccount(e.target.value)} />
            </label>
            <Button size="sm" type="submit" disabled={busy || account.trim() === ''}>Link</Button>
          </form>
        )}
      </div>
    </Panel>
  );
}
