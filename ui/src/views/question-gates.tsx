// Question gates (issues #18, #134): the chain a question goes through — the escalation levels,
// lowest first (each answers or escalates to the next), the risk rules (code), the owner — with each
// level's instance and state from GET /api/plugins, the levels added, removed, reordered and tuned
// through the shared plugin form, and the rules edited whole (POST /ui/api/rules). An unsaved rules
// edit is kept in this browser, so it survives a reload. A section of Settings (issue #151).
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Empty, Panel } from '@/components/panel';
import { AddInstance, InstanceForm, pluginEditsUnsaved, sendPluginsEdit } from '@/components/plugin-form';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import { DRAFT_KEY, escalationMachineChoices, gateChain, readDraft, rulesEditor, RULES_MAX_BYTES, type Gate, type StoredDraft } from '@/model/question-gates';
import type { PluginsReport, QuestionGatesView, RulesView } from '@/model/wire';
import { refreshPlugins, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const REFRESH_MS = 15000;
const STAGE_TITLE: Record<Gate['stage'], string> = { level: 'Level', 'risk-rules': 'Risk rules', human: 'Owner' };

const loadStored = (): StoredDraft | undefined => { try { return readDraft(localStorage.getItem(DRAFT_KEY)); } catch { return undefined; } };
const keepStored = (d: StoredDraft | undefined) => {
  try { if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); else localStorage.removeItem(DRAFT_KEY); } catch { /* storage blocked: the draft lives until reload */ }
};

