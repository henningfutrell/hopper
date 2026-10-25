// The parts of a connected account's panel (issues #214, #321, #352, #647, #1250, #1380, #1448): where the app is installed
// or what a token reaches, as last read, and the job repositories chosen of them; the connection's health; connecting with a
// personal access token. Shared by the first account's panel (connected-account.tsx) and a further account's
// (further-account.tsx).
import { Link2, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ago } from '@/model/format';
import type { AppInstallation, ConnectedAccountStatus } from '@/model/wire';
import { useServerNow } from '@/store/selectors';
import { NewRepositories } from './new-repositories';

export type Provider = ConnectedAccountStatus['provider'];
export type AccountKey = ConnectedAccountStatus['key'];
export const NAME: Record<Provider, string> = { github: 'GitHub' };
export const LABEL: Record<ConnectedAccountStatus['state'], string> = { connected: 'connected', 'not-connected': 'not connected', waiting: 'waiting', failed: 'failed', expired: 'reconnect needed', unreadable: 'cannot be read' };

export type Connected = Extract<ConnectedAccountStatus, { state: 'connected' }>;
export type Send = (body: Record<string, unknown>) => Promise<boolean>;

/** Where the app is installed, or what the token reaches, as last read, and the job repositories chosen of them (issues #321, #1250). */
export function Repositories({ s, name, byToken, where, canAdmin, send, refresh }: { s: Connected; name: string; byToken: boolean; where: string; canAdmin: boolean; send: Send; refresh: () => void }) {
  return <>
    <InstallationsRead s={s} name={name} what={byToken ? 'Repositories the token reaches' : 'Where the app is installed'} refresh={refresh} />
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
    {s.installations !== undefined && s.installations.length > 0 && <NewRepositories s={s} canAdmin={canAdmin} send={send} />}
  </>;
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
export function ConnectionHealth({ s, name }: { s: Extract<ConnectedAccountStatus, { state: 'connected' }>; name: string }) {
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

/** One installation of the app: the account with its picture (issue #2774), the repositories it reaches there (each with its box), and where to choose them. */
function Installation({ installation: i, matches, box }: { installation: AppInstallation; matches: (r: string) => boolean; box: (r: string) => React.ReactNode }) {
  const n = i.repositories.length;
  return (
    <div data-installation={i.account} className="space-y-1">
      <div>
        {i.avatarUrl && <img data-owner-avatar src={i.avatarUrl} alt="" width={16} height={16} loading="lazy" referrerPolicy="no-referrer" className="mr-1 inline-block size-4 rounded-full align-text-bottom" />}
        On <span className="font-mono">{i.account}</span>: {i.repositorySelection === 'all' ? 'all repositories' : 'chosen repositories'}
        {n === 0 ? <span className="text-warn"> — it reaches no repository there yet.</span> : <> — {n} {n === 1 ? 'repository' : 'repositories'}:</>}
      </div>
      {n > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 px-2 py-1">
          {i.repositories.map((r) => <li key={r} data-repository={r} hidden={!matches(r)} className="font-mono break-all">{box(r)}</li>)}
        </ul>
      )}
      {i.permissions && <div data-installation-access className="text-muted-foreground">{access(i.permissions)}</div>}
      {i.permissionRequest && <PermissionRequest installation={i} asked={i.permissionRequest} />}
      {i.settingsUrl && <div><a className="underline" href={i.settingsUrl} target="_blank" rel="noreferrer">Choose its repositories</a></div>}
    </div>
  );
}

/**
 * An installation's permission request (issue #1378): accepted, or the new permissions the app asks for that wait for an
 * owner of the account, with the link where they review the request on GitHub.
 */
function PermissionRequest({ installation: i, asked }: { installation: AppInstallation; asked: Record<string, string> }) {
  if (Object.keys(asked).length === 0) return <div data-permission-request="accepted" className="text-muted-foreground">It has every permission the app asks for.</div>;
  return (
    <div data-permission-request="asked" className="text-warn">
      Waiting for an owner of <span className="font-mono">{i.account}</span> to accept the new permissions the app asks for: {inWords(asked)}.
      {i.settingsUrl && <> <a className="underline" href={i.settingsUrl} target="_blank" rel="noreferrer">Review the request</a></>}
    </div>
  );
}

/** What an installation grants, in words: `{ issues: 'write', metadata: 'read' }` → "It may: read and write issues; read metadata." */
function access(permissions: Record<string, string>): string {
  return `It may: ${inWords(permissions)}.`;
}

/** Permissions in words: `{ issues: 'write', metadata: 'read' }` → "read and write issues; read metadata". */
function inWords(permissions: Record<string, string>): string {
  const by = (level: string) => Object.entries(permissions).filter(([, l]) => l === level).map(([p]) => p.replaceAll('_', ' ')).sort();
  const parts = [['read and write', by('write')], ['administer', by('admin')], ['read', by('read')]] as const;
  return parts.filter(([, ps]) => ps.length > 0).map(([verb, ps]) => `${verb} ${ps.join(', ')}`).join('; ');
}

/**
 * Connect with a personal access token (issue #1380): no GitHub App. The token goes to the hopper once and the field is
 * cleared; a refusal says why in the panel.
 */
export function TokenConnect({ name, disabled, title, connect, label = 'Connect with a token', other = false }: { name: string; disabled: boolean; title: string | undefined; connect: (token: string) => Promise<boolean>; label?: string; other?: boolean }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const value = token.trim();
  return (
    <div className="space-y-1 pt-1">
      <div className="text-muted-foreground">
        {other ? `A personal access token of the other ${name} account.` : `Or connect with a personal access token of your ${name} account, with no app.`} It needs to read and write issues, pull
        requests and code in the repositories your jobs use, and to read your email addresses.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input data-token-input type="password" autoComplete="off" className="h-7 max-w-64 text-xs" placeholder="Personal access token" value={token}
          disabled={disabled || busy} onChange={(e) => setToken(e.target.value)} />
        <Button data-token-connect size="xs" variant="outline" disabled={disabled || busy || value === ''} title={title ?? `Connects ${name} with this token; it is kept in your vault`}
          onClick={() => { setBusy(true); void connect(value).then(() => { setToken(''); setBusy(false); }); }}><Link2 />{label}</Button>
      </div>
    </div>
  );
}
