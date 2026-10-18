// The Library panel of the Skills page (issue #1911, design.md "The Skills page"): one library skill — its name, source,
// version and description, its files on demand — and what a person does to it: Edit one of their own (a new version, the
// name stays), Duplicate any one under a new name (a built-in one is changed this way), Remove one of their own after a
// confirm, which no setting may name; Refresh an imported one from its repository. The editor writes a skill's files: a
// SKILL.md and the text files beside it. The import form names a folder of a GitHub repository to import a skill from.
import { Copy, Download, FileText, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { get, post, SessionRejected } from '@/lib/api';
import { draftFiles, draftProblem, draftRows, newSkillFiles, settingsNaming, shortVersion, SKILL_FILE, sourceLine, type DraftFile } from '@/model/skills';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';
import type { LibrarySkillSummary, LibrarySkillVersion, SkillLibraryView } from '../../../src/domain/skill-library.ts';

/** A change to the library or the settings: the daemon answers the new view; a refusal is said in a toast. */
export async function changeLibrary(path: string, body: unknown, done: (v: SkillLibraryView) => void, said: string): Promise<boolean> {
  try {
    done(await post<SkillLibraryView>(path, body));
    toast.success(said);
    return true;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false });
    toast.error((e as Error).message);
    return false;
  }
}

const readSkill = (name: string) => get<{ skill: LibrarySkillVersion }>(`/api/skill-library/${encodeURIComponent(name)}`).then((r) => r.skill);

/** Writes a new skill (`create`) or a new version of one of the user's own (`edit`, the name fixed). */
export function SkillEditor({ mode, name: from = '', files, onSaved, onCancel }: {
  mode: 'create' | 'edit'; name?: string; files?: Record<string, string>; onSaved: (v: SkillLibraryView) => void; onCancel: () => void;
}) {
  const [name, setName] = useState(from);
  const [rows, setRows] = useState<DraftFile[]>(() => draftRows(files ?? newSkillFiles('')));
  const [busy, setBusy] = useState(false);
  const problem = draftProblem(name, rows);
  const set = (i: number, row: Partial<DraftFile>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...row } : r)));
  const rename = (next: string) => {
    // A new skill's SKILL.md still as it began follows its name.
    if (mode === 'create') setRows(rows.map((r) => (r.path === SKILL_FILE && r.text === newSkillFiles(name)[SKILL_FILE] ? { ...r, text: newSkillFiles(next)[SKILL_FILE]! } : r)));
    setName(next);
  };
  const save = async () => {
    setBusy(true);
    const ok = await changeLibrary('/ui/api/skill-library', { action: mode, name, files: draftFiles(rows) }, onSaved,
      mode === 'create' ? `Skill ${name} made` : `A new version of ${name} kept; the next job that gets it gets this one`);
    setBusy(false);
    if (ok) onCancel();
  };
  return (
    <div data-slot="skill-editor" className="space-y-2 rounded-md border p-3">
      <Input name="skill-name" className="font-mono text-xs" value={name} placeholder="skill-name" disabled={mode === 'edit' || busy} onChange={(e) => rename(e.target.value)} />
      {rows.map((r, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center gap-2">
            <Input name="skill-file-path" className="font-mono text-xs" value={r.path} placeholder="path/in/the/skill.md" disabled={busy} onChange={(e) => set(i, { path: e.target.value })} />
            <Button size="sm" variant="ghost" aria-label={`Remove ${r.path || 'this file'}`} disabled={busy} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 /></Button>
          </div>
          <Textarea name="skill-file-text" rows={r.path === SKILL_FILE ? 12 : 5} className="font-mono text-xs" value={r.text} disabled={busy} onChange={(e) => set(i, { text: e.target.value })} />
        </div>
      ))}
      {problem && <div className="text-xs text-warn">{problem}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setRows([...rows, { path: '', text: '' }])}><Plus /> Add a file</Button>
        <Button size="sm" disabled={busy || problem !== undefined} onClick={() => void save()}>Save skill</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

type Open = { kind: 'none' } | { kind: 'files' | 'edit'; files?: Record<string, string>; error?: string } | { kind: 'duplicate'; name: string };

/** One library skill, and what a person does to it. */
export function LibrarySkill({ view, skill, onChange }: { view: SkillLibraryView; skill: LibrarySkillSummary; onChange: (v: SkillLibraryView) => void }) {
  const authed = useCanAdmin();
  const [open, setOpen] = useState<Open>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const named = settingsNaming(view, skill.name);
  const read = (kind: 'files' | 'edit') => {
    setOpen({ kind });
    readSkill(skill.name).then((s) => setOpen({ kind, files: s.files }), (e: Error) => setOpen({ kind, error: e.message }));
  };
  const act = async (body: unknown, said: string) => {
    setBusy(true);
    const ok = await changeLibrary('/ui/api/skill-library', body, onChange, said);
    setBusy(false);
    if (ok) setOpen({ kind: 'none' });
  };
  const { latest } = skill;
  return (
    <div data-slot="library-skill" data-name={skill.name} className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono font-medium">{skill.name}</span>
        <StatusBadge status={sourceLine(latest)} tone={skill.builtIn ? 'muted' : 'ok'} />
        <span className="num font-mono text-xs text-muted-foreground" title={latest.version}>{shortVersion(latest.version)}</span>
        <span className="text-xs text-muted-foreground">{skill.versions === 1 ? '1 version' : `${skill.versions} versions`}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => (open.kind === 'files' ? setOpen({ kind: 'none' }) : read('files'))}><FileText /> {open.kind === 'files' ? 'Hide files' : 'Show files'}</Button>
          {authed && !skill.builtIn && <Button size="sm" variant="ghost" disabled={busy} onClick={() => read('edit')}><Pencil /> Edit</Button>}
          {authed && latest.source.kind === 'imported' && (
            <Button size="sm" variant="ghost" disabled={busy} title={`Read ${latest.source.repo} at ${latest.source.ref} again`}
              onClick={() => void act({ action: 'refresh', name: skill.name }, `Skill ${skill.name} refreshed; a new version only when its files changed`)}><RefreshCw /> Refresh</Button>
          )}
          {authed && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen({ kind: 'duplicate', name: `${skill.name}-copy` })}><Copy /> Duplicate</Button>}
          {authed && !skill.builtIn && (named.length > 0
            ? <Button size="sm" variant="ghost" disabled title="A work skill setting names it"><Trash2 /> Remove</Button>
            : (
              <Confirm title={`Remove ${skill.name}?`} description="No new job gets it. Jobs that got it keep their version." action="Remove"
                onConfirm={() => void act({ action: 'remove', name: skill.name }, `Skill ${skill.name} removed`)}>
                <Button size="sm" variant="ghost" disabled={busy}><Trash2 /> Remove</Button>
              </Confirm>
            ))}
        </div>
      </div>
      {skill.description && <p className="text-xs text-muted-foreground">{skill.description}</p>}
      {named.length > 0 && <p className="text-xs text-muted-foreground">Chosen for {named.join('; ')}.</p>}
      {open.kind === 'duplicate' && (
        <div className="flex flex-wrap items-center gap-2">
          <Input name="duplicate-name" className="max-w-xs font-mono text-xs" value={open.name} disabled={busy} onChange={(e) => setOpen({ kind: 'duplicate', name: e.target.value })} />
          <Button size="sm" disabled={busy} onClick={() => void act({ action: 'duplicate', from: skill.name, version: latest.version, name: open.name }, `Skill ${open.name} made from ${skill.name}`)}>Make the copy</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen({ kind: 'none' })}>Cancel</Button>
        </div>
      )}
      {(open.kind === 'files' || open.kind === 'edit') && (open.error
        ? <div className="text-xs text-bad">Its files could not be read: {open.error}</div>
        : !open.files ? <div className="text-xs text-muted-foreground">loading…</div>
          : open.kind === 'edit' ? <SkillEditor mode="edit" name={skill.name} files={open.files} onSaved={onChange} onCancel={() => setOpen({ kind: 'none' })} />
            : (
              <div className="space-y-2">
                {draftRows(open.files).map((f) => (
                  <div key={f.path}>
                    <div className="font-mono text-xs font-medium">{f.path}</div>
                    <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">{f.text}</pre>
                  </div>
                ))}
              </div>
            ))}
    </div>
  );
}

