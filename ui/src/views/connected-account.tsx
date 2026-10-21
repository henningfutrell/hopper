// The GitHub account a user's work comes through (issue #214, design.md "Sign in with GitHub, and work
// through that connection"): signing in with it connects it; a user signed in at the edge (SSO, SAML, a
// gateway) connects
// it here, through the hopper's app. Connect shows the provider's device code, centred (issue #258); the user enters it at
// the link, and the panel follows until the account is connected. Then its issues become this user's
// jobs, and the jobs act as them with the app marked on what they do. GitHub: the app reaches only the
// repositories it is installed on — the panel lists them for each account it is installed on, with a link
// to choose them; only where it is installed nowhere does it link to install it (issue #253). When GitHub
// cannot say where it is installed, the panel says why and links to see the installs, never to install (#263). Signed in
// with GitHub, the account is the sign-in: the panel offers Sign out, never a Disconnect, and points at Plugins
// to stop taking jobs from it while signed in. Signed in another way, Stop working through GitHub forgets the account and
// its token and keeps the sign-in (issue #322). A connection that ended marks only this source as needing a new connection:
// the session stays, signed in with GitHub or not, and Connect again is offered here to everyone (issue #1380). The connection's job source is shown in it, its sync under the
// account (issue #254): one GitHub piece, not a card beside it. Of the repositories the app reaches the
// person ticks the job repositories — the only ones jobs come from — filtering a long list, with how many
// are chosen of how many reached, saved without disconnecting (issue #321). A chosen one the app no longer
// reaches stays listed, to be cleared. Each installation says what GitHub granted the app there, and a link adds the app to
// another account or organization — quiet, under the installations, never a nudge to install it again (issue #352).
// A connection whose tokens the hopper cannot open (another master key) says to give the key back, and offers
// only to forget it: connecting again would mint another GitHub grant toward GitHub's ten (issue #514). A connection
// GitHub gave no refresh token says so while it works, with when it ends, and offers to connect again (issue #518).
// The connection's health (issue #647): when and how it was made, its last and next renewal, its last error; one GitHub
// refused reads "reconnect needed". A sign-in made while it works is held: Use this sign-in replaces it, Keep this
// connection drops the sign-in. Where the app is installed is shown as the hopper last read it, with when (issue #1250: from
// the hopper's database, a load never reads GitHub); Refresh reads GitHub again in the background, and the panel is read
// again every few seconds while it reads. A read that failed says why, above what was read before it.
// A personal access token (issue #1380): with no GitHub App, a person connects with a token of their own. The field takes it
// once and is cleared; the token is never shown again. Its connection lists the repositories the token reaches, not where the
// app is installed, and links to no app.
// A further GitHub account (issue #1448, `accountKey` `github-2`, …): added with a personal access token, it has a panel of
// its own — its job repositories, its source's sync, its health — never a device code or a sign-in; Remove this account
// forgets it, its token and its job repositories. A repository chosen for another account is refused, with which one.
import { Link2, LogOut, Unlink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DeviceCode } from '@/components/device-code';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import type { ConnectedAccountStatus, SourceStatus } from '@/model/wire';
import { logout, useHopper } from '@/store';
import { useCanAdmin, useSignedInWith } from '@/store/selectors';
import { ConnectionHealth, LABEL, NAME, Repositories, TokenConnect, type AccountKey, type Provider } from './connected-account-parts';
import { AddAccount, FurtherAccount } from './further-account';
import { SourceSync } from './source-sync';

const POLL_MS = 2000;
/** A further account's number (issue #1448): `github-2` → 2; undefined for the first. */
const furtherNumber = (key: AccountKey): number | undefined => { const m = /-(\d+)$/.exec(key); return m ? Number(m[1]) : undefined; };

