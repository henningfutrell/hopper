// Decider calls (issue #550): bounded choices Jev makes first, before an escalation level, a model or a person. In
// Settings, the configuration: whether Jev can be asked now; per decision point its mode and threshold (an admin's, saved
// to the daemon, applied from the next decision) and its record over the window — asked, applied, the agreement rate a
// person flips it to active on. On Decisions, the one home of the picks (issue #897): the newest, each with its options,
// what Jev picked and how sure, what became of it and what was decided, and Override (an operator's): what it should have
// been, which counts in the agreement rate. A pick is the one question form (issue #1169): its options are the choices, and
// who decided is a marker.
// The TypeSafe API key Jev asks with (issue #657), right under whether Jev is on: write-only — set or not, its last 4
// characters, when —, with Replace and Remove (an operator's: the user's own, or an admin's); a new key is checked once
// against TypeSafe before it is kept. Saving it needs Access (OpenFGA): while OpenFGA is not running, Save and Remove are
// off with that reason, and a save refused for it says the other settings are unchanged (issue #696).
import { KeyRound, Scale } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Empty, Panel } from '@/components/panel';
import { AnsweredBy, QuestionForm } from '@/components/question-form';
import { FIELD } from '@/components/plugin-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePoll } from '@/hooks/use-poll';
import { AccessFix, useAccessStatus } from '@/app/access';
import { get, post } from '@/lib/api';
import { ACCESS_SAVE_FAILED, accessDown, saveError } from '@/model/access-status';
import { clock } from '@/model/format';
import { pickSource } from '@/model/answer-source';
import { environmentNote, keyStatus, MODE_TEXT, pickAgreement, pickSummary, rate } from '@/model/minor-decisions';
import type { DecisionPointView, MinorDecisionMode, MinorDecisionPickView, MinorDecisionsView, TypesafeKeyView } from '@/model/wire';
import { useCanAdmin, useCanOperate, useJobName } from '@/store/selectors';

const MODES: MinorDecisionMode[] = ['off', 'shadow', 'active'];
const POLL_MS = 10_000;

function Point({ p, onSaved }: { p: DecisionPointView; onSaved: () => void }) {
  const admin = useCanAdmin();
  const [mode, setMode] = useState(p.mode);
  const [threshold, setThreshold] = useState(String(Math.round(p.threshold * 100)));
  const [busy, setBusy] = useState(false);
  const t = Number(threshold) / 100;
  const changed = mode !== p.mode || t !== p.threshold;
  const save = async () => {
    setBusy(true);
    try {
      await post(`/ui/api/minor-decisions/points/${p.point}`, { mode, threshold: t });
      toast.success(`${p.label}: saved`);
      onSaved();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };
  return (
    <div data-point={p.point} className="space-y-2 border-b pb-3 last:border-b-0 last:pb-0">
      <div>
        <div className="text-sm font-medium">{p.label}</div>
        <p className="text-xs text-muted-foreground">{p.describe}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Mode</span>
          <select className={`${FIELD} h-8 w-60 text-sm`} aria-label={`${p.label}: mode`} value={mode} disabled={!admin || busy}
            onChange={(e) => setMode(e.target.value as MinorDecisionMode)}>
            {MODES.map((m) => <option key={m} value={m}>{MODE_TEXT[m]}</option>)}
          </select></label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Confidence needed (%)</span>
          <Input type="number" min={0} max={100} className="h-8 w-28" aria-label={`${p.label}: confidence needed`} value={threshold} disabled={!admin || busy}
            onChange={(e) => setThreshold(e.target.value)} /></label>
        {admin && <Button size="sm" disabled={busy || !changed || !(t >= 0 && t <= 1)} onClick={() => void save()}>Save</Button>}
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
        {([['Asked', p.asked], ['Picked', p.picked], ['Applied', p.applied], ['Compared', p.compared], ['Agreement', rate(p.agreement)], ['Overridden', p.overridden]] as const).map(([k, v]) => (
          <div key={k}><dt className="text-muted-foreground">{k}</dt><dd className="num font-medium" data-figure={k}>{v}</dd></div>
        ))}
      </dl>
    </div>
  );
}

/** The TypeSafe API key: write-only. The value typed is sent once and cleared; it is never shown again. `accessDown`: why OpenFGA cannot be asked. */
export function TypesafeKeyField({ k, onSaved, accessDown }: { k: TypesafeKeyView; onSaved: () => void; accessDown?: string }) {
  const canAct = useCanOperate();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  const send = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setFailed(undefined);
    try {
      await post('/ui/api/typesafe-key', body);
      toast.success(done);
      setValue('');
      onSaved();
    } catch (e) {
      const why = saveError((e as Error).message);
      setFailed(why);
      toast.error(why);
    }
    setBusy(false);
  };
  const note = environmentNote(k);
  const off = busy || accessDown !== undefined;
  return (
    <div data-typesafe-key={k.set ? 'set' : 'not-set'} className="space-y-2 border-b pb-3">
      <div className="flex items-center gap-2 text-sm font-medium"><KeyRound className="size-4" />TypeSafe API key</div>
      <p className="text-sm" data-key-status>{keyStatus(k)}</p>
      {k.problem && <p className="text-xs text-destructive">{k.problem}</p>}
      {note && <p className="text-xs text-muted-foreground" data-key-note>{note}</p>}
      {canAct && accessDown !== undefined && (
        <div data-key-access className="space-y-1">
          <p className="text-xs text-destructive">Saving the key needs hopper's access service (OpenFGA), which isn't running: {accessDown}</p>
          <AccessFix />
        </div>
      )}
      {canAct && (
        <div className="flex flex-wrap items-center gap-2">
          <Input type="password" autoComplete="off" spellCheck={false} className="h-8 w-80" aria-label="TypeSafe API key" placeholder={k.set ? 'a new key, to replace it' : 'paste the key'}
            value={value} disabled={off} onChange={(e) => setValue(e.target.value)} />
          <Button size="sm" disabled={off || !value.trim()} onClick={() => void send({ action: 'set', value }, 'TypeSafe API key checked and saved')}>{k.set ? 'Replace' : 'Save'}</Button>
          {k.set && <Button size="sm" variant="outline" disabled={off} onClick={() => void send({ action: 'remove' }, 'TypeSafe API key removed')}>Remove</Button>}
        </div>
      )}
      {failed && (
        <div data-key-failed className="space-y-1">
          <p className="text-xs text-destructive">{failed}</p>
          {failed === ACCESS_SAVE_FAILED && <AccessFix />}
        </div>
      )}
    </div>
  );
}