const REPO = /^[^/\s]+\/[^/\s]+$/;

/** Imports a skill from a folder of a GitHub repository: read with the person's own GitHub connection, at a ref it follows. */
export function SkillImport({ onSaved, onCancel }: { onSaved: (v: SkillLibraryView) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ repo: '', path: '', ref: '', name: '' });
  const [busy, setBusy] = useState(false);
  const field = (key: keyof typeof form, placeholder: string) => (
    <Input name={`import-${key}`} className="font-mono text-xs" value={form[key]} placeholder={placeholder} disabled={busy}
      aria-invalid={key === 'repo' && form.repo !== '' && !REPO.test(form.repo.trim())} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
  );
  const save = async () => {
    setBusy(true);
    const body = { action: 'import', repo: form.repo.trim(), path: form.path.trim(), ...(form.ref.trim() ? { ref: form.ref.trim() } : {}), ...(form.name.trim() ? { name: form.name.trim() } : {}) };
    const ok = await changeLibrary('/ui/api/skill-library', body, onSaved, `Skill imported from ${body.repo}`);
    setBusy(false);
    if (ok) onCancel();
  };
  return (
    <div data-slot="skill-import" className="space-y-2 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">The folder that holds the skill&apos;s SKILL.md, read with your GitHub connection. Refresh reads it again at the same ref.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {field('repo', 'owner/name')}
        {field('path', 'folder, e.g. skills/orchestrate (empty: the root)')}
        {field('ref', 'branch or tag (empty: the default branch)')}
        {field('name', 'skill name (empty: the folder\'s name)')}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !REPO.test(form.repo.trim())} onClick={() => void save()}><Download /> Import skill</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