function Chain({ gates }: { gates: Gate[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-xs">
      {gates.map((g, i) => (
        <Fragment key={`${g.stage}:${g.name ?? ''}`}>
          {i > 0 && <ArrowRight aria-hidden className="size-3.5 text-muted-foreground" />}
          <li className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1">
            <span className="text-muted-foreground">{g.stage === 'level' && g.name ? `${STAGE_TITLE.level} ${i + 1}` : STAGE_TITLE[g.stage]}</span>
            {g.name && g.name !== STAGE_TITLE[g.stage] && <span className="font-medium">{g.name}</span>}
            <StatusBadge status={g.label} tone={g.tone} />
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function Stage({ n, title, what, children }: { n?: number; title: string; what: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm">{n !== undefined && <span className="num text-muted-foreground">{n} · </span>}<span className="font-medium">{title}</span><span className="text-muted-foreground"> — {what}</span></h3>
      {children}
    </section>
  );
}

function RulesEditorPanel({ server, onSaved }: { server: RulesView; onSaved: (v: RulesView) => void }) {
  const authed = useCanAdmin();
  const [stored, setStored] = useState<StoredDraft | undefined>(loadStored);
  const [busy, setBusy] = useState(false);
  const ed = rulesEditor(server, stored);
  const change = (text: string) => {
    const d = { text, base: ed.base };
    setStored(d);
    keepStored(d);
  };
  const discard = () => { setStored(undefined); keepStored(undefined); };
  const save = async () => {
    setBusy(true);
    try {
      const view = await post<RulesView>('/ui/api/rules', { text: ed.text, version: ed.base });
      discard();
      onSaved(view);
      toast.success('Rules saved; the next question reads them');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {server.missing && <StatusBadge status="missing — no standing rules" tone="warn" />}
        {ed.dirty && <StatusBadge status="unsaved" tone="warn" />}
      </div>
      <Textarea name="rules" rows={8} className="font-mono text-xs" value={ed.text} readOnly={!authed} disabled={busy}
        placeholder="One rule per line. Given to every escalation level with every question." onChange={(e) => change(e.target.value)} />
      {ed.stale && <div className="text-xs text-warn">The rules changed since this draft began; Save will be refused. Copy what you need, then Discard to load it.</div>}
      <div className="flex flex-wrap items-center gap-2">
        {authed && <Button size="sm" disabled={busy || !ed.dirty || ed.tooLarge} onClick={() => void save()}>Save rules</Button>}
        {authed && ed.dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>Discard</Button>}
        <span className={`num ml-auto text-xs ${ed.tooLarge ? 'text-bad' : 'text-muted-foreground'}`}>{(ed.bytes / 1024).toFixed(1)} of {RULES_MAX_BYTES / 1024} KiB</span>
      </div>
    </div>
  );
}

const SELECT = 'h-8 rounded-lg border border-input bg-transparent px-2 text-base md:text-sm dark:bg-input/30';

/**
 * The default escalation machine (issue #442): where a level that names no machine runs when the job's
 * machine cannot run claude and several machines can.
 */
function EscalationMachine({ report }: { report: PluginsReport }) {
  const authed = useCanAdmin();
  const [busy, setBusy] = useState(false);
  const choices = escalationMachineChoices(report);
  const current = report.escalationMachine ?? '';
  const set = async (machine: string) => {
    setBusy(true);
    await sendPluginsEdit({ action: 'escalation-machine', machine: machine || null, version: report.config.version }, machine ? `Default escalation machine: ${machine}` : 'No default escalation machine');
    setBusy(false);
  };
  return (
    <div data-slot="escalation-machine" className="flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor="escalation-machine" className="text-muted-foreground">Default escalation machine</label>
      <select id="escalation-machine" className={SELECT} value={current} disabled={!authed || busy} onChange={(e) => void set(e.target.value)}>
        <option value="">none</option>
        {choices.map((m) => <option key={m} value={m}>{m}</option>)}
        {current && !choices.includes(current) && <option value={current}>{current}</option>}
      </select>
      <span className="text-muted-foreground">for a level that names no machine, when the job's machine cannot run claude and several machines can</span>
    </div>
  );
}

export function QuestionGates() {
  const report = useHopper((s) => s.plugins);
  const pluginsError = useHopper((s) => s.pluginsError);
  const [gates, setGates] = useState<QuestionGatesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<QuestionGatesView>('/api/question-gates').then(setGates, (e: Error) => setError(e.message));
    void refreshPlugins();
    const t = setInterval(() => { if (!pluginEditsUnsaved()) void refreshPlugins(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const levels = report?.instances.filter((i) => i.role === 'escalation-level').map((i) => i.instance) ?? [];
  return (
    <div data-slot="question-gates">
      <Panel title="Question gates" icon={ShieldCheck} bodyClassName="space-y-3">
        {report && gates ? <Chain gates={gateChain(report, gates.riskRules.length)} /> : <Empty>{error ?? pluginsError ?? 'loading…'}</Empty>}
        <div className="space-y-5 pt-3">
          {gates && (
            <Stage title="Standing rules" what="given to every escalation level; read with every question">
              <RulesEditorPanel server={gates.rules} onSaved={(rules) => setGates({ ...gates, rules })} />
            </Stage>
          )}
          {report && (
            <Stage n={1} title="Escalation levels" what="lowest first: each answers the question or escalates it to the next; one that fails or cannot run escalates">
              <AddInstance role="escalation-level" />
              <EscalationMachine report={report} />
              {levels.length
                ? levels.map((inst) => <InstanceForm key={inst.name} role="escalation-level" inst={inst} />)
                : <div className="text-xs text-muted-foreground">none — questions go straight to the owner</div>}
            </Stage>
          )}
          {gates && (
            <Stage n={2} title="Risk rules" what="code, not configuration: a hit on an answer sends the question to the owner, whatever level gave it">
              <ul className="grid gap-1.5 text-xs sm:grid-cols-2">
                {gates.riskRules.map((r) => <li key={r.name} className="flex flex-wrap items-baseline gap-1.5"><StatusBadge status={r.name} tone="bad" /><span className="text-muted-foreground">{r.describe}</span></li>)}
              </ul>
            </Stage>
          )}
          <Stage n={3} title="Owner" what="above the top level: the last stop">
            <div className="text-xs text-muted-foreground">An escalated question waits above until you answer or close it.</div>
          </Stage>
        </div>
      </Panel>
    </div>
  );
}
