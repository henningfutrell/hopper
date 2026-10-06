// Job rules (issue #172): what every job's prompt carries before its work tree and the protocol, edited
// whole (POST /ui/api/job-rules) against the version read; the next job to start gets them. While none
// are saved, jobs get the default, which is one click away. The work tree line and the protocol lines
// follow them and are not edited: the hopper reads the markers back. An unsaved edit is kept in this
// browser, so it survives a reload. A section of Settings.
import { ListChecks } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import { readDraft, rulesEditor, type StoredDraft } from '@/model/question-gates';
import type { JobRulesView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

/** Matches JOB_RULES_MAX_BYTES in src/job-rules/index.ts; the daemon refuses more (400). */
const JOB_RULES_MAX_BYTES = 16 * 1024;
const DRAFT_KEY = 'jh_job_rules_draft';

const loadStored = (): StoredDraft | undefined => { try { return readDraft(localStorage.getItem(DRAFT_KEY)); } catch { return undefined; } };
const keepStored = (d: StoredDraft | undefined) => {
  try { if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); else localStorage.removeItem(DRAFT_KEY); } catch { /* storage blocked: the draft lives until reload */ }
};

function Editor({ server, onSaved }: { server: JobRulesView; onSaved: (v: JobRulesView) => void }) {
  const authed = useCanAdmin();
  const [stored, setStored] = useState<StoredDraft | undefined>(loadStored);
  const [busy, setBusy] = useState(false);
  const ed = rulesEditor(server, stored, JOB_RULES_MAX_BYTES);
  const change = (text: string) => {
    const d = { text, base: ed.base };
    setStored(d);
    keepStored(d);
  };
  const discard = () => { setStored(undefined); keepStored(undefined); };
  const save = async () => {
    setBusy(true);
    try {
      const view = await post<JobRulesView>('/ui/api/job-rules', { text: ed.text, version: ed.base });
      discard();
      onSaved(view);
      toast.success('Job rules saved; the next job to start gets them');
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
        {server.missing && <StatusBadge status="the default — none saved" tone="muted" />}
        {ed.dirty && <StatusBadge status="unsaved" tone="warn" />}
      </div>
      <Textarea name="job-rules" rows={10} className="font-mono text-xs" value={ed.text} readOnly={!authed} disabled={busy}
        placeholder="One rule per line. Empty: jobs get no rules but the work tree and the protocol." onChange={(e) => change(e.target.value)} />
      {ed.stale && <div className="text-xs text-warn">The job rules changed since this draft began; Save will be refused. Copy what you need, then Discard to load them.</div>}
      <div className="flex flex-wrap items-center gap-2">
        {authed && <Button size="sm" disabled={busy || !ed.dirty || ed.tooLarge} onClick={() => void save()}>Save job rules</Button>}
        {authed && ed.text !== server.default && <Button size="sm" variant="outline" disabled={busy} onClick={() => change(server.default)}>Use the default</Button>}
        {authed && ed.dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={discard}>Discard</Button>}
        <span className={`num ml-auto text-xs ${ed.tooLarge ? 'text-bad' : 'text-muted-foreground'}`}>{(ed.bytes / 1024).toFixed(1)} of {JOB_RULES_MAX_BYTES / 1024} KiB</span>
      </div>
    </div>
  );
}

export function JobRules() {
  const [view, setView] = useState<JobRulesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { get<JobRulesView>('/api/job-rules').then(setView, (e: Error) => setError(e.message)); }, []);
  return (
    <div data-slot="job-rules">
      <Panel title="Job rules" icon={ListChecks} bodyClassName="space-y-5">
        {view ? (
          <>
            <section className="space-y-2">
              <h3 className="text-sm"><span className="font-medium">Rules</span><span className="text-muted-foreground"> — every job's prompt carries them; the next job to start gets an edit</span></h3>
              <Editor server={view} onSaved={setView} />
            </section>
            <section className="space-y-2">
              <h3 className="text-sm"><span className="font-medium">Fixed</span><span className="text-muted-foreground"> — after the rules, not edited: the job's work tree, and the protocol the hopper reads back</span></h3>
              <ol data-slot="fixed-job-lines" className="space-y-1.5 rounded-md border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
                {view.fixed.map((line) => <li key={line} className="break-words">{line}</li>)}
              </ol>
            </section>
          </>
        ) : <Empty>{error ?? 'loading…'}</Empty>}
      </Panel>
    </div>
  );
}
