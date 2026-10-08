// The failure profile (issue #509), under the Failures view: failures per day over two weeks, the top signatures
// with their own trend — a recurring one flagged —, breakdowns by machine, repo and executor, and the known causes.
// An admin names a signature as a cause, with its default decision; the next failure of it follows that.
import { BookMarked, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { Sparkline } from '@/charts/sparkline';
import { Empty, Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { COLOR, StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DECISION_LABEL, plural } from '@/model/failures';
import type { FailureDecision, FailuresView, SignatureStat } from '@/model/wire';
import { failureAct } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const DECISIONS: FailureDecision[] = ['retry', 'hold', 'redirect', 'person'];

function Breakdown({ title, rows }: { title: string; rows: { key: string; count: number }[] }) {
  const top = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {rows.length ? rows.slice(0, 6).map((r) => (
        <div key={r.key} className="flex items-center gap-2 text-xs">
          <span className="w-24 shrink-0 truncate font-mono" title={r.key}>{r.key}</span>
          <span className="min-w-0 flex-1"><span className="block h-2 rounded-sm bg-bad/60" style={{ width: `${Math.max(4, (r.count / top) * 100)}%` }} /></span>
          <span className="num w-8 shrink-0 text-right text-muted-foreground">{r.count}</span>
        </div>
      )) : <div className="text-xs text-muted-foreground/70">none</div>}
    </div>
  );
}

function NameCause({ s }: { s: SignatureStat }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [decision, setDecision] = useState<FailureDecision>('hold');
  if (!open) return <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>Name</Button>;
  const save = async () => {
    if (await failureAct('/ui/api/failures/causes', { signature: s.signature, name: name.trim(), decision }, 'Cause named')) setOpen(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input className="h-7 w-44 text-xs" aria-label="Cause name" placeholder="Cause name" value={name} onChange={(e) => setName(e.target.value)} />
      <select className={`${FIELD} h-7 w-40 text-xs`} aria-label="Its decision" value={decision} onChange={(e) => setDecision(e.target.value as FailureDecision)}>
        {DECISIONS.map((d) => <option key={d} value={d}>{DECISION_LABEL[d]}</option>)}
      </select>
      <Button size="xs" disabled={name.trim() === ''} onClick={() => void save()}>Save</Button>
      <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </div>
  );
}

export function FailureProfilePanel({ view }: { view: FailuresView }) {
  const canAdmin = useCanAdmin();
  const p = view.profile;
  const total = p.days.reduce((n, d) => n + d.count, 0);
  const named = new Set(view.causes.filter((c) => !c.builtin).map((c) => c.id));
  return (
    <div data-section="failure-profile" className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <Panel title="Failure profile" icon={TrendingUp} count={`${total} in ${p.days.length} days`} bodyClassName="space-y-4">
        <Sparkline values={p.days.map((d) => d.count)} color={COLOR.bad} height={40} />
        {p.signatures.length ? (
          <ul className="divide-y text-sm">
            {p.signatures.map((s) => (
              <li key={s.signature} data-signature={s.signature} className="space-y-1 py-2">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 truncate" title={s.name}>{s.name}</span>
                  {s.general && <StatusBadge status="recurring" tone="bad" title="On enough jobs to be a general cause" />}
                  <span className="num shrink-0 text-xs text-muted-foreground">{s.count}× · {plural(s.jobs, 'job')} · {plural(s.machines, 'machine')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-32 shrink-0"><Sparkline values={s.trend} color={COLOR.bad} height={18} /></div>
                  <span className="font-mono text-[11px] text-muted-foreground">{s.signature}</span>
                  {canAdmin && !named.has(`named:${s.signature}`) && <span className="ml-auto"><NameCause s={s} /></span>}
                </div>
              </li>
            ))}
          </ul>
        ) : <Empty>no failure in {p.days.length} days</Empty>}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-1">
          <Breakdown title="By machine" rows={p.byMachine} />
          <Breakdown title="By repo" rows={p.byRepo} />
          <Breakdown title="By executor" rows={p.byExecutor} />
        </div>
      </Panel>
      <Panel title="Known causes" icon={BookMarked} count={view.causes.length} list bodyClassName="p-0">
        <ul className="divide-y text-sm">
          {view.causes.map((c) => (
            <li key={c.id} data-cause={c.id} className="space-y-1 px-4 py-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{c.name}</span>
                <StatusBadge status={c.decision} tone="muted" label={DECISION_LABEL[c.decision]} />
                {!c.builtin && <StatusBadge status="named" tone="ok" label="named" />}
                {!c.builtin && canAdmin && (
                  <Button size="xs" variant="ghost" className="ml-auto" onClick={() => void failureAct('/ui/api/failures/causes/forget', { signature: c.id.slice('named:'.length) }, 'Cause forgotten')}>Forget</Button>
                )}
              </div>
              {c.description && <div className="text-xs text-muted-foreground">{c.description}</div>}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
