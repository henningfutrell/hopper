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
// its token and keeps the sign-in (issue #322). The connection's job source is shown in it, its sync under the
// account (issue #254): one GitHub piece, not a card beside it. Of the repositories the app reaches the
// person ticks the job repositories — the only ones jobs come from — filtering a long list, with how many
// are chosen of how many reached, saved without disconnecting (issue #321). A chosen one the app no longer
// reaches stays listed, to be cleared.
import { Link2, LogOut, Unlink } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DeviceCode } from '@/components/device-code';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import type { AppInstallation, ConnectedAccountStatus, SourceStatus } from '@/model/wire';
import { logout, useHopper } from '@/store';
import { useCanAdmin, useSignedInWith } from '@/store/selectors';
import { SourceSync } from './source-sync';

const POLL_MS = 2000;
type Provider = ConnectedAccountStatus['provider'];
const NAME: Record<Provider, string> = { github: 'GitHub' };
const LABEL: Record<ConnectedAccountStatus['state'], string> = { connected: 'connected', 'not-connected': 'not connected', waiting: 'waiting', failed: 'failed', expired: 'sign-in expired' };

export function ConnectedAccountPanel({ provider, source }: { provider: Provider; source?: SourceStatus | undefined }) {
  const [s, setS] = useState<ConnectedAccountStatus | null>(null);
  const canAdmin = useCanAdmin();
  const signedInWith = useSignedInWith(provider);
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
  const send = async (body: Record<string, unknown>): Promise<boolean> => {
    try { setS(await post<ConnectedAccountStatus>('/ui/api/connected-accounts', { ...body, provider })); return true; } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      return false;
    }
  };
  const act = (action: 'connect' | 'cancel' | 'disconnect') => send({ action });
  const tone = s.state === 'connected' ? 'ok' : s.state === 'failed' || s.state === 'expired' ? 'bad' : 'warn';
  const adminOnly = canAdmin ? undefined : `An admin can connect ${name}: sign in as one`;
  return (
    <Panel title={`${name} account`} icon={Link2} action={<StatusBadge status={s.state} label={LABEL[s.state]} tone={tone} />} bodyClassName="space-y-2 text-xs">
      <div data-connected-account={provider} className="space-y-2">
        <div className="text-muted-foreground">
          Your {name} account, connected through {s.via}: its issues labelled <code>hopper</code> become your jobs, and your jobs act
          as you on {name}, with the hopper&apos;s app marked on what they do. Signing in with {name} connects it too.
        </div>
        {s.state === 'connected' && <>
          {signedInWith
            ? <div>Signed in with {name} as <span className="font-mono">{s.account}</span>. Signing out ends your hopper session.</div>
            : <div>Connected as <span className="font-mono">{s.account}</span>.</div>}
          {s.installations === undefined
            ? <div data-installations className="space-y-1">
              <div data-installations-error className="text-warn break-words">{s.installationsError ?? `${name} could not say where the app is installed.`}</div>
              {s.configUrl && <div><a className="underline" href={s.configUrl} target="_blank" rel="noreferrer">See where the app is installed</a></div>}
            </div>
            : s.installations.length > 0
              ? <JobRepositories key={s.jobRepositories.join('\n')} installations={s.installations} saved={s.jobRepositories} canAdmin={canAdmin}
                save={(repositories) => send({ action: 'choose', repositories })} />
              : <div data-installations className="space-y-1">
                <div className="text-warn">The app is not installed on any account you can see: it reaches no repository yet.</div>
                {s.installUrl && <div><a className="underline" href={s.installUrl} target="_blank" rel="noreferrer">Install the app</a></div>}
              </div>}
          {source && <SourceSync s={source} />}
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
            The sign-in of <span className="font-mono">{s.account}</span> expired: {s.error}. No jobs come from {name} until you connect it again.
          </div>
          <Button size="xs" disabled={!canAdmin} title={adminOnly ?? `Shows a code to enter on ${name}`} onClick={() => void act('connect')}><Link2 />Connect {name} again</Button>
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

/**
 * The job repositories (issue #321): every repository the app reaches, by installation, each ticked when
 * jobs may use it; a filter narrows what is shown, and Choose shown / Clear shown act on what is shown.
 * Save sends the whole list; a new saved list remounts it (its key).
 */
function JobRepositories({ installations, saved, canAdmin, save }: {
  installations: AppInstallation[]; saved: string[]; canAdmin: boolean; save: (repositories: string[]) => Promise<boolean>;
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
        {unreached.length > 0 && (
          <ul className="rounded-md border bg-muted/30 px-2 py-1">
            {unreached.map((r) => <li key={r} data-repository={r} hidden={!matches(r)} className="font-mono break-all">{box(r)}<span className="text-warn"> — the app does not reach it</span></li>)}
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
      {i.settingsUrl && <div><a className="underline" href={i.settingsUrl} target="_blank" rel="noreferrer">Choose its repositories</a></div>}
    </div>
  );
}