function PickRow({ p, label, onSaved }: { p: MinorDecisionPickView; label: string; onSaved: () => void }) {
  const canAct = useCanOperate();
  const [actual, setActual] = useState(p.actual ?? p.pick ?? p.options[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const nameOf = useJobName();
  const override = async () => {
    setBusy(true);
    try {
      await post(`/ui/api/minor-decisions/picks/${p.pickId}/override`, { actual });
      toast.success('Override recorded');
      onSaved();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };
  const agreement = pickAgreement(p);
  return (
    <li data-pick={p.pickId} className="space-y-1 border-b py-2 text-xs last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="num font-mono text-muted-foreground" title={p.at}>{clock(p.at)}</span>
        <span className="font-medium">{label}</span>
        {p.jobId && <span className="min-w-0 truncate text-muted-foreground">{nameOf(p.jobId)}</span>}
        {p.machineId && <span className="min-w-0 truncate text-muted-foreground">machine {p.machineId}</span>}
      </div>
      <div>{pickSummary(p)}</div>
      <AnsweredBy source={pickSource(p)} />
      {agreement && <div className="text-muted-foreground">{agreement}</div>}
      {canAct && p.options.length > 0 && (
        <QuestionForm name="override" title="What it should have been" busy={busy} picked={actual} onPick={setActual}
          choices={p.options.map((o) => ({ value: o.id, label: o.label }))} submit="Override" canSubmit onSubmit={() => void override()} />
      )}
    </li>
  );
}

/** Read when shown, again every 10 seconds; `reload` reads now. */
function useMinorDecisions(): { view: MinorDecisionsView | undefined; reload: () => void } {
  const [view, setView] = useState<MinorDecisionsView | undefined>();
  const load = useCallback(async () => setView(await get<MinorDecisionsView>('/api/minor-decisions')), []);
  usePoll(load, POLL_MS);
  return { view, reload: () => { load().catch(() => {}); } };
}

/** Settings → Decider: the configuration only. The picks are on Decisions. */
export function MinorDecisions() {
  const { view, reload } = useMinorDecisions();
  const access = accessDown(useAccessStatus());
  if (!view) return <Panel title="Decider" icon={Scale}><Empty>loading</Empty></Panel>;
  return (
    <Panel title="Decider" icon={Scale}>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Jev makes bounded decisions first, before a model or a person. In shadow it only records what it would pick, next
          to what was decided; active, a pick it is sure enough of is applied. Anything that deletes, sends, publishes, pays, changes
          permissions or runs on a gated machine always goes on to the next step. Figures over the last {view.windowDays} days.
        </p>
        <p data-jev={view.jev.available ? 'on' : 'off'} className="text-sm">
          {view.jev.available ? 'Jev is on.' : `${view.jev.why ?? 'Jev is off'}. Each decision is made as before.`}
        </p>
        <p className="text-sm">Each pick, with Override, is on <a className="underline" href="#activity/decisions">Decisions</a>.</p>
        <TypesafeKeyField k={view.typesafeKey} onSaved={reload} {...(access !== undefined ? { accessDown: access } : {})} />
        {view.points.map((p) => <Point key={`${p.point}:${p.mode}:${p.threshold}`} p={p} onSaved={reload} />)}
      </div>
    </Panel>
  );
}

/** On Decisions (issue #897): the decider's newest picks, each with Override. Always shown, and says what will show when empty. */
export function DeciderPicks() {
  const { view, reload } = useMinorDecisions();
  const labelOf = (point: string) => view?.points.find((p) => p.point === point)?.label ?? point;
  return (
    <div data-decider-picks>
      <Panel title="Decider picks" icon={Scale} count={view?.recent.length || ''}
        action={<a href="#settings/decider" className="text-xs underline underline-offset-2">Decider settings</a>}>
        {!view ? <Empty>loading</Empty> : view.recent.length ? (
          <ul>{view.recent.map((p) => <PickRow key={`${p.pickId}:${p.actual ?? ''}`} p={p} label={labelOf(p.point)} onSaved={reload} />)}</ul>
        ) : <Empty>No decider pick yet. Each bounded choice Jev makes shows here, with what was decided, and Override to say what it should have been.</Empty>}
      </Panel>
    </div>
  );
}
