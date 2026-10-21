// The GitLab account (issue #1448 part 2, design.md "A GitLab source"): connect GitLab with a personal access token, at
// gitlab.com or at a GitLab of your own; pick the projects whose issues labelled hopper Intake lists; the source's sync inside
// the panel; Remove this account. An issue assigned to the account, of a trusted origin, becomes a job that works through the
// hopper with the account's token (issue #1448 part 3): the panel says so. A token GitLab refused reads
// "reconnect needed", with a field for a new one. Shown once the daemon answers GET /api/gitlab-account.
import { Link2, RefreshCw, Unlink } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FoldSection, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import type { GitLabAccountStatus, SourceStatus } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';
import { SourceSync } from './source-sync';

const LABEL: Record<GitLabAccountStatus['state'], string> = { connected: 'connected', 'not-connected': 'not connected', failed: 'failed', expired: 'reconnect needed', unreadable: 'unreadable' };
type Send = (body: Record<string, unknown>) => Promise<boolean>;

/** The GitLab URL and a personal access token; the token goes to the hopper once, and the field is cleared. */
function Connect({ disabled, title, send, label, baseUrl }: { disabled: boolean; title: string | undefined; send: Send; label: string; baseUrl?: string }) {
  const [url, setUrl] = useState(baseUrl ?? 'https://gitlab.com');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const value = token.trim();
  return (
    <div data-gitlab-connect className="space-y-1 pt-1">
      <div className="text-muted-foreground">
        A personal access token of your GitLab account, with the scope <code>read_api</code> and <code>read_user</code> (to read your projects, their
        issues and your emails). It is kept in your vault.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input data-gitlab-url className="h-7 max-w-64 text-xs" placeholder="https://gitlab.com" value={url} disabled={disabled || busy} onChange={(e) => setUrl(e.target.value)} />
        <Input data-gitlab-token type="password" autoComplete="off" className="h-7 max-w-64 text-xs" placeholder="Personal access token" value={token}
          disabled={disabled || busy} onChange={(e) => setToken(e.target.value)} />
        <Button data-gitlab-token-connect size="xs" variant="outline" disabled={disabled || busy || value === ''} title={title ?? 'Connects GitLab with this token'}
          onClick={() => { setBusy(true); void send({ action: 'connect', token: value, baseUrl: url.trim() }).then(() => { setToken(''); setBusy(false); }); }}><Link2 />{label}</Button>
      </div>
    </div>
  );
}