export function ConnectedAccountPanel({ provider, accountKey = provider, source, onStatus, onRemoved, onAdded }: {
  provider: Provider; accountKey?: AccountKey; source?: SourceStatus | undefined; onStatus?: (s: ConnectedAccountStatus) => void; onRemoved?: () => void;
  /** Offers Add another account under the connected first account (issue #1448); called once one is added. */
  onAdded?: () => void;
}) {
  const [s, setS] = useState<ConnectedAccountStatus | null>(null);
  // The Sources summary reads the sign-in as the panel has it (issue #1377).
  useEffect(() => { if (s) onStatus?.(s); }, [s, onStatus]);
  const canAdmin = useCanAdmin();
  const further = furtherNumber(accountKey);
  // A further account is never the sign-in (issue #1448).
  const signedInWith = useSignedInWith(provider) && further === undefined;
  const waiting = s?.state === 'waiting' || (s?.state === 'connected' && s.installationsReading === true);
  useEffect(() => {
    let live = true;
    const read = () => get<{ accounts: ConnectedAccountStatus[] }>('/api/connected-accounts')
      .then((v) => { const mine = v.accounts.find((a) => a.key === accountKey); if (live && mine) setS(mine); }, () => {});
    void read();
    const t = waiting ? setInterval(read, POLL_MS) : undefined;
    return () => { live = false; if (t) clearInterval(t); };
  }, [waiting, accountKey]);
  if (!s) return null;

  const name = NAME[provider];
  const keyOf = further === undefined ? {} : { key: accountKey };
  const send = async (body: Record<string, unknown>): Promise<boolean> => {
    try { setS(await post<ConnectedAccountStatus>('/ui/api/connected-accounts', { ...body, provider, ...keyOf })); return true; } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      return false;
    }
  };
  const act = (action: 'connect' | 'cancel' | 'disconnect' | 'take-held' | 'drop-held') => send({ action });
  const remove = () => void send({ action: 'disconnect' }).then((ok) => { if (ok) { toast.success(`${name} account removed`); onRemoved?.(); } });
  const refresh = async () => {
    try { setS(await post<ConnectedAccountStatus>('/ui/api/connected-accounts/refresh', { provider, ...keyOf })); } catch (e) { toast.error((e as Error).message); }
  };
  const tone = s.state === 'connected' ? 'ok' : s.state === 'failed' || s.state === 'expired' || s.state === 'unreadable' ? 'bad' : 'warn';
  const adminOnly = canAdmin ? undefined : `An admin can connect ${name}: sign in as one`;
  const byToken = s.state === 'connected' && s.grantedBy === 'token';
  const where = byToken ? 'the token' : 'the app';
  const tokenConnect = <TokenConnect name={name} disabled={!canAdmin} title={adminOnly} connect={(token) => send({ action: 'connect-token', token })} />;
  if (further !== undefined) return <FurtherAccount s={s} name={name} n={further} tone={tone} source={source} canAdmin={canAdmin} adminOnly={adminOnly} send={send} refresh={() => void refresh()} remove={remove} />;
  return (
    <Panel title={`${name} account`} icon={Link2} action={<StatusBadge status={s.state} label={LABEL[s.state]} tone={tone} />} bodyClassName="space-y-2 text-xs">
      <div data-connected-account={provider} className="space-y-2">
        {byToken
          ? <div className="text-muted-foreground">
            Your {name} account, connected with a personal access token: its issues labelled <code>hopper</code> become your jobs, and
            your jobs act as you on {name} with that token. No app is marked on what they do.
          </div>
          : <div className="text-muted-foreground">
            Your {name} account, connected through {s.via}: its issues labelled <code>hopper</code> become your jobs, and your jobs act
            as you on {name}, with the hopper&apos;s app marked on what they do. Signing in with {name} connects it too.
          </div>}
        {s.state === 'connected' && <>
          {signedInWith
            ? <div>Signed in with {name} as <span className="font-mono">{s.account}</span>. Signing out ends your hopper session.</div>
            : <div>Connected as <span className="font-mono">{s.account}</span>.</div>}
          {s.held && <div data-held className="space-y-1 rounded-md border border-warn/30 bg-warn/5 p-2">
            <div className="break-words text-warn">
              A sign-in with {name} as <span className="font-mono">{s.held.account}</span> at {new Date(s.held.at).toLocaleString()} did not replace this
              connection, because this connection works. Use the new sign-in only if you want it in place of this connection.
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="xs" disabled={!canAdmin} title={adminOnly ?? `Replaces this connection with the new sign-in; running jobs get its token`} onClick={() => void act('take-held')}>Use this sign-in</Button>
              <Button size="xs" variant="outline" disabled={!canAdmin} title={adminOnly ?? 'Drops the new sign-in; this connection stays'} onClick={() => void act('drop-held')}>Keep this connection</Button>
            </div>
          </div>}
          <ConnectionHealth s={s} name={name} />
          {s.unrenewable && <div data-unrenewable className="space-y-1">
            <div className="break-words text-warn">
              {s.unrenewable}. It ends {s.expiresAt ? new Date(s.expiresAt).toLocaleString() : 'when GitHub expires it'}; then no jobs come from {name} until it is connected again.
            </div>
            <Button size="xs" variant="outline" disabled={!canAdmin} title={adminOnly ?? `A new ${name} connection, whose token renews`} onClick={() => void act('connect')}><Link2 />Connect {name} again</Button>
          </div>}
          {s.renewal && <div data-renewal className="break-words text-warn">
            Its token could not be renewed yet: {s.renewal}. The hopper tries again by itself; the connection goes on.
          </div>}
          <Repositories s={s} name={name} byToken={byToken} where={where} canAdmin={canAdmin} send={send} refresh={() => void refresh()} />
          {source && <SourceSync s={source} addRepository={(repo) => send({ action: 'choose', repositories: [...s.jobRepositories.filter((r) => r !== repo), repo] })} />}
          {signedInWith
            ? <>
              <div className="text-muted-foreground">To stop taking jobs from {name} and stay signed in, switch off its job source in <a className="underline" href="#plugins">Plugins</a>.</div>
              <Button size="xs" variant="outline" onClick={() => void logout()}><LogOut />Sign out</Button>
            </>
            : <Button size="xs" variant="outline" disabled={!canAdmin} title={adminOnly ?? `Forgets the ${name} account and its token: its issues stop becoming jobs, and you stay signed in`} onClick={() => void act('disconnect')}><Unlink />Stop working through {name}</Button>}
          {onAdded && <AddAccount provider={provider} onAdded={onAdded} />}
        </>}
        {s.state === 'waiting' && (
          <DeviceCode className="rounded-lg border bg-muted/30 px-4 py-5" provider={name} userCode={s.userCode} verificationUri={s.verificationUri} expiresAt={s.expiresAt}
            waiting={<>Waiting for you to approve it</>}
            note={<>Sign in to {name} as the account to work from. This panel changes once the code is approved.</>}
            onCancel={() => void act('cancel')} cancelDisabled={!canAdmin} />
        )}
        {s.state === 'expired' && <>
          <div data-expired className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">
            Reconnect needed: {name} refused the connection of <span className="font-mono">{s.account}</span>: {s.error}. No jobs come from {name} until you connect it again.
          </div>
          <Button size="xs" disabled={!canAdmin} title={adminOnly ?? `Shows a code to enter on ${name}`} onClick={() => void act('connect')}><Link2 />Connect {name} again</Button>
          {tokenConnect}
        </>}
        {s.state === 'unreadable' && <>
          <div data-unreadable className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">
            The connection of <span className="font-mono">{s.account}</span> is kept, but this hopper cannot open it: {s.error}.
          </div>
          <div className="text-muted-foreground">
            It has not ended: with the key back, it goes on as it was. No jobs come from {name} until then.
            Connecting again instead would make another {name} sign-in, and GitHub keeps only ten per account for the app.
          </div>
          <Button size="xs" variant="outline" disabled={!canAdmin} title={adminOnly ?? `Forgets this ${name} connection here; then you can connect ${name} anew`} onClick={() => void act('disconnect')}><Unlink />Forget this connection</Button>
        </>}
        {(s.state === 'not-connected' || s.state === 'failed') && <>
          {s.state === 'failed' && <div className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">{s.error}</div>}
          <div>Not connected.</div>
          <Button size="xs" disabled={!canAdmin} title={adminOnly ?? `Shows a code to enter on ${name}`} onClick={() => void act('connect')}><Link2 />Connect {name}</Button>
          {tokenConnect}
        </>}
      </div>
    </Panel>
  );
}
