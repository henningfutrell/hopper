// Job egress (issue #2849 part 3), in Settings, an admin's: the hosts a running job may connect out to through the hopper.
// First the hosts the jobs asked for — each host off the allowlist a job was refused in the last week —, each approved for its
// repository's jobs or for every job, or dismissed; Needs you counts them. Then the allowlist itself: the hopper's default
// hosts on or off, every job's hosts, each repository's hosts, the route (a job's agent behind hopper-egress) and the
// confinement (its sandbox's own network, part 4). Kept in the database, never in a file.
import { Check, Network, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { hostsOf, isJobEgressView, reposOf, reposText, type JobEgressView } from '@/model/job-egress';
import { useHopper } from '@/store';
import { setPolled } from '@/store/polled';

type Ask = JobEgressView['asks'][number];

async function act<T>(call: () => Promise<T>, done: string, refused: string): Promise<T | undefined> {
  try {
    const v = await call();
    toast.success(done);
    return v;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error(e instanceof RoleRefused ? refused : (e as Error).message);
    return undefined;
  }
}

function Asks({ view, busy, answer }: { view: JobEgressView; busy: boolean; answer: (a: Ask, how: 'repo' | 'all' | 'dismiss') => void }) {
  if (view.asks.length === 0) return <p className="text-xs text-muted-foreground">No job was refused a host in the last week.</p>;
  return (
    <ul data-slot="job-egress-asks" className="divide-y rounded-md border">
      {view.asks.map((a) => (
        <li key={`${a.repo ?? ''} ${a.host}`} data-egress-ask={a.host} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="font-mono text-xs">{a.host}</span>
            <span className="block text-xs text-muted-foreground">
              Refused to {a.jobIds.length === 1 ? '1 job' : `${a.jobIds.length} jobs`} of {a.repo ?? 'no repository'}, last at {new Date(a.at).toLocaleString()}
            </span>
          </span>
          {a.repo && <Button size="sm" variant="outline" disabled={busy} onClick={() => answer(a, 'repo')}><Check className="size-3.5" />Approve for {a.repo}</Button>}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => answer(a, 'all')}><Check className="size-3.5" />Approve for every job</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => answer(a, 'dismiss')}><X className="size-3.5" />Dismiss</Button>
        </li>
      ))}
    </ul>
  );
}

function Form({ view, onSaved }: { view: JobEgressView; onSaved: (v: JobEgressView) => void }) {
  const [defaults, setDefaults] = useState(view.egress.defaults);
  const [route, setRoute] = useState(view.egress.route);
  const [confine, setConfine] = useState(view.egress.confine);
  const [hosts, setHosts] = useState(view.egress.hosts.join('\n'));
  const [repos, setRepos] = useState(reposText(view.egress.repos));
  const [busy, setBusy] = useState(false);
  const draft = { defaults, route, confine: route && confine, hosts: hostsOf(hosts), repos: reposOf(repos) };
  const changed = JSON.stringify(draft) !== JSON.stringify({ defaults: view.egress.defaults, route: view.egress.route, confine: view.egress.confine, hosts: view.egress.hosts, repos: view.egress.repos });
  const save = async () => {
    setBusy(true);
    const saved = await act(() => post<{ egress: JobEgressView['egress'] }>('/ui/api/job-egress', draft), 'Job egress saved', 'Only an admin changes the job egress allowlist');
    if (saved) onSaved({ ...view, egress: saved.egress });
    setBusy(false);
  };
  const answer = async (a: Ask, how: 'repo' | 'all' | 'dismiss') => {
    setBusy(true);
    const body = { host: a.host, ...(a.repo ? { repo: a.repo } : {}), answer: how === 'dismiss' ? 'dismiss' : 'approve', ...(how === 'dismiss' ? {} : { for: how }) };
    const v = await act(() => post<JobEgressView>('/ui/api/job-egress/asks', body), how === 'dismiss' ? `${a.host} dismissed` : `${a.host} approved: a job's next try goes through`, 'Only an admin answers a host the jobs asked for');
    if (v) onSaved(v);
    setBusy(false);
  };
  return (
    <div data-slot="job-egress" className="space-y-4 text-sm">
      <p className="text-xs text-muted-foreground">
        The hosts a running job may connect out to through the hopper, each as <code>host:port</code>, or <code>*.domain:port</code> for
        the names under a domain. A host off the list is refused, and shows on the job and below.
      </p>
      <section className="space-y-2">
        <h3 className="font-medium">Hosts the jobs asked for</h3>
        <Asks view={view} busy={busy} answer={(a, how) => void answer(a, how)} />
      </section>
      <section className="space-y-3">
        <h3 className="font-medium">The allowlist</h3>
        <label className="flex items-center gap-2">
          <Switch checked={defaults} disabled={busy} aria-label="The hopper's default hosts" onCheckedChange={setDefaults} />
          <span>The hopper&apos;s default hosts: the model providers, GitHub and the package registries ({view.defaultHosts.length})</span>
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={route} disabled={busy} aria-label="Route the job's agent" onCheckedChange={setRoute} />
          <span>Route each job&apos;s agent through the hopper, so its connections go out only to these hosts (read at each job&apos;s start)</span>
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={route && confine} disabled={busy || !route} aria-label="Confine the job's agent" onCheckedChange={setConfine} />
          <span>Confine each routed job&apos;s agent: its sandbox gets a network of its own, so a tool that ignores the proxy reaches nothing. Its containers&apos; published ports are then out of its reach. Where this cannot hold, the job shows a warning</span>
        </label>
        <label className="block space-y-1">
          <span>Hosts every job may reach, one a line</span>
          <Textarea aria-label="Every job's hosts" rows={3} className="font-mono text-xs" placeholder="dev.example.com:8443" disabled={busy} value={hosts} onChange={(e) => setHosts(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span>Hosts of one repository&apos;s jobs: <code>owner/name host:port host:port</code>, a repository a line</span>
          <Textarea aria-label="Each repository's hosts" rows={3} className="font-mono text-xs" placeholder="octo/tools staging.example.com:443" disabled={busy} value={repos} onChange={(e) => setRepos(e.target.value)} />
        </label>
        <Button size="sm" disabled={busy || !changed} onClick={() => void save()}>Save</Button>
      </section>
    </div>
  );
}

export function JobEgress() {
  const [view, setView] = useState<JobEgressView | null>(null);
  useEffect(() => { get<unknown>('/api/job-egress').then((v) => { if (isJobEgressView(v)) setView(v); }, () => {}); }, []);
  const saved = (v: JobEgressView) => { setView(v); setPolled('/api/job-egress', v); };
  return (
    <Panel title="Job egress" icon={Network} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view.egress)} view={view} onSaved={saved} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
