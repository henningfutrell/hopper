// Infra → Out-of-band changes (issues #871, #896, design.md "Out-of-band changes"): every infrastructure change the
// user's jobs' checks found that did not come through IaC or GitOps, newest first, with who, what, when and where it was
// found. An admin marks one adopted, reverted, or accepted with a reason, and sets the controller identities, whose
// writes are GitOps's. Tracking only: nothing here reverts a change. The page loads the changes (infra.tsx) and shows
// this panel always: an empty list says how a change gets here.
import { LogBlock } from '@/components/log-block';
import { Check, GitPullRequestArrow, Undo2, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { post, RoleRefused, SessionRejected } from '@/lib/api';
import { changeHeadline, changeState, controllersFrom, reportedBy } from '@/model/out-of-band';
import type { OutOfBandMark, OutOfBandView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

export type OutOfBandList = { changes: OutOfBandView[]; controllers: string[] };

const failed = (e: unknown): void => {
  if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
  toast.error(e instanceof RoleRefused ? 'Only an admin does this' : (e as Error).message);
};

function ChangeItem({ c, can, busy, mark }: { c: OutOfBandView; can: boolean; busy: boolean; mark: (id: string, m: OutOfBandMark['mark'], reason?: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const state = changeState(c);
  return (
    <li data-slot="out-of-band-change" className="space-y-1 rounded-md border p-3">
      <p className="text-sm break-words">{changeHeadline(c)}</p>
      <p className="text-xs text-muted-foreground">at {c.at}, {reportedBy(c)}, signal {c.key}</p>
      {c.detail && <LogBlock title="Detail" copy={c.detail} wrap contentClassName="max-h-40 text-xs">{c.detail}</LogBlock>}
      <p className={`text-xs ${state.kind === 'open' ? 'text-warn' : 'text-muted-foreground'}`}>{state.words}</p>
      {can && state.kind === 'open' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void mark(c.id, 'adopted')}><GitPullRequestArrow />Adopted</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void mark(c.id, 'reverted')}><Undo2 />Reverted</Button>
          <Input className="h-8 max-w-xs" placeholder="Why it stays out of git" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="sm" disabled={busy || !reason.trim()} onClick={() => void mark(c.id, 'accepted', reason)}><Check />Accept</Button>
        </div>
      )}
    </li>
  );
}

export function OutOfBandChanges({ view, onView }: { view: OutOfBandList; onView: (f: (v: OutOfBandList) => OutOfBandList) => void }) {
  const can = useCanAdmin();
  const [text, setText] = useState(view.controllers.join('\n'));
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try { await fn(); } catch (e) { failed(e); }
    setBusy(false);
  };
  const mark = (id: string, m: OutOfBandMark['mark'], reason?: string) => act(async () => {
    const { change } = await post<{ change: OutOfBandView }>('/ui/api/out-of-band', { action: 'mark', change: id, mark: m, ...(reason ? { reason } : {}) });
    onView((v) => ({ ...v, changes: v.changes.map((c) => (c.id === id ? change : c)) }));
    toast.success(`change ${id.slice(0, 8)} marked ${m}`);
  });
  const saveControllers = () => act(async () => {
    const { controllers } = await post<{ controllers: string[] }>('/ui/api/out-of-band', { action: 'controllers', identities: controllersFrom(text) });
    onView((v) => ({ ...v, controllers }));
    toast.success('controller identities saved');
  });
  const open = view.changes.filter((c) => !c.marked).length;
  return (
    <Panel title="Out-of-band changes" icon={ShieldAlert} count={open || ''} bodyClassName="space-y-3">
      <p className="text-sm text-muted-foreground">Infrastructure changes that did not come through IaC or GitOps: drift, and writes made by no controller identity and no credential minted for an approved plan. Each one is sent to the notifiers. Mark each one: adopted into git, reverted, or accepted with a reason. The hopper reverts nothing.</p>
      {view.changes.length === 0 && <Empty>No out-of-band changes. A job's read-only check reports what it finds with POST /job/infra-signals, an outside collector with POST /ui/api/out-of-band/signals; a change made by no controller identity and no credential minted for an approved plan shows here.</Empty>}
      {view.changes.length > 0 && <ul className="space-y-2">{view.changes.map((c) => <ChangeItem key={c.id} c={c} can={can} busy={busy} mark={mark} />)}</ul>}
      {can && (
        <div className="space-y-2">
          <p className="text-sm">Controller identities: the principals whose writes are GitOps's, one per line. A trailing * names a group.</p>
          <Textarea aria-label="Controller identities" placeholder="system:serviceaccount:argocd:*" value={text} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" disabled={busy || text === view.controllers.join('\n')} onClick={() => void saveControllers()}>Save</Button>
        </div>
      )}
    </Panel>
  );
}
