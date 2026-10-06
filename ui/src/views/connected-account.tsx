// The GitHub account a user's work comes through (issue #214, design.md "Sign in with GitHub, and work
// through that connection"): signing in with it connects it; a user signed in at the edge (SSO, SAML, a
// gateway) connects
// it here, through the hopper's app. Connect shows the provider's device code, centred (issue #258); the user enters it at
// the link, and the panel follows until the account is connected. Then its issues become this user's
// jobs, and the jobs act as them with the app marked on what they do. GitHub: the app reaches only the
// repositories it is installed on — the panel lists them for each account it is installed on, with a link
// to choose them; only where it is installed nowhere does it link to install it (issue #253). Disconnect
// forgets the account and its token. The connection's job source is shown in it, its sync under the
// account (issue #254): one GitHub piece, not a card beside it.
import { Link2, Unlink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DeviceCode } from '@/components/device-code';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import type { AppInstallation, ConnectedAccountStatus, SourceStatus } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';
import { SourceSync } from './source-sync';

const POLL_MS = 2000;
type Provider = ConnectedAccountStatus['provider'];
const NAME: Record<Provider, string> = { github: 'GitHub' };
const LABEL: Record<ConnectedAccountStatus['state'], string> = { connected: 'connected', 'not-connected': 'not connected', waiting: 'waiting', failed: 'failed' };

export function ConnectedAccountPanel({ provider, source }: { provider: Provider; source?: SourceStatus | undefined }) {
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
          {s.installations === undefined
            ? s.installUrl && <div><a className="underline" href={s.installUrl} target="_blank" rel="noreferrer">Install the app, or choose its repositories</a></div>
            : s.installations.length > 0
              ? <div data-installations className="space-y-2">{s.installations.map((i) => <Installation key={i.account} installation={i} />)}</div>
              : <div data-installations className="space-y-1">
                <div className="text-warn">The app is not installed on any account you can see: it reaches no repository yet.</div>
                {s.installUrl && <div><a className="underline" href={s.installUrl} target="_blank" rel="noreferrer">Install the app</a></div>}
              </div>}
          {source && <SourceSync s={source} />}
          <Button size="xs" variant="outline" disabled={!canAdmin} title={adminOnly} onClick={() => void act('disconnect')}><Unlink />Disconnect</Button>
        </>}
        {s.state === 'waiting' && (
          <DeviceCode className="rounded-lg border bg-muted/30 px-4 py-5" provider={name} userCode={s.userCode} verificationUri={s.verificationUri} expiresAt={s.expiresAt}
            waiting={<>Waiting for you to approve it</>}
            note={<>Sign in to {name} as the account to work from. This panel changes once the code is approved.</>}
            onCancel={() => void act('cancel')} cancelDisabled={!canAdmin} />
        )}
        {(s.state === 'not-connected' || s.state === 'failed') && <>
          {s.state === 'failed' && <div className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">{s.error}</div>}
          <div>Not connected.</div>
          <Button size="xs" disabled={!canAdmin} title={adminOnly ?? `Shows a code to enter on ${name}`} onClick={() => void act('connect')}><Link2 />Connect {name}</Button>
        </>}
      </div>
    </Panel>
  );
}

/** One installation of the app: the account, the repositories it reaches there, and where to choose them. */
function Installation({ installation: i }: { installation: AppInstallation }) {
  const n = i.repositories.length;
  return (
    <div data-installation={i.account} className="space-y-1">
      <div>
        On <span className="font-mono">{i.account}</span>: {i.repositorySelection === 'all' ? 'all repositories' : 'chosen repositories'}
        {n === 0 ? <span className="text-warn"> — it reaches no repository there yet.</span> : <> — {n} {n === 1 ? 'repository' : 'repositories'}:</>}
      </div>
      {n > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 px-2 py-1">
          {i.repositories.map((r) => <li key={r} data-repository className="font-mono break-all">{r}</li>)}
        </ul>
      )}
      {i.settingsUrl && <div><a className="underline" href={i.settingsUrl} target="_blank" rel="noreferrer">Choose its repositories</a></div>}
    </div>
  );
}
