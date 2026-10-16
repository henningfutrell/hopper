// The GitHub account a user's work comes through (issue #214, design.md "Sign in with GitHub, and work
// through that connection"): signing in with it connects it; a user signed in at the edge (SSO, SAML, a
// gateway) connects
// it here, through the hopper's app. Connect shows the provider's device code, centred (issue #258); the user enters it at
// the link, and the panel follows until the account is connected. Then its issues become this user's
// jobs, and the jobs act as them with the app marked on what they do. GitHub: the app reaches only the
// repositories it is installed on — the panel lists them for each account it is installed on, with a link
// to choose them; only where it is installed nowhere does it link to install it (issue #253). When GitHub
// cannot say where it is installed, the panel says why and links to see the installs, never to install (#263). Signed in
// with GitHub, the account is the sign-in: the panel offers Sign out, never a Disconnect, and points at Settings → Plugins
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
import { Link2, LogOut, RefreshCw, Unlink } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DeviceCode } from '@/components/device-code';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import { ago } from '@/model/format';
import type { AppInstallation, ConnectedAccountStatus, SourceStatus } from '@/model/wire';
import { logout, useHopper } from '@/store';
import { useCanAdmin, useServerNow, useSignedInWith } from '@/store/selectors';
import { SourceSync } from './source-sync';

const POLL_MS = 2000;
type Provider = ConnectedAccountStatus['provider'];
const NAME: Record<Provider, string> = { github: 'GitHub' };
const LABEL: Record<ConnectedAccountStatus['state'], string> = { connected: 'connected', 'not-connected': 'not connected', waiting: 'waiting', failed: 'failed', expired: 'reconnect needed', unreadable: 'cannot be read' };

export function ConnectedAccountPanel({ provider, source, onStatus }: { provider: Provider; source?: SourceStatus | undefined; onStatus?: (s: ConnectedAccountStatus) => void }) {
  const [s, setS] = useState<ConnectedAccountStatus | null>(null);
  // The Sources summary reads the sign-in as the panel has it (issue #1377).
  useEffect(() => { if (s) onStatus?.(s); }, [s, onStatus]);
  const canAdmin = useCanAdmin();
  const signedInWith = useSignedInWith(provider);
  const waiting = s?.state === 'waiting' || (s?.state === 'connected' && s.installationsReading === true);
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
  const send = async (body: Record<string, unknown>): Promise<boolean> => {
    try { setS(await post<ConnectedAccountStatus>('/ui/api/connected-accounts', { ...body, provider })); return true; } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      return false;
    }
  };
  const act = (action: 'connect' | 'cancel' | 'disconnect' | 'take-held' | 'drop-held') => send({ action });
  const refresh = async () => {
    try { setS(await post<ConnectedAccountStatus>('/ui/api/connected-accounts/refresh', { provider })); } catch (e) { toast.error((e as Error).message); }
  };
  const tone = s.state === 'connected' ? 'ok' : s.state === 'failed' || s.state === 'expired' || s.state === 'unreadable' ? 'bad' : 'warn';
  const adminOnly = canAdmin ? undefined : `An admin can connect ${name}: sign in as one`;
  const byToken = s.state === 'connected' && s.grantedBy === 'token';
  const where = byToken ? 'the token' : 'the app';
  const tokenConnect = <TokenConnect name={name} disabled={!canAdmin} title={adminOnly} connect={(token) => send({ action: 'connect-token', token })} />;
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
          <InstallationsRead s={s} name={name} what={byToken ? 'Repositories the token reaches' : 'Where the app is installed'} refresh={() => void refresh()} />
          {s.installations !== undefined && s.installationsError && <div data-installations-error className="text-warn break-words">{s.installationsError}. Shown: the read before it.</div>}
          {s.installations === undefined
            ? <div data-installations className="space-y-1">
              {s.installationsError
                ? <div data-installations-error className="text-warn break-words">{s.installationsError}</div>
                : <div data-installations-unread className="text-muted-foreground">{byToken ? 'The repositories the token reaches are' : 'Where the app is installed is'} not read from {name} yet.</div>}
              {s.configUrl && <div><a className="underline" href={s.configUrl} target="_blank" rel="noreferrer">See where the app is installed</a></div>}
            </div>
            : s.installations.length > 0
              ? <JobRepositories key={s.jobRepositories.join('\n')} installations={s.installations} installUrl={s.installUrl} where={where} saved={s.jobRepositories} canAdmin={canAdmin}
                save={(repositories) => send({ action: 'choose', repositories })} />
              : <div data-installations className="space-y-1">
                <div className="text-warn">{byToken ? 'The token reaches no repository.' : 'The app is not installed on any account you can see: it reaches no repository yet.'}</div>
                {s.installUrl && <div><a className="underline" href={s.installUrl} target="_blank" rel="noreferrer">Install the app</a></div>}
              </div>}
          {source && <SourceSync s={source} addRepository={(repo) => send({ action: 'choose', repositories: [...s.jobRepositories.filter((r) => r !== repo), repo] })} />}
          {signedInWith
            ? <>
              <div className="text-muted-foreground">To stop taking jobs from {name} and stay signed in, switch off its job source in <a className="underline" href="#settings/plugins">Settings → Plugins</a>.</div>
              <Button size="xs" variant="outline" onClick={() => void logout()}><LogOut />Sign out</Button>
            </>
            : <Button size="xs" variant="outline" disabled={!canAdmin} title={adminOnly ?? `Forgets the ${name} account and its token: its issues stop becoming jobs, and you stay signed in`} onClick={() => void act('disconnect')}><Unlink />Stop working through {name}</Button>}
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

