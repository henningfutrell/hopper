// The GitHub account a user's work comes through (issue #214, design.md "Sign in with GitHub, and work
// through that connection"): signing in with it connects it; a user signed in at the edge (SSO, SAML, a
// gateway) connects
// it here, through the hopper's app. Connect shows the provider's device code; the user enters it at
// the link, and the panel follows until the account is connected. Then its issues become this user's
// jobs, and the jobs act as them with the app marked on what they do. GitHub: the app reaches only the
// repositories it is installed on — the panel says where it is, and links to install it. Disconnect
// forgets the account and its token.
import { Link2, Unlink, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import type { ConnectedAccountStatus } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const POLL_MS = 2000;
type Provider = ConnectedAccountStatus['provider'];
const NAME: Record<Provider, string> = { github: 'GitHub' };
const LABEL: Record<ConnectedAccountStatus['state'], string> = { connected: 'connected', 'not-connected': 'not connected', waiting: 'waiting', failed: 'failed' };

export function ConnectedAccountPanel({ provider }: { provider: Provider }) {
  const [s, setS] = useState<ConnectedAccountStatus | null>(null);
  const canAdmin = useCanAdmin();
  const waiting = s?.state === 'waiting';
  useEffect(() => {
    let live = true;
    const read = () => get<{ accounts: ConnectedAccountStatus[] }>('/api/connected-accounts')
      .then((v) => { const mine = v.accounts.find((a) => a.provider === provider); if (live && mine) setS(mine); }, () => {});
    void read();
    const t = waiting ? setInterval(read, POLL_MS) : undefined;
    return () => { live = false; if (t) clearInterval(t); };
  }, [waiting, provider]);
  if (!s) return null;

  const name = NAME[provider];
  const act = async (action: 'connect' | 'cancel' | 'disconnect') => {
    try { setS(await post<ConnectedAccountStatus>('/ui/api/connected-accounts', { action, provider })); } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    }
  };
  const tone = s.state === 'connected' ? 'ok' : s.state === 'failed' ? 'bad' : 'warn';
  const adminOnly = canAdmin ? undefined : `An admin can connect ${name}: sign in as one`;
  return (
    <Panel title={`${name} account`} icon={Link2} action={<StatusBadge status={s.state} label={LABEL[s.state]} tone={tone} />} bodyClassName="space-y-2 text-xs">
      <div data-connected-account={provider} className="space-y-2">
        <div className="text-muted-foreground">
          Your {name} account, connected through {s.via}: its issues labelled <code>hopper</code> become your jobs, and your jobs act
          as you on {name}, with the hopper&apos;s app marked on what they do. Signing in with {name} connects it too.
        </div>
        {s.state === 'connected' && <>
          <div>Connected as <span className="font-mono">{s.account}</span>.</div>
          {s.installations !== undefined && (
            <div data-installations>
              {s.installations.length > 0
                ? <>The app is installed on <span className="font-mono">{s.installations.join(', ')}</span>; it reaches only the repositories chosen there.</>
                : <span className="text-warn">The app is installed nowhere you can see: it reaches no repository yet.</span>}
            </div>
          )}
          {s.installUrl && <div><a className="underline" href={s.installUrl} target="_blank" rel="noreferrer">Install the app, or choose its repositories</a></div>}
          <Button size="xs" variant="outline" disabled={!canAdmin} title={adminOnly} onClick={() => void act('disconnect')}><Unlink />Disconnect</Button>
        </>}
        {s.state === 'waiting' && <>
          <div>Open <a className="underline" href={s.verificationUri} target="_blank" rel="noreferrer">{s.verificationUri}</a>, sign in to {name} as the account to work from, and enter this code:</div>
          <div className="flex items-center gap-3">
            <code data-device-code className="rounded border px-2 py-1 font-mono text-lg font-semibold tracking-widest select-all">{s.userCode}</code>
            <Button size="xs" variant="outline" disabled={!canAdmin} onClick={() => void act('cancel')}><X />Cancel</Button>
          </div>
          <div className="text-muted-foreground">waiting for {name} — this panel changes once the code is approved</div>
        </>}
        {(s.state === 'not-connected' || s.state === 'failed') && <>
          {s.state === 'failed' && <div className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">{s.error}</div>}
          <div>Not connected.</div>
          <Button size="xs" disabled={!canAdmin} title={adminOnly ?? `Shows a code to enter on ${name}`} onClick={() => void act('connect')}><Link2 />Connect {name}</Button>
        </>}
      </div>
    </Panel>
  );
}
