// Skills (issue #1911, design.md "The Skills page"): the skill library's own top-level view. Work skills: which library
// skill each kind of work gets, for every repository and per repository (POST /ui/api/work-skills; the next job gets a
// change, never a running one). Library: each skill with its source and version; a person creates one, edits one of their
// own (a new version), duplicates any one to change it, removes one no setting names, imports one from a folder of a GitHub
// repository, or refreshes an imported one (skill-library.tsx). The page reads
// GET /api/skill-library once, and each change answers the new view. Loading, an error with Try again, or the list.
import { BookOpen, Download, Plus, RefreshCw, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get } from '@/lib/api';
import { KIND_LABEL, kindRows, repoRows } from '@/model/skills';
import { useCanAdmin } from '@/store/selectors';
import type { SkillLibraryView, WorkKind } from '../../../src/domain/skill-library.ts';
import { changeLibrary, LibrarySkill, SkillEditor, SkillImport } from './skill-library';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; view: SkillLibraryView };

/** A choice of skill for one kind of work: '' is the next setting down. */
function KindSelect({ view, kind, value, fallback, disabled, onPick }: {
  view: SkillLibraryView; kind: WorkKind; value: string | undefined; fallback: string; disabled: boolean; onPick: (name: string | null) => void;
}) {
  return (
    <select name={`work-skill-${kind}`} aria-label={KIND_LABEL[kind]} className={FIELD} value={value ?? ''} disabled={disabled}
      onChange={(e) => onPick(e.target.value === '' ? null : e.target.value)}>
      <option value="">{fallback}</option>
      {view.skills.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
    </select>
  );
}

const REPO = /^[^/\s]+\/[^/\s]+$/;

function WorkSkills({ view, onChange }: { view: SkillLibraryView; onChange: (v: SkillLibraryView) => void }) {
  const authed = useCanAdmin();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const choose = async (body: unknown) => {
    setBusy(true);
    const ok = await changeLibrary('/ui/api/work-skills', body, onChange, 'Work skills saved; the next job gets them');
    setBusy(false);
    return ok;
  };
  const defaults = kindRows(view);
  const newRepo = adding?.trim().toLowerCase() ?? '';
  return (
    <Panel title="Work skills" icon={Workflow} bodyClassName="space-y-4">
      <p className="text-xs text-muted-foreground">Each job gets the skill of its kind of work when it first starts, and keeps that version. A repository&apos;s choice wins over the choice for every repository; with none, a job gets the built-in default.</p>
      <div data-slot="kind-work-skills" className="grid gap-2 sm:grid-cols-3">
        {defaults.map((r) => (
          <label key={r.kind} className="space-y-1 text-xs">
            <span className="font-medium">{r.label}</span>
            <KindSelect view={view} kind={r.kind} value={r.setting} fallback={`the default: ${view.defaults[r.kind]}`} disabled={!authed || busy}
              onPick={(name) => void choose({ kinds: { [r.kind]: name } })} />
          </label>
        ))}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm"><span className="font-medium">Per repository</span><span className="text-muted-foreground"> — wins over the choice above</span></h3>
        {repoRows(view).length === 0 && adding === null && <div className="text-xs text-muted-foreground">No repository has a choice of its own.</div>}
        {repoRows(view).map(({ repo, choice }) => (
          <div key={repo} data-slot="repo-work-skills" data-repo={repo} className="grid items-center gap-2 sm:grid-cols-[12rem_repeat(3,minmax(0,1fr))]">
            <span className="truncate font-mono text-xs" title={repo}>{repo}</span>
            {view.kinds.map((k) => (
              <KindSelect key={k} view={view} kind={k} value={choice[k]} fallback={`as every repository: ${defaults.find((d) => d.kind === k)!.gets}`} disabled={!authed || busy}
                onPick={(name) => void choose({ repos: { [repo]: { [k]: name } } })} />
            ))}
          </div>
        ))}
        {adding !== null && (
          <div data-slot="new-repo-work-skills" className="grid items-center gap-2 sm:grid-cols-[12rem_repeat(3,minmax(0,1fr))]">
            <Input name="new-repo" className="font-mono text-xs" value={adding} placeholder="owner/name" aria-invalid={adding !== '' && !REPO.test(newRepo)} disabled={busy}
              onChange={(e) => setAdding(e.target.value)} />
            {view.kinds.map((k) => (
              <KindSelect key={k} view={view} kind={k} value={undefined} fallback={KIND_LABEL[k]} disabled={busy || !REPO.test(newRepo)}
                onPick={(name) => { if (name) void choose({ repos: { [newRepo]: { [k]: name } } }).then((ok) => { if (ok) setAdding(null); }); }} />
            ))}
          </div>
        )}
        {authed && adding === null && <Button size="sm" variant="outline" disabled={busy} onClick={() => setAdding('')}><Plus /> Add a repository</Button>}
      </div>
    </Panel>
  );
}

export function Skills() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const authed = useCanAdmin();
  useEffect(() => {
    let live = true;
    get<SkillLibraryView>('/api/skill-library').then((view) => { if (live) setLoad({ kind: 'ok', view }); }, (e: Error) => { if (live) setLoad({ kind: 'error', message: e.message }); });
    return () => { live = false; };
  }, [round]);
  const set = (view: SkillLibraryView) => setLoad({ kind: 'ok', view });
  if (load.kind !== 'ok') {
    return (
      <div data-slot="skills">
        <Panel title="Skills" icon={BookOpen}>
          {load.kind === 'loading' ? <Empty>loading…</Empty> : (
            <Empty>
              <span className="block">The skill library could not be read: {load.message}</span>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => { setLoad({ kind: 'loading' }); setRound((n) => n + 1); }}><RefreshCw /> Try again</Button>
            </Empty>
          )}
        </Panel>
      </div>
    );
  }
  const { view } = load;
  return (
    <div data-slot="skills" className="space-y-4">
      <WorkSkills view={view} onChange={set} />
      <Panel title="Library" icon={BookOpen} count={view.skills.length} bodyClassName="space-y-3"
        action={authed && (
          <div className="flex gap-1">
            {!importing && <Button size="sm" variant="outline" onClick={() => setImporting(true)}><Download /> Import</Button>}
            {!creating && <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus /> New skill</Button>}
          </div>
        )}>
        {importing && <SkillImport onSaved={set} onCancel={() => setImporting(false)} />}
        {creating && <SkillEditor mode="create" onSaved={(v) => { set(v); setCreating(false); }} onCancel={() => setCreating(false)} />}
        {view.skills.map((s) => <LibrarySkill key={s.name} view={view} skill={s} onChange={set} />)}
      </Panel>
    </div>
  );
}
