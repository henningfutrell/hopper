// Users (issue #158): the people this hopper works for, each with their own jobs, questions and
// settings, kept apart. In Settings. An admin adds one (POST /ui/api/users) and is shown the one-time
// login link the daemon answers, one per address the UI is reached at, to copy and hand over. Only an
// admin lists the users, and reads the users' work only as totals across all of them (GET /api/instance,
// issue #221).
import { Copy, Plus, Users as UsersIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import { UsageGraphCard } from '@/components/usage-graph-card';
import { clock } from '@/model/format';
import { totalsAsSeries } from '@/model/usage-history';
import type { InstanceTotals, InstanceUsageHistory, UsageTotal, UserAdded, UserView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdminInstance } from '@/store/selectors';

export function Users() {
  const canAdmin = useCanAdminInstance();
  const me = useHopper((s) => s.user?.id);
  const [users, setUsers] = useState<UserView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<UserAdded | null>(null);
  const [totals, setTotals] = useState<InstanceTotals | null>(null);

  const load = () => Promise.all([
    get<{ users: UserView[] }>('/api/users').then((r) => setUsers(r.users)),
    get<InstanceTotals>('/api/instance').then(setTotals),
  ]).catch((e: unknown) => toast.error((e as Error).message));
  // GET /api/users answers an admin session (or loopback without one): nobody else lists the users.
  useEffect(() => { if (canAdmin) void load(); }, [canAdmin]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post<UserAdded>('/ui/api/users', { action: 'add', name: name.trim() });
      setAdded(r);
      setAdding(false);
      setName('');
      toast.success(`${r.user.name} added`);
      await load();
    } catch (err) {
      if (err instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = (l: string) => navigator.clipboard?.writeText(l).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));

  return (
    <Panel title="Users" icon={UsersIcon} count={users?.length}
      action={canAdmin && !adding ? <Button size="xs" variant="outline" className="gap-1" onClick={() => { setAdding(true); setAdded(null); }}><Plus />Add user</Button> : undefined}>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Each user has their own jobs, questions, machines, plugins and webhooks. Nobody sees another user's work, admins included: an admin sees only the totals across all users.</p>
        {canAdmin && totals && <Totals totals={totals} />}
        {canAdmin && <UsageGraphCard<InstanceUsageHistory> path="/api/instance/usage-history" seriesOf={totalsOf} title="Usage over time, all users"
          empty="No usage history in this range yet: each user's usage sources are kept from now on, each time they read." />}
        {adding && (
          <form onSubmit={(e) => void add(e)} className="flex flex-wrap items-end gap-2">
            <label className="block min-w-48 flex-1 space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Name</div>
              <Input aria-label="Name" className="h-9 text-sm" value={name} required maxLength={64} autoFocus onChange={(e) => setName(e.target.value)} />
            </label>
            <Button type="submit" disabled={busy || !name.trim()}>Add</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setAdding(false)}>Cancel</Button>
          </form>
        )}
        {added && (
          <div data-login-link className="space-y-1.5 rounded-lg border p-3 text-sm">
            <div>
              {added.links.length
                ? <>Give <strong>{added.user.name}</strong> this link. It signs them in once, within 10 minutes.</>
                : <><strong>{added.user.name}</strong> was added. Local sign-in is off, so there is no link: they sign in with the hopper's sign-in.</>}
            </div>
            {added.links.map((l) => (
              <div key={l} className="flex min-w-0 items-center gap-1">
                <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={l}>{l}</code>
                <Button variant="ghost" size="icon-xs" aria-label="Copy link" onClick={() => copy(l)}><Copy /></Button>
              </div>
            ))}
          </div>
        )}
        {!canAdmin ? <Empty>Only the hopper's admins see and add users.</Empty> : users === null ? <Empty>Loading…</Empty> : (
          <ul className="divide-y rounded-lg border">
            {users.map((u) => (
              <li key={u.id} data-user={u.id} className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{u.name}</span>
                {u.id === me && <StatusBadge status="you" tone="muted" />}
                <span className="num shrink-0 text-xs text-muted-foreground">added {clock(u.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/** The usage graph summed over every user (issue #385): a line per usage window, nobody's share. */
const totalsOf = (h: InstanceUsageHistory) => totalsAsSeries(h.totals);

/** The users' work as an admin reads it: totals across every user, nobody's share. */
function Totals({ totals: t }: { totals: InstanceTotals }) {
  const items: [string, number][] = [
    ['waiting', t.jobs.queued + t.jobs.held + t.jobs.claimed], ['running', t.jobs.running], ['waiting for an answer', t.jobs.waiting_answer], ['operator-led', t.jobs.operator_led],
    ['open questions', t.questions.open], ['lanes busy', t.lanes.busy], ['lanes open', t.lanes.total],
    ['finished, last 24 h', t.endedLastDay.finished], ['failed, last 24 h', t.endedLastDay.failed],
    ['cancelled, last 24 h', t.endedLastDay.cancelled], ['rejected, last 24 h', t.endedLastDay.rejected],
  ];
  return (
    <div data-instance-totals className="space-y-1.5 rounded-lg border p-3">
      <div className="text-xs font-medium text-muted-foreground">All users together</div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        {items.map(([label, n]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="num font-medium">{n}</dd>
          </div>
        ))}
      </dl>
      {t.usage.length > 0 && (
        <dl data-instance-usage className="grid grid-cols-1 gap-x-4 gap-y-1 border-t pt-1.5 text-sm sm:grid-cols-2">
          {t.usage.map((u) => (
            <div key={`${u.unit} ${u.window ?? ''}`} className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">usage{u.window ? `, ${u.window}` : ''}</dt>
              <dd className="num font-medium">
                {usageText(u)} <span className="text-xs font-normal text-muted-foreground">{u.readings} {u.readings === 1 ? 'reading' : 'readings'}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** A usage total as people read it: a share of the summed limit for `%`, else used of limit in the unit. */
function usageText(u: UsageTotal): string {
  if (u.unit === '%') return u.limit > 0 ? `${Math.round((u.used / u.limit) * 100)}%` : '—';
  return `${u.used} of ${u.limit} ${u.unit}`;
}
