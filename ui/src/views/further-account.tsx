// A further GitHub account's panel (issue #1448, design.md "More than one GitHub account"), and Add another account under the
// first. A further account is added with a personal access token; its panel shows its job repositories, its source's sync and
// its health, never a device code or a sign-in; Remove this account forgets it, its token and its job repositories.
import { Link2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { post, SessionRejected } from '@/lib/api';
import type { ConnectedAccountStatus, SourceStatus } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';
import { ConnectionHealth, LABEL, NAME, Repositories, TokenConnect, type Provider, type Send } from './connected-account-parts';
import { SourceSync } from './source-sync';

/**
 * A further account's panel (issue #1448): connected with a personal access token, its job repositories and its source's sync;
 * ended, a new token for it; Remove this account forgets it.
 */
export function FurtherAccount({ s, name, n, tone, source, canAdmin, adminOnly, send, refresh, remove }: {
  s: ConnectedAccountStatus; name: string; n: number; tone: 'ok' | 'bad' | 'warn'; source: SourceStatus | undefined; canAdmin: boolean; adminOnly: string | undefined;
  send: Send; refresh: () => void; remove: () => void;
}) {
  const removeButton = <Button data-remove-account size="xs" variant="outline" disabled={!canAdmin} title={adminOnly ?? `Forgets this ${name} account and its token: issues of its job repositories stop becoming jobs`} onClick={remove}><Unlink />Remove this account</Button>;
  return (
    <Panel title={`${name} account ${n}`} icon={Link2} action={<StatusBadge status={s.state} label={LABEL[s.state]} tone={tone} />} bodyClassName="space-y-2 text-xs">
      <div data-connected-account={s.key} className="space-y-2">
        <div className="text-muted-foreground">
          A further {name} account, connected with a personal access token: issues labelled <code>hopper</code> in its job repositories
          become your jobs, and the jobs of those repositories act as this account on {name}.
        </div>
        {s.state === 'connected' && <>
          <div>Connected as <span className="font-mono">{s.account}</span>.</div>
          <ConnectionHealth s={s} name={name} />
          <Repositories s={s} name={name} byToken where="the token" canAdmin={canAdmin} send={send} refresh={refresh} />
          {source && <SourceSync s={source} addRepository={(repo) => send({ action: 'choose', repositories: [...s.jobRepositories.filter((r) => r !== repo), repo] })} />}
        </>}
        {s.state === 'expired' && <>
          <div data-expired className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">
            Reconnect needed: {name} refused the token of <span className="font-mono">{s.account}</span>: {s.error}. No jobs come from its repositories until you give a new token.
          </div>
          <TokenConnect name={name} disabled={!canAdmin} title={adminOnly} connect={(token) => send({ action: 'connect-token', token })} label="Connect with a new token" other />
        </>}
        {s.state === 'unreadable' && <div data-unreadable className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">
          The connection of <span className="font-mono">{s.account}</span> is kept, but this hopper cannot open it: {s.error}.
        </div>}
        {s.state === 'failed' && <>
          <div className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">{s.error}</div>
          <TokenConnect name={name} disabled={!canAdmin} title={adminOnly} connect={(token) => send({ action: 'connect-token', token })} label="Connect with a new token" other />
        </>}
        {removeButton}
      </div>
    </Panel>
  );
}

/**
 * Add another account (issue #1448): a personal access token of another account at the provider. The new account gets a panel
 * of its own; a refusal says why, and nothing is kept.
 */
export function AddAccount({ provider, onAdded }: { provider: Provider; onAdded: () => void }) {
  const canAdmin = useCanAdmin();
  const name = NAME[provider];
  const [error, setError] = useState<string>();
  const add = async (token: string): Promise<boolean> => {
    try {
      const r = await post<ConnectedAccountStatus>('/ui/api/connected-accounts', { action: 'add-token', provider, token });
      if (r.state === 'connected') { setError(undefined); toast.success(`${name} account ${r.account} added`); onAdded(); return true; }
      setError(r.state === 'failed' ? r.error : `the account reads ${LABEL[r.state]}`);
      return false;
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      return false;
    }
  };
  return (
    <div data-add-account={provider} className="space-y-1 border-t pt-2">
      <div className="font-medium">Add another {name} account</div>
      <div className="text-muted-foreground">
        Work from a second {name} account too, for example a work account beside a personal one. Each account has its own job
        repositories; a job of a repository acts as the account the repository is chosen in.
      </div>
      {error && <div data-add-account-error className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">{error}</div>}
      <TokenConnect name={name} disabled={!canAdmin} title={canAdmin ? undefined : `An admin can add a ${name} account: sign in as one`} connect={add} label="Add with a token" other />
    </div>
  );
}

