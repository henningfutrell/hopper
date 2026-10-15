// Settings → Intake (issues #652, #930), an admin's: the trusted actors — the GitHub accounts whose issues, labels and
// assignments start the user's jobs. Picked from real accounts GitHub shows — the candidates, or one looked up by login —
// and kept by GitHub user id, so no login that does not exist is ever kept. None named: the connected login, trusted by
// default. Any other issue is a request card in Intake. A list kept before ids is looked up again, ready to save. Below
// it, auto-approval (issue #1268).
import { UserCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { useHopper } from '@/store';
import type { ActorCandidate, ActorCandidates, CandidateFrom, GitHubAccount, IntakeActorsView } from '@/model/wire';
import { IntakeAutoApproval } from '@/views/intake-auto-approval';

const FROM_TEXT: Record<CandidateFrom, string> = {
  connected: 'connected account', collaborator: 'collaborator', member: 'org member', author: 'issue author', 'hopper-user': 'hopper user', 'api-token': 'API token',
};

/** A GitHub login as GitHub takes it: letters, digits and single hyphens. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const byLogin = (a: GitHubAccount, b: GitHubAccount) => a.login.toLowerCase().localeCompare(b.login.toLowerCase());
const idsOf = (list: GitHubAccount[]) => list.map((a) => a.id).sort((a, b) => a - b).join(',');

function Account({ account, slot, note, children }: { account: GitHubAccount; slot: string; note?: string; children?: ReactNode }) {
  return (
    <li data-slot={slot} className="flex items-center gap-2 py-1">
      {account.avatarUrl
        ? <img src={account.avatarUrl} alt="" width={24} height={24} loading="lazy" referrerPolicy="no-referrer" className="size-6 rounded-full" />
        : <span className="size-6 rounded-full bg-muted" />}
      <span data-slot="actor-login" className="font-mono text-xs">{account.login}</span>
      <span className="text-xs text-muted-foreground">{account.type}</span>
      {note && <span className="text-xs text-muted-foreground">· {note}</span>}
      <span className="ml-auto flex items-center gap-2">{children}</span>
    </li>
  );
}

function Picker({ view, onSaved }: { view: IntakeActorsView; onSaved: (v: IntakeActorsView) => void }) {
  const admin = useHopper((s) => s.user?.role) === 'admin';
  const [found, setFound] = useState<ActorCandidates | null>(null);
  const [legacy, setLegacy] = useState<{ accounts: GitHubAccount[]; missing: string[] } | null>(view.unresolved.length ? null : { accounts: [], missing: [] });
  const [chosen, setChosen] = useState<GitHubAccount[] | null>(null);
  const [looked, setLooked] = useState<GitHubAccount[]>([]);
  const [find, setFind] = useState('');
  const [lookupProblem, setLookupProblem] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<ActorCandidates>('/api/intake-actors/candidates').then(setFound, (e: Error) => setFound({ candidates: [], problems: [e.message] }));
    if (view.unresolved.length === 0) return;
    // A list kept before ids (issue #930): each login looked up again, so the admin saves it by id.
    void Promise.all(view.unresolved.map((l) => get<GitHubAccount>(`/api/intake-actors/lookup?login=${encodeURIComponent(l)}`).then((a) => a, () => l)))
      .then((answers) => setLegacy({
        accounts: answers.filter((a): a is GitHubAccount => typeof a !== 'string' && a.type === 'User'),
        missing: answers.map((a, i) => (typeof a === 'string' || a.type !== 'User' ? view.unresolved[i]! : '')).filter((l) => l !== ''),
      }));
  }, [view]);

  const connected = found?.candidates.find((c) => c.from.includes('connected'));
  /** What is trusted as saved: the accounts named, else the connected account by default. */
  const saved = view.accounts.length ? view.accounts : connected ? [connected] : [];
  const start = view.unresolved.length ? legacy?.accounts ?? [] : saved;
  const draft = (chosen ?? start).slice().sort(byLogin);
  const changed = view.unresolved.length > 0 ? legacy !== null : idsOf(draft) !== idsOf(saved);
  const byDefault = view.accounts.length === 0 && view.unresolved.length === 0 && chosen === null;
  const offered: ActorCandidate[] = [...(found?.candidates ?? []), ...looked.filter((l) => !found?.candidates.some((c) => c.id === l.id)).map((l) => ({ ...l, from: [] }))]
    .filter((c) => !draft.some((d) => d.id === c.id))
    .filter((c) => find.trim() === '' || c.login.toLowerCase().includes(find.trim().toLowerCase()));
  const wanted = find.trim().replace(/^@/, '');
  const canLookUp = LOGIN.test(wanted) && !offered.some((c) => c.login.toLowerCase() === wanted.toLowerCase()) && !draft.some((d) => d.login.toLowerCase() === wanted.toLowerCase());

  const add = (a: GitHubAccount) => setChosen([...draft, { id: a.id, login: a.login, type: a.type, ...(a.avatarUrl ? { avatarUrl: a.avatarUrl } : {}) }]);
  const remove = (a: GitHubAccount) => setChosen(draft.filter((d) => d.id !== a.id));
  const lookUp = async () => {
    setLookupProblem('');
    try {
      const a = await get<GitHubAccount>(`/api/intake-actors/lookup?login=${encodeURIComponent(wanted)}`);
      if (a.type !== 'User') setLookupProblem(`${a.login} is a ${a.type}: only a person's account can be trusted`);
      else setLooked((l) => [...l.filter((x) => x.id !== a.id), a]);
    } catch (e) {
      setLookupProblem((e as Error).message);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      const v = await post<IntakeActorsView>('/ui/api/intake-actors', { ids: draft.map((a) => a.id).sort((a, b) => a - b) });
      setChosen(null);
      onSaved(v);
      toast.success('Trusted actors saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the trusted actors' : (e as Error).message);
    }
    setBusy(false);
  };

  return (
    <div data-slot="intake-actors" className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        An issue becomes a job only when a trusted actor wrote it, added its label and assigned it to you. Apps and bots never are.
        Any other issue shows in Intake as a request: you read it and approve it. Trust is kept by GitHub account, so a renamed account stays trusted.
      </p>
      <section className="space-y-1">
        <h3 className="text-xs font-medium">Trusted now</h3>
        {view.unresolved.length > 0 && (
          <p data-slot="unresolved" className="text-xs text-amber-600 dark:text-amber-400">
            Saved before accounts were kept by id: {view.unresolved.join(', ')}. Save to keep them by account.
            {legacy && legacy.missing.length > 0 && ` GitHub knows no person's account ${legacy.missing.join(', ')}: it is dropped when you save.`}
          </p>
        )}
        {draft.length === 0
          ? <p className="text-xs text-muted-foreground">{view.connected ? `Your connected GitHub login ${view.connected} only` : 'Nobody: connect GitHub in Sources'}</p>
          : (
            <ul>
              {draft.map((a) => (
                <Account key={a.id} account={a} slot="trusted-actor" {...(byDefault ? { note: 'trusted by default' } : {})}>
                  {admin && !byDefault && <Button size="xs" variant="ghost" disabled={busy} onClick={() => remove(a)}>Remove</Button>}
                </Account>
              ))}
            </ul>
          )}
      </section>
      {admin && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium">Add from GitHub</h3>
          <Input aria-label="Find a GitHub account" className="h-8 text-sm" placeholder="Filter, or type a login to look up" value={find}
            onChange={(e) => { setFind(e.target.value); setLookupProblem(''); }} />
          {canLookUp && <Button size="sm" variant="outline" onClick={() => void lookUp()}>{`Look up ${wanted} on GitHub`}</Button>}
          {lookupProblem && <p data-slot="lookup-problem" className="text-xs text-destructive">{lookupProblem}</p>}
          {found === null
            ? <p className="text-xs text-muted-foreground">Reading accounts from GitHub…</p>
            : (
              <ul className="max-h-72 overflow-y-auto">
                {offered.map((c) => (
                  <Account key={c.id} account={c} slot="actor-candidate" {...(c.from.length ? { note: c.from.map((f) => FROM_TEXT[f]).join(', ') } : {})}>
                    <Button size="xs" variant="outline" disabled={busy} onClick={() => add(c)}>Add</Button>
                  </Account>
                ))}
              </ul>
            )}
          {found && found.problems.length > 0 && (
            <p data-slot="candidate-problems" className="text-xs text-muted-foreground">Not read: {found.problems.join('; ')}</p>
          )}
          <Button size="sm" disabled={busy || !changed} onClick={() => void save()}>Save</Button>
        </section>
      )}
    </div>
  );
}

/** Read when shown; keyed by the saved list, so a save starts the picker from it. */
export function IntakeActors() {
  const [view, setView] = useState<IntakeActorsView | null>(null);
  useEffect(() => { get<IntakeActorsView>('/api/intake-actors').then((v) => { if (Array.isArray(v?.accounts)) setView(v); }, () => {}); }, []);
  return (
    <div className="space-y-4">
      <Panel title="Intake: trusted actors" icon={UserCheck} className="max-w-3xl">
        {view
          ? <Picker key={`${idsOf(view.accounts)}|${view.unresolved.join(',')}`} view={view} onSaved={setView} />
          : <p className="text-sm text-muted-foreground">Loading…</p>}
      </Panel>
      <IntakeAutoApproval />
    </div>
  );
}
