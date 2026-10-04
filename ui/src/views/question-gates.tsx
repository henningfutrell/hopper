// Question gates (issue #18): the chain a question goes through — answerer (drafts), assessor
// (escalates or not), risk rules (code), owner — with each live stage's instance and state from
// GET /api/plugins, the answerer and assessor chosen and tuned through the shared plugin form, and
// the rules edited whole (POST /ui/api/rules). An unsaved rules edit is kept in this
// browser, so it survives a reload. Collapsed by default at phone width.
import { ArrowRight, ChevronRight, ShieldCheck } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import { Empty, Panel } from '@/components/panel';
import { InstanceForm, PluginSelector, pluginEditsUnsaved } from '@/components/plugin-form';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import { DRAFT_KEY, gateChain, readDraft, rulesEditor, RULES_MAX_BYTES, type Gate, type StoredDraft } from '@/model/question-gates';
import type { QuestionGatesView, RulesView } from '@/model/wire';
import { refreshPlugins, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const REFRESH_MS = 15000;
const STAGE_TITLE: Record<Gate['stage'], string> = { answerer: 'Answerer', assessor: 'Assessor', 'risk-rules': 'Risk rules', human: 'Owner' };

const loadStored = (): StoredDraft | undefined => { try { return readDraft(localStorage.getItem(DRAFT_KEY)); } catch { return undefined; } };
const keepStored = (d: StoredDraft | undefined) => {
  try { if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); else localStorage.removeItem(DRAFT_KEY); } catch { /* storage blocked: the draft lives until reload */ }
};
const wide = () => { try { return window.matchMedia('(min-width: 640px)').matches; } catch { return true; } };

function Chain({ gates }: { gates: Gate[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-xs">
      {gates.map((g, i) => (
        <Fragment key={g.stage}>
          {i > 0 && <ArrowRight aria-hidden className="size-3.5 text-muted-foreground" />}
          <li className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1">
            <span className="text-muted-foreground">{STAGE_TITLE[g.stage]}</span>
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
    const d = { document: server.document, text, base: ed.base };
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
        <code className="font-mono break-all">{server.document}</code>
        {server.missing && <StatusBadge status="missing — no standing rules" tone="warn" />}
        {ed.dirty && <StatusBadge status="unsaved" tone="warn" />}
      </div>
      <Textarea name="rules" rows={8} className="font-mono text-xs" value={ed.text} readOnly={!authed} disabled={busy}
        placeholder="One rule per line. Given to the answerer and the assessor with every question." onChange={(e) => change(e.target.value)} />
      {ed.stale && <div className="text-xs text-warn">The rules changed since this draft began; Save will be refused. Copy what you need, then Discard to load it.</div>}
      <div className="flex flex-wrap items-center gap-2">
        {authed && <Button size="sm" disabled={busy || !ed.dirty || ed.tooLarge} onClick={() => void save()}>Save rules</Button>}
        {authed && ed.dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>Discard</Button>}
        <span className={`num ml-auto text-xs ${ed.tooLarge ? 'text-bad' : 'text-muted-foreground'}`}>{(ed.bytes / 1024).toFixed(1)} of {RULES_MAX_BYTES / 1024} KiB</span>
      </div>
    </div>
  );
}

export function QuestionGates() {
  const report = useHopper((s) => s.plugins);
  const pluginsError = useHopper((s) => s.pluginsError);
  const [gates, setGates] = useState<QuestionGatesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(wide);
  useEffect(() => {
    get<QuestionGatesView>('/api/question-gates').then(setGates, (e: Error) => setError(e.message));
    void refreshPlugins();
    const t = setInterval(() => { if (!pluginEditsUnsaved()) void refreshPlugins(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const answerer = report?.instances.find((i) => i.role === 'answerer')?.instance;
  const assessor = report?.instances.find((i) => i.role === 'assessor')?.instance;
  return (
    <div data-slot="question-gates">
      <Panel title="Question gates" icon={ShieldCheck} bodyClassName="space-y-3">
        {report && gates ? <Chain gates={gateChain(report, gates.riskRules.length)} /> : <Empty>{error ?? pluginsError ?? 'loading…'}</Empty>}
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="group flex min-h-9 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />{open ? 'Hide' : 'Show'} the gates and the rules
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-5 pt-3">
            {gates && (
              <Stage title="Standing rules" what="rules.md, given to the answerer and the assessor; read with every question">
                <RulesEditorPanel server={gates.rules} onSaved={(rules) => setGates({ ...gates, rules })} />
              </Stage>
            )}
            {report && (
              <>
                <Stage n={1} title="Answerer" what="drafts an answer; none, or not confident, goes straight to the owner">
                  <PluginSelector role="answerer" />
                  {answerer ? <InstanceForm role="answerer" inst={answerer} /> : <div className="text-xs text-muted-foreground">none — questions go straight to the owner</div>}
                </Stage>
                <Stage n={2} title="Assessor" what="decides whether the owner must see the draft; fails closed">
                  <PluginSelector role="assessor" />
                  {assessor && <InstanceForm role="assessor" inst={assessor} />}
                </Stage>
              </>
            )}
            {gates && (
              <Stage n={3} title="Risk rules" what="code, not configuration: a hit sends the question to the owner, whatever the assessor said">
                <ul className="grid gap-1.5 text-xs sm:grid-cols-2">
                  {gates.riskRules.map((r) => <li key={r.name} className="flex flex-wrap items-baseline gap-1.5"><StatusBadge status={r.name} tone="bad" /><span className="text-muted-foreground">{r.describe}</span></li>)}
                </ul>
              </Stage>
            )}
            <Stage n={4} title="Owner" what="the last stop">
              <div className="text-xs text-muted-foreground">An escalated question waits above until you answer or close it.</div>
            </Stage>
          </CollapsibleContent>
        </Collapsible>
      </Panel>
    </div>
  );
}
