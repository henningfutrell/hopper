// New repositories (issue #2795, design.md "New repositories"): under a connected account's repositories, what happens to a
// repository it reaches that no read before saw — the new-repository policy, one mode for every owner and one per owner the
// account reaches — and each new-repository ask, with Add to job repositories and Dismiss. Ask me is the default: a mode,
// never a path around the setting.
import { Button } from '@/components/ui/button';
import { FIELD } from '@/components/plugin-form';
import type { Connected, Send } from './connected-account-parts';

type Mode = 'ask' | 'accept';
const MODE_LABEL: Record<Mode, string> = { ask: 'ask me', accept: 'add to job repositories' };

export function NewRepositories({ s, canAdmin, send }: { s: Connected; canAdmin: boolean; send: Send }) {
  const n = s.newRepositories;
  if (!n) return null;
  const owners = [...new Set((s.installations ?? []).map((i) => i.account))];
  const ownMode = (owner: string): Mode | '' => Object.entries(n.policy.owners).find(([o]) => o.toLowerCase() === owner.toLowerCase())?.[1] ?? '';
  const setPolicy = (mode: Mode, owners: Record<string, Mode>) => void send({ action: 'new-repositories', policy: { mode, owners } });
  const setOwner = (owner: string, mode: Mode | '') => {
    const rest = Object.fromEntries(Object.entries(n.policy.owners).filter(([o]) => o.toLowerCase() !== owner.toLowerCase()));
    setPolicy(n.policy.mode, mode ? { ...rest, [owner]: mode } : rest);
  };
  const title = canAdmin ? undefined : 'An admin can change this: sign in as one';
  return (
    <div data-new-repositories className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">A new repository the {s.grantedBy === 'token' ? 'token' : 'app'} reaches:</span>
        <select data-new-repository-mode aria-label="What happens to a new repository" className={`${FIELD} h-7 w-48`} value={n.policy.mode} disabled={!canAdmin} title={title}
          onChange={(e) => setPolicy(e.target.value as Mode, n.policy.owners)}>
          {(['ask', 'accept'] as const).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </select>
      </div>
      {owners.length > 1 && <div className="flex flex-wrap gap-x-4 gap-y-1">
        {owners.map((owner) => <label key={owner} className="flex items-center gap-1">
          <span className="font-mono">{owner}</span>
          <select data-new-repository-owner={owner} aria-label={`What happens to a new repository of ${owner}`} className={`${FIELD} h-7 w-48`} value={ownMode(owner)} disabled={!canAdmin} title={title}
            onChange={(e) => setOwner(owner, e.target.value as Mode | '')}>
            <option value="">as above</option>
            {(['ask', 'accept'] as const).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </label>)}
      </div>}
      {n.asks.length > 0 && <div data-new-repository-asks className="space-y-1 rounded-md border border-warn/30 bg-warn/5 p-2">
        <div className="text-warn">{n.asks.length === 1 ? 'A new repository waits' : `${n.asks.length} new repositories wait`} for you: add it to the job repositories, or dismiss it.</div>
        {n.asks.map((a) => <div key={a.repository} data-new-repository-ask={a.repository} className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{a.repository}</span>
          <span className="text-muted-foreground">seen {new Date(a.at).toLocaleString()}</span>
          <Button size="xs" data-new-repository-add disabled={!canAdmin} title={title} onClick={() => void send({ action: 'choose', repositories: [...s.jobRepositories, a.repository] })}>Add to job repositories</Button>
          <Button size="xs" variant="outline" data-new-repository-dismiss disabled={!canAdmin} title={title} onClick={() => void send({ action: 'new-repositories', dismiss: [a.repository] })}>Dismiss</Button>
        </div>)}
      </div>}
    </div>
  );
}
