// The plan store's parts of the Planned work tab (issue #2861): the kept work plans as a list, the import of a plan from an
// issue's sub-issues, a plan's sync (GitHub, or off: only the store has it), and its plan artifacts — each a record, added
// with its type and ref on a plan piece or plan task, and removed one by one. Every write is a POST /ui/api/planned-work/*.
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { TEXT } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post } from '@/lib/api';
import { cn } from '@/lib/utils';
import { artifactsOf, planHash, STATUS_INFO } from '@/model/planned-work';
import type { PlanArtifactType, WorkPlan, WorkPlanSummary } from '@/model/wire';
import { useCanOperate } from '@/store/selectors';

const TYPES: readonly PlanArtifactType[] = ['link', 'screenshot', 'report', 'pull_request'];

/** Import a work plan from an issue: the store keeps it, and the hash opens it. */
export function ImportPlan({ issue, onError }: { issue: string; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (!useCanOperate()) return null;
  const go = () => {
    setBusy(true);
    post<WorkPlan>('/ui/api/planned-work/import', { issue })
      .then((p) => { window.location.hash = planHash(p.id); }, (e: Error) => onError(e.message)).finally(() => setBusy(false));
  };
  return <Button type="button" size="sm" variant="outline" disabled={busy || !issue.trim()} onClick={go} data-slot="planned-work-import">Import from GitHub</Button>;
}

/** The kept work plans, each a link to its graph. */
export function PlanList() {
  const [plans, setPlans] = useState<WorkPlanSummary[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    get<{ plans: WorkPlanSummary[] }>('/api/planned-work/plans')
      .then((r) => { if (live) setPlans(Array.isArray(r.plans) ? r.plans : []); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);
  if (error) return <p data-slot="planned-work-error" className={cn('px-4 pt-3 text-sm', TEXT.bad)}>{error}</p>;
  if (!plans) return <Empty>reading the kept work plans…</Empty>;
  if (plans.length === 0) return <Empty>No work plan is kept yet. Name an issue and import it: its sub-issues are its plan pieces, and theirs its plan tasks.</Empty>;
  return (
    <ul data-slot="planned-work-plans" className="divide-y text-sm">
      {plans.map((p) => (
        <li key={p.id} data-slot="planned-work-plan" data-plan-id={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
          <a href={planHash(p.id)} className="font-medium hover:underline">{p.title}</a>
          <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
          <span className={TEXT[STATUS_INFO[p.status].tone]}>{STATUS_INFO[p.status].label}</span>
          <span className="text-xs text-muted-foreground">{p.pieces} pieces · {p.tasks} tasks · sync {p.sync === 'github' ? 'from GitHub' : 'off'}</span>
        </li>
      ))}
    </ul>
  );
}

/** The plan's sync: GitHub (sync now, or turn it off), or off (turn it on). */
export function PlanSyncControl({ plan, onPlan, onError }: { plan: WorkPlan; onPlan: (p: WorkPlan) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const canOperate = useCanOperate();
  const send = (body: { sync?: 'github' | 'off' }) => {
    setBusy(true);
    post<WorkPlan>('/ui/api/planned-work/sync', { plan: plan.id, ...body }).then(onPlan, (e: Error) => onError(e.message)).finally(() => setBusy(false));
  };
  return (
    <div data-slot="planned-work-sync" data-sync={plan.sync} className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
      <span>{plan.sync === 'github' ? 'Sync from GitHub sub-issues: on' : 'Sync from GitHub: off — only the plan store has this plan'}
        {plan.syncedAt ? ` · last sync ${new Date(plan.syncedAt).toLocaleString()}` : ''}</span>
      {canOperate && (plan.sync === 'github'
        ? <><Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => send({})} data-slot="planned-work-sync-now">Sync now</Button>
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => send({ sync: 'off' })} data-slot="planned-work-sync-off">Turn sync off</Button></>
        : <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => send({ sync: 'github' })} data-slot="planned-work-sync-on">Turn sync on</Button>)}
    </div>
  );
}

/** The plan's artifacts, each removable, and a form that adds one to a plan piece or a plan task. */
export function PlanArtifacts({ plan, onChange, onError }: { plan: WorkPlan; onChange: () => void; onError: (m: string) => void }) {
  const canOperate = useCanOperate();
  const [piece, setPiece] = useState(plan.pieces[0]?.id ?? '');
  const [task, setTask] = useState('');
  const [type, setType] = useState<PlanArtifactType>('link');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const all = artifactsOf(plan);
  const tasks = plan.pieces.find((p) => p.id === piece)?.tasks ?? [];
  const act = (path: string, body: unknown, after?: () => void) => {
    setBusy(true);
    post(path, body).then(() => { after?.(); onChange(); }, (e: Error) => onError(e.message)).finally(() => setBusy(false));
  };
  return (
    <section data-slot="planned-work-artifacts" className="space-y-2 border-t pt-3 text-sm">
      <h3 className="text-xs font-medium text-muted-foreground">Plan artifacts</h3>
      {all.length === 0 ? <p className="text-xs text-muted-foreground">No artifact is kept for this plan.</p> : (
        <ul className="space-y-1">
          {all.map((a) => (
            <li key={a.id} data-slot="planned-work-artifact" data-artifact-id={a.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded border px-1.5 font-mono">{a.type}</span>
              {/^https?:\/\//.test(a.ref) ? <a href={a.ref} target="_blank" rel="noopener noreferrer" className="hover:underline">{a.ref}</a> : <span className="font-mono">{a.ref}</span>}
              <span className="text-muted-foreground">on {a.task ?? a.piece}{a.source === 'sync' ? ' · from its job' : a.by ? ` · by ${a.by}` : ''}</span>
              {canOperate && <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove artifact ${a.ref}`} disabled={busy}
                onClick={() => act('/ui/api/planned-work/artifacts/remove', { plan: plan.id, id: a.id })}><Trash2 /></Button>}
            </li>
          ))}
        </ul>
      )}
      {canOperate && (
        <form data-slot="planned-work-artifact-add" className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
          e.preventDefault();
          act('/ui/api/planned-work/artifacts', { plan: plan.id, piece, ...(task ? { task } : {}), type, ref: ref.trim() }, () => setRef(''));
        }}>
          <select name="piece" aria-label="Plan piece" className={cn(FIELD, 'w-40')} value={piece} onChange={(e) => { setPiece(e.target.value); setTask(''); }}>
            {plan.pieces.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
          </select>
          <select name="task" aria-label="Plan task" className={cn(FIELD, 'w-40')} value={task} onChange={(e) => setTask(e.target.value)}>
            <option value="">the piece itself</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
          </select>
          <select name="type" aria-label="Artifact type" className={cn(FIELD, 'w-32')} value={type} onChange={(e) => setType(e.target.value as PlanArtifactType)}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <Input name="ref" aria-label="Artifact URL or id" placeholder="URL or hopper artifact id" value={ref} onChange={(e) => setRef(e.target.value)} className="h-8 w-64" />
          <Button type="submit" size="sm" variant="outline" disabled={busy || !ref.trim() || !piece}>Add artifact</Button>
        </form>
      )}
    </section>
  );
}