/** When where the app is installed was read from GitHub (issue #1250), and Refresh to read it again. */
function InstallationsRead({ s, name, what, refresh }: { s: Extract<ConnectedAccountStatus, { state: 'connected' }>; name: string; what: string; refresh: () => void }) {
  const now = useServerNow();
  const cls = 'text-muted-foreground';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={cls}>{what}:</span>
      {s.installationsReading
        ? <span data-installations-read className={cls}>reading {name}…</span>
        : s.installationsCheckedAt
          ? <time data-installations-read dateTime={s.installationsCheckedAt} title={s.installationsCheckedAt} className={cls}>read {ago(s.installationsCheckedAt, now)}</time>
          : <span data-installations-read className={cls}>not read yet</span>}
      <Button data-installations-refresh size="xs" variant="ghost" disabled={s.installationsReading === true} title={`Reads from ${name} again: ${what.toLowerCase()}`} onClick={refresh}><RefreshCw />Refresh</Button>
    </div>
  );
}

const FLOW: Record<'device' | 'web' | 'token', string> = { device: 'a device code', web: 'the browser', token: 'a personal access token' };
const when = (iso: string | undefined): string => (iso ? new Date(iso).toLocaleString() : 'not yet');

/** When and how the connection was made, its last and next renewal, and its last error (issue #647). */
function ConnectionHealth({ s, name }: { s: Extract<ConnectedAccountStatus, { state: 'connected' }>; name: string }) {
  const by = s.connectedBy === 'sign-in' ? `by signing in with ${name}` : s.connectedBy === 'sources' ? 'from Sources' : undefined;
  const flow = s.grantedBy ? FLOW[s.grantedBy] : undefined;
  return (
    <dl data-connection-health className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
      <dt>Connected</dt><dd data-connected-at>{when(s.connectedAt)}{by ? `, ${by}` : ''}{flow ? `, through ${flow}` : ''}</dd>
      {s.matchEmail && <><dt>Email</dt><dd data-match-email className="break-words">{s.matchEmail}, checked at each renewal</dd></>}
      <dt>Last renewal</dt><dd data-renewed-at>{when(s.renewedAt)}</dd>
      <dt>Next renewal</dt><dd data-next-renewal>{s.nextRenewalAt ? when(s.nextRenewalAt) : 'none: its token does not renew'}</dd>
      <dt>Last error</dt><dd data-last-error className={s.lastError ? 'break-words text-warn' : undefined}>{s.lastError ? `${when(s.lastError.at)}: ${s.lastError.error}` : 'none'}</dd>
    </dl>
  );
}

/**
 * The job repositories (issue #321): every repository the app reaches, by installation, each ticked when
 * jobs may use it; a filter narrows what is shown, and Choose shown / Clear shown act on what is shown.
 * Save sends the whole list; a new saved list remounts it (its key).
 */