/** The projects the token reaches, each with its box; Save sends the whole list. A picked one it no longer reaches stays listed. */
function Projects({ s, canAdmin, send }: { s: Extract<GitLabAccountStatus, { state: 'connected' }>; canAdmin: boolean; send: Send }) {
  const [picked, setPicked] = useState(() => new Set(s.projects));
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const all = useMemo(() => [...new Set([...(s.reached ?? []), ...s.projects])], [s.reached, s.projects]);
  const needle = filter.trim().toLowerCase();
  const list = all.filter((p) => picked.has(p));
  const dirty = list.join('\n') !== s.projects.join('\n');
  const adminOnly = canAdmin ? undefined : 'An admin can pick the projects: sign in as one';
  return (
    <div data-gitlab-projects className="space-y-2">
      <div className="font-medium">Projects whose issues Intake lists</div>
      <div data-gitlab-projects-summary>{list.length} of {s.reached?.length ?? 0} {s.reached?.length === 1 ? 'project' : 'projects'} picked</div>
      {s.reachError && <div data-gitlab-reach-error className="text-warn break-words">{s.reachError}</div>}
      {all.length > 8 && <Input data-gitlab-project-filter className="h-7 max-w-64 text-xs" placeholder="Filter projects" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {all.length === 0
        ? <div className="text-warn">The token reaches no project.</div>
        : <ul className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 px-2 py-1">
          {all.map((p) => (
            <li key={p} data-gitlab-project={p} hidden={needle !== '' && !p.toLowerCase().includes(needle)} className="font-mono break-all">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4" checked={picked.has(p)} disabled={!canAdmin || busy}
                  onChange={(e) => setPicked((c) => { const n = new Set(c); if (e.target.checked) n.add(p); else n.delete(p); return n; })} />{p}
                {!(s.reached ?? []).includes(p) && <span className="text-warn"> — the token does not reach it</span>}
              </label>
            </li>
          ))}
        </ul>}
      <Button size="xs" disabled={!canAdmin || busy || !dirty} title={adminOnly}
        onClick={() => { setBusy(true); void send({ action: 'choose', projects: list }).then((ok) => { setBusy(false); if (ok) toast.success('GitLab projects saved'); }); }}>Save</Button>
    </div>
  );
}

/** The GitLab section of Sources: its panel, with the GitLab source's sync inside it. */
export function GitLabSection({ source }: { source: SourceStatus | undefined }) {
  const [s, setS] = useState<GitLabAccountStatus>();
  const [error, setError] = useState<string>();
  const canAdmin = useCanAdmin();
  const read = useCallback(() => { void get<{ account: GitLabAccountStatus }>('/api/gitlab-account').then((v) => setS(v.account), () => {}); }, []);
  useEffect(read, [read]);
  if (!s) return null;
  const send: Send = async (body) => {
    try {
      const { account } = await post<{ account: GitLabAccountStatus }>('/ui/api/gitlab-account', body);
      if (account.state === 'failed') { setError(account.error); read(); return false; }
      setError(undefined); setS(account); return true;
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      return false;
    }
  };
  const adminOnly = canAdmin ? undefined : 'An admin can connect GitLab: sign in as one';
  const tone = s.state === 'connected' ? 'ok' : s.state === 'not-connected' ? 'warn' : 'bad';
  const why = error ?? (s.state === 'not-connected' ? s.error : undefined);
  const attached = 'account' in s ? s : undefined;
  return (
    <FoldSection id="sources-gitlab" title="GitLab" fold="sources.gitlab" line={
        <p className="text-xs text-muted-foreground">
          Issues labelled <code>hopper</code> in the projects you pick are listed in Intake. An issue that your GitLab account wrote, labelled and assigned to itself becomes a job. The job fetches and pushes through the hopper with this account's token, and opens a merge request. Give the token the scopes <code>api</code>, <code>read_user</code> and <code>write_repository</code>.
        </p>}>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="GitLab account" icon={Link2} action={<StatusBadge status={s.state} label={LABEL[s.state]} tone={tone} />} bodyClassName="space-y-2 text-xs">
          <div data-gitlab-account={s.state} className="space-y-2">
            {attached && <div>Connected as <span className="font-mono">{attached.account}</span> at <span className="font-mono">{attached.baseUrl}</span>, {new Date(attached.connectedAt).toLocaleString()}{attached.matchEmail ? `, for ${attached.matchEmail}` : ''}.</div>}
            {s.state === 'connected' && <>
              <Button data-gitlab-refresh size="xs" variant="ghost" title="Reads from GitLab again the projects the token reaches" onClick={() => void send({ action: 'refresh' })}><RefreshCw />Refresh projects</Button>
              <Projects key={s.projects.join('\n') + (s.reached ?? []).join('\n')} s={s} canAdmin={canAdmin} send={send} />
              {source && <SourceSync s={source} />}
            </>}
            {s.state === 'expired' && <div data-expired className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">
              Reconnect needed: {s.error}. No issue of GitLab is listed until you give a new token.
            </div>}
            {s.state === 'unreadable' && <div data-unreadable className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">
              The GitLab token is kept, but this hopper cannot open it: {s.error}.
            </div>}
            {why && <div data-gitlab-error className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">{why}</div>}
            {(s.state === 'not-connected' || s.state === 'failed') && <Connect disabled={!canAdmin} title={adminOnly} send={send} label="Connect GitLab" />}
            {s.state === 'expired' && <Connect disabled={!canAdmin} title={adminOnly} send={send} label="Connect with a new token" baseUrl={s.baseUrl} />}
            {attached && <Button data-gitlab-remove size="xs" variant="outline" disabled={!canAdmin} title={adminOnly ?? 'Forgets this GitLab account and its token'}
              onClick={() => void send({ action: 'disconnect' }).then((ok) => { if (ok) toast.success('GitLab account removed'); })}><Unlink />Remove this account</Button>}
          </div>
        </Panel>
      </div>
    </FoldSection>
  );
}
