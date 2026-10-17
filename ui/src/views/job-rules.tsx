// Job rules (issue #172): what every job's prompt carries before its work tree and the protocol, edited
// whole (POST /ui/api/job-rules) against the version read; the next job to start gets them. While none
// are saved, jobs get the default, which is one click away. The work tree line and the protocol lines
// follow them and are not edited: the hopper reads the markers back. An unsaved edit is kept in this
// browser, so it survives a reload. A section of Settings. Below them, the repository job rules (issue #1472): a text per
// repository (`owner/name`) or owner (`owner/*`), told after the job rules to every job of it.
import { ListChecks, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import { readDraft, rulesEditor, type StoredDraft } from '@/model/question-gates';
import type { JobRulesView, RepoJobRulesView } from '@/model/wire';
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

type Row = { repo: string; text: string };

const REPO_NAME = /^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/;

/** The repository job rules (issue #1472): one row per repository or owner, saved whole against the version read. */
function RepoRules({ server, onSaved }: { server: RepoJobRulesView; onSaved: (v: RepoJobRulesView) => void }) {
  const authed = useCanAdmin();
  const [rows, setRows] = useState<Row[]>(server.repos);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(rows) !== JSON.stringify(server.repos);
  const bad = rows.find((r) => !REPO_NAME.test(r.repo.trim()));
  const set = (i: number, row: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...row } : r)));
  const save = async () => {
    setBusy(true);
    try {
      const repos = Object.fromEntries(rows.map((r) => [r.repo.trim(), r.text]));
      onSaved(await post<RepoJobRulesView>('/ui/api/repo-job-rules', { repos, version: server.version }));
      toast.success('Repository job rules saved; the next job of each repository gets them');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-slot="repo-job-rules" className="space-y-3">
      {rows.length === 0 && <div className="text-xs text-muted-foreground">None yet. Add a repository to tell its jobs what done means there, which tools they may use, and what to read first.</div>}
      {rows.map((r, i) => (
        <div key={i} className="space-y-1.5 rounded-md border p-2">
          <div className="flex items-center gap-2">
            <Input name="repo" className="font-mono text-xs" value={r.repo} readOnly={!authed} disabled={busy} placeholder="owner/name or owner/*"
              aria-invalid={!REPO_NAME.test(r.repo.trim())} onChange={(e) => set(i, { repo: e.target.value })} />
            {authed && <Button size="sm" variant="ghost" aria-label="Remove" disabled={busy} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 /></Button>}
          </div>
          <Textarea name="repo-rules" rows={4} className="font-mono text-xs" value={r.text} readOnly={!authed} disabled={busy}
            placeholder="One rule per line, for every job of this repository." onChange={(e) => set(i, { text: e.target.value })} />
        </div>
      ))}
      {bad && <div className="text-xs text-warn">Write each repository as owner/name, or owner/* for all of that owner&apos;s.</div>}
      <div className="flex flex-wrap items-center gap-2">
        {authed && <Button size="sm" variant="outline" disabled={busy} onClick={() => setRows([...rows, { repo: '', text: '' }])}><Plus /> Add a repository</Button>}
        {authed && <Button size="sm" disabled={busy || !dirty || bad !== undefined} onClick={() => void save()}>Save repository rules</Button>}
        {authed && dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRows(server.repos)}>Discard</Button>}
      </div>
    </div>
  );
}

export function JobRules() {
  const [view, setView] = useState<JobRulesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoJobRulesView | null>(null);
  useEffect(() => { get<JobRulesView>('/api/job-rules').then(setView, (e: Error) => setError(e.message)); }, []);
  useEffect(() => { get<RepoJobRulesView>('/api/repo-job-rules').then(setRepos, () => setRepos(null)); }, []);
  return (
    <div data-slot="job-rules">
      <Panel title="Job rules" icon={ListChecks} bodyClassName="space-y-5">
        {view ? (
          <>
            <section className="space-y-2">
              <h3 className="text-sm"><span className="font-medium">Rules</span><span className="text-muted-foreground"> — every job's prompt carries them; the next job to start gets an edit</span></h3>
              <Editor server={view} onSaved={setView} />
            </section>
            {repos && (
              <section className="space-y-2">
                <h3 className="text-sm"><span className="font-medium">Per repository</span><span className="text-muted-foreground"> — after the rules, every job of that repository, or of every repository of an owner (owner/*), gets them</span></h3>
                <RepoRules key={repos.version} server={repos} onSaved={setRepos} />
              </section>
            )}
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