function JobRepositories({ installations, installUrl, where, saved, canAdmin, save }: {
  installations: AppInstallation[]; installUrl: string | undefined; where: string; saved: string[]; canAdmin: boolean; save: (repositories: string[]) => Promise<boolean>;
}) {
  const [chosen, setChosen] = useState(() => new Set(saved));
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const savedKey = saved.join('\n');
  const reached = useMemo(() => [...new Set(installations.flatMap((i) => i.repositories))], [installations]);
  const unreached = saved.filter((r) => !reached.includes(r));
  const needle = filter.trim().toLowerCase();
  const matches = (r: string) => needle === '' || r.toLowerCase().includes(needle);
  const all = [...reached, ...unreached];
  const list = all.filter((r) => chosen.has(r));
  const dirty = list.join('\n') !== savedKey || list.length !== saved.length;
  const toggle = (r: string, on: boolean) => setChosen((c) => { const n = new Set(c); if (on) n.add(r); else n.delete(r); return n; });
  const shown = (on: boolean) => setChosen((c) => { const n = new Set(c); for (const r of all.filter(matches)) { if (on) n.add(r); else n.delete(r); } return n; });
  const box = (r: string) => (
    <label className="flex items-center gap-2">
      <input type="checkbox" className="size-4" checked={chosen.has(r)} disabled={!canAdmin || busy} onChange={(e) => toggle(r, e.target.checked)} />{r}
    </label>
  );
  const adminOnly = canAdmin ? undefined : 'An admin can choose the job repositories: sign in as one';
  return (
    <div data-job-repositories className="space-y-2">
      <div className="font-medium">Repositories jobs may use</div>
      <div data-job-repositories-summary>{list.length} of {reached.length} {reached.length === 1 ? 'repository' : 'repositories'} chosen for jobs</div>
      {list.length === 0 && <div data-job-repositories-none className="text-warn">None chosen. No new jobs come in until you choose the repositories they may use.</div>}
      <div className="flex flex-wrap items-center gap-2">
        <Input data-repository-filter className="h-7 max-w-64 text-xs" placeholder="Filter repositories" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button size="xs" variant="outline" disabled={!canAdmin || busy} title={adminOnly} onClick={() => shown(true)}>Choose shown</Button>
        <Button size="xs" variant="outline" disabled={!canAdmin || busy} title={adminOnly} onClick={() => shown(false)}>Clear shown</Button>
      </div>
      <div data-installations className="space-y-2">
        {installations.map((i) => <Installation key={i.account} installation={i} matches={matches} box={box} />)}
        {installUrl && <div><a className="underline" href={installUrl} target="_blank" rel="noreferrer">Add the app to another account or organization</a></div>}
        {unreached.length > 0 && (
          <ul className="rounded-md border bg-muted/30 px-2 py-1">
            {unreached.map((r) => <li key={r} data-repository={r} hidden={!matches(r)} className="font-mono break-all">{box(r)}<span className="text-warn"> — {where} does not reach it</span></li>)}
          </ul>
        )}
      </div>
      <Button size="xs" disabled={!canAdmin || busy || !dirty} title={adminOnly}
        onClick={() => { setBusy(true); void save(list).then((ok) => { setBusy(false); if (ok) toast.success('Job repositories saved'); }); }}>Save</Button>
    </div>
  );
}

/** One installation of the app: the account, the repositories it reaches there (each with its box), and where to choose them. */
function Installation({ installation: i, matches, box }: { installation: AppInstallation; matches: (r: string) => boolean; box: (r: string) => React.ReactNode }) {
  const n = i.repositories.length;
  return (
    <div data-installation={i.account} className="space-y-1">
      <div>
        On <span className="font-mono">{i.account}</span>: {i.repositorySelection === 'all' ? 'all repositories' : 'chosen repositories'}
        {n === 0 ? <span className="text-warn"> — it reaches no repository there yet.</span> : <> — {n} {n === 1 ? 'repository' : 'repositories'}:</>}
      </div>
      {n > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 px-2 py-1">
          {i.repositories.map((r) => <li key={r} data-repository={r} hidden={!matches(r)} className="font-mono break-all">{box(r)}</li>)}
        </ul>
      )}
      {i.permissions && <div data-installation-access className="text-muted-foreground">{access(i.permissions)}</div>}
      {i.settingsUrl && <div><a className="underline" href={i.settingsUrl} target="_blank" rel="noreferrer">Choose its repositories</a></div>}
    </div>
  );
}

/** What an installation grants, in words: `{ issues: 'write', metadata: 'read' }` → "It may: read and write issues; read metadata." */
function access(permissions: Record<string, string>): string {
  const by = (level: string) => Object.entries(permissions).filter(([, l]) => l === level).map(([p]) => p.replaceAll('_', ' ')).sort();
  const parts = [['read and write', by('write')], ['administer', by('admin')], ['read', by('read')]] as const;
  return `It may: ${parts.filter(([, ps]) => ps.length > 0).map(([verb, ps]) => `${verb} ${ps.join(', ')}`).join('; ')}.`;
}

/**
 * Connect with a personal access token (issue #1380): no GitHub App. The token goes to the hopper once and the field is
 * cleared; a refusal says why in the panel.
 */
function TokenConnect({ name, disabled, title, connect }: { name: string; disabled: boolean; title: string | undefined; connect: (token: string) => Promise<boolean> }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const value = token.trim();
  return (
    <div className="space-y-1 pt-1">
      <div className="text-muted-foreground">
        Or connect with a personal access token of your {name} account, with no app. It needs to read and write issues, pull
        requests and code in the repositories your jobs use, and to read your email addresses.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input data-token-input type="password" autoComplete="off" className="h-7 max-w-64 text-xs" placeholder="Personal access token" value={token}
          disabled={disabled || busy} onChange={(e) => setToken(e.target.value)} />
        <Button data-token-connect size="xs" variant="outline" disabled={disabled || busy || value === ''} title={title ?? `Connects ${name} with this token; it is kept in your vault`}
          onClick={() => { setBusy(true); void connect(value).then(() => { setToken(''); setBusy(false); }); }}><Link2 />Connect with a token</Button>
      </div>
    </div>
  );
}
