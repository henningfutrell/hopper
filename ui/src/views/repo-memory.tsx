// Repository memory (issue #2847, design.md "Repository memory"), in Settings: the memory entries jobs learned of each
// repository — a person views, edits, approves, disables, enables and removes them, and adds their own — and the settings.
// Each act posts to POST /ui/api/repo-memory; the next job of the repository gets the change. An admin's; a reader sees them.
import { Brain, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge, type Tone } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import {
  isMemoryRepo, KIND_NAMES, memoryActs, memoryEditPatch, memoryOffered, memoryRepos, memorySettingsDraft, memorySettingsOfDraft, memorySummary,
  STATE_NAMES, type MemoryAct, type MemoryEntryDraft, type MemorySettingsDraft,
} from '@/model/repo-memory';
import type { MemoryEntryView, MemoryKind, MemoryState, RepoMemoryView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const FIELD = 'h-8 rounded-md border bg-transparent px-2 text-sm';
const STATE_TONES: Record<MemoryState, Tone> = { proposed: 'question', approved: 'ok', disabled: 'muted', flagged: 'warn' };
const ACT_NAMES: Record<MemoryAct, string> = { approve: 'Approve', disable: 'Disable', enable: 'Enable' };
const ACT_DONE: Record<MemoryAct, string> = { approve: 'Entry approved', disable: 'Entry disabled', enable: 'Entry enabled' };

/** A post; a refusal is a toast. Answers whether it went through. */
async function send(path: string, body: unknown, done: string): Promise<boolean> {
  try {
    await post(path, body);
    toast.success(`${done}; the next job of the repository gets the change`);
    return true;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error(e instanceof RoleRefused ? 'Only an admin changes the repository memory' : (e as Error).message);
    return false;
  }
}

function KindSelect({ value, onChange, disabled }: { value: MemoryKind; onChange: (k: MemoryKind) => void; disabled: boolean }) {
  return (
    <select aria-label="Kind" className={FIELD} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as MemoryKind)}>
      {(Object.keys(KIND_NAMES) as MemoryKind[]).map((k) => <option key={k} value={k}>{KIND_NAMES[k]}</option>)}
    </select>
  );
}

function EntryEditor({ e, onDone }: { e: MemoryEntryView; onDone: (changed: boolean) => void }) {
  const [draft, setDraft] = useState<MemoryEntryDraft>({ kind: e.kind, area: e.area ?? '', text: e.text });
  const [busy, setBusy] = useState(false);
  const checked = memoryEditPatch(e, draft);
  const save = async () => {
    if (!checked.ok || !checked.patch) return;
    setBusy(true);
    const ok = await send('/ui/api/repo-memory', { action: 'edit', id: e.id, ...checked.patch }, 'Entry saved');
    setBusy(false);
    if (ok) onDone(true);
  };
  return (
    <div data-slot="memory-entry-editor" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <KindSelect value={draft.kind} disabled={busy} onChange={(kind) => setDraft({ ...draft, kind })} />
        <Input name="area" aria-label="Area" className="h-8 w-56 font-mono text-xs" placeholder="area: a path, or empty" value={draft.area} disabled={busy}
          onChange={(ev) => setDraft({ ...draft, area: ev.target.value })} />
      </div>
      <Input name="text" aria-label="Text" className="h-8 text-sm" value={draft.text} disabled={busy} onChange={(ev) => setDraft({ ...draft, text: ev.target.value })} />
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !checked.ok || !checked.patch} onClick={() => void save()}>Save</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDone(false)}>Cancel</Button>
      </div>
    </div>
  );
}

function Entry({ e, admin, onChanged }: { e: MemoryEntryView; admin: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (action: MemoryAct | 'remove') => {
    setBusy(true);
    const ok = await send('/ui/api/repo-memory', { action, id: e.id }, action === 'remove' ? 'Entry removed' : ACT_DONE[action]);
    setBusy(false);
    if (ok) onChanged();
  };
  return (
    <li data-slot="memory-entry" data-entry={e.shortId} className="space-y-1.5 rounded-md border p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-muted-foreground">{e.shortId}</span>
        <StatusBadge status={e.kind} label={KIND_NAMES[e.kind]} tone="muted" />
        <StatusBadge status={e.state} label={STATE_NAMES[e.state]} tone={STATE_TONES[e.state]} />
        {e.expired && <StatusBadge status="expired" label="Expired" tone="warn" title="Too old: no job is offered it until a person approves it again" />}
        {e.area && <span className="font-mono">{e.area}</span>}
        <span className="text-muted-foreground">confidence {Math.round(e.confidence * 100)}%</span>
        <span className="ml-auto text-muted-foreground">
          {e.sourceJobId ? <>learned by <a href={`#job/${e.sourceJobId}`} className="font-mono underline">{e.sourceJobId.slice(0, 8)}</a></> : 'added by a person'}
          {' · changed '}{new Date(e.updatedAt).toLocaleDateString()}
        </span>
      </div>
      {editing ? <EntryEditor e={e} onDone={(changed) => { setEditing(false); if (changed) onChanged(); }} /> : (
        <p data-slot="memory-text" className={memoryOffered(e) ? '' : 'text-muted-foreground'}>{e.text}</p>
      )}
      {e.flag && <p className="text-xs text-warn">Job <a href={`#job/${e.flag.jobId}`} className="font-mono underline">{e.flag.jobId.slice(0, 8)}</a> said it is wrong: {e.flag.reason}</p>}
      {admin && !editing && (
        <div className="flex flex-wrap gap-1.5">
          {memoryActs(e).map((a) => <Button key={a} size="sm" variant={a === 'approve' ? 'default' : 'outline'} disabled={busy} onClick={() => void act(a)}>{ACT_NAMES[a]}</Button>)}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}><Pencil /> Edit</Button>
          <Confirm title="Remove this entry?" description="No job of the repository is offered it again. Disable keeps it for later." action="Remove" onConfirm={() => void act('remove')}>
            <Button size="sm" variant="ghost" aria-label="Remove" disabled={busy}><Trash2 /></Button>
          </Confirm>
        </div>
      )}
    </li>
  );
}

function AddEntry({ repo, onAdded }: { repo: string; onAdded: () => void }) {
  const [draft, setDraft] = useState<MemoryEntryDraft & { repo: string }>({ repo, kind: 'convention', area: '', text: '' });
  const [busy, setBusy] = useState(false);
  const ok = isMemoryRepo(draft.repo) && draft.text.trim() !== '';
  const add = async () => {
    setBusy(true);
    const area = draft.area.trim();
    const done = await send('/ui/api/repo-memory', { action: 'add', repo: draft.repo.trim(), kind: draft.kind, ...(area ? { area } : {}), text: draft.text.trim() }, 'Entry added');
    setBusy(false);
    if (done) { setDraft({ ...draft, area: '', text: '' }); onAdded(); }
  };
  return (
    <div data-slot="memory-add" className="space-y-2 rounded-md border border-dashed p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input name="repo" aria-label="Repository" className="h-8 w-56 font-mono text-xs" placeholder="owner/name" value={draft.repo} disabled={busy}
          aria-invalid={draft.repo !== '' && !isMemoryRepo(draft.repo)} onChange={(e) => setDraft({ ...draft, repo: e.target.value })} />
        <KindSelect value={draft.kind} disabled={busy} onChange={(kind) => setDraft({ ...draft, kind })} />
        <Input name="area" aria-label="Area" className="h-8 w-56 font-mono text-xs" placeholder="area: a path, or empty" value={draft.area} disabled={busy}
          onChange={(e) => setDraft({ ...draft, area: e.target.value })} />
      </div>
      <Input name="text" aria-label="Text" className="h-8 text-sm" placeholder="One line every job of the repository is told" value={draft.text} disabled={busy}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
      <Button size="sm" variant="outline" disabled={busy || !ok} onClick={() => void add()}><Plus /> Add an entry</Button>
    </div>
  );
}

function Settings({ view, onSaved }: { view: RepoMemoryView; onSaved: () => void }) {
  const admin = useCanAdmin();
  const [draft, setDraft] = useState<MemorySettingsDraft>(() => memorySettingsDraft(view.settings));
  const [busy, setBusy] = useState(false);
  const checked = memorySettingsOfDraft(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(memorySettingsDraft(view.settings));
  const setRow = (i: number, row: Partial<MemorySettingsDraft['repos'][number]>) => setDraft({ ...draft, repos: draft.repos.map((r, j) => (j === i ? { ...r, ...row } : r)) });
  const save = async () => {
    if (!checked.ok) return;
    setBusy(true);
    const ok = await send('/ui/api/repo-memory/settings', { settings: checked.settings, version: view.version }, 'Settings saved');
    setBusy(false);
    if (ok) onSaved();
  };
  return (
    <section data-slot="repo-memory-settings" className="space-y-2 text-sm">
      <p data-slot="repo-memory-summary" className="font-medium">{memorySummary(view.settings)}</p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-56">Jobs learn and are offered entries</span>
        <Switch checked={draft.on} disabled={busy || !admin} aria-label="Jobs learn and are offered entries" onCheckedChange={(on) => setDraft({ ...draft, on })} />
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-56">A learned entry waits for approval</span>
        <Switch checked={draft.approval} disabled={busy || !admin} aria-label="A learned entry waits for approval" onCheckedChange={(approval) => setDraft({ ...draft, approval })} />
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-56">Size cap</span>
        <Input className="h-8 w-24" inputMode="numeric" aria-label="Size cap" disabled={busy || !admin} value={draft.maxBytes} onChange={(e) => setDraft({ ...draft, maxBytes: e.target.value })} />
        <span className="text-xs text-muted-foreground">bytes of entries one job is offered</span>
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-56">Expiry</span>
        <Input className="h-8 w-24" inputMode="numeric" aria-label="Expiry" disabled={busy || !admin} value={draft.expireDays} onChange={(e) => setDraft({ ...draft, expireDays: e.target.value })} />
        <span className="text-xs text-muted-foreground">days after its last change</span>
      </label>
      {draft.repos.map((r, i) => (
        <div key={i} data-slot="repo-memory-repo" className="flex flex-wrap items-center gap-2">
          <Input name="repo" aria-label="Repository" className="h-8 w-56 font-mono text-xs" placeholder="owner/name or owner/*" value={r.repo} disabled={busy || !admin}
            onChange={(e) => setRow(i, { repo: e.target.value })} />
          <label className="flex items-center gap-1 text-xs">On <Switch checked={r.on} disabled={busy || !admin} aria-label={`On for ${r.repo}`} onCheckedChange={(on) => setRow(i, { on })} /></label>
          <label className="flex items-center gap-1 text-xs">Approval <Switch checked={r.approval} disabled={busy || !admin} aria-label={`Approval for ${r.repo}`} onCheckedChange={(approval) => setRow(i, { approval })} /></label>
          {admin && <Button size="sm" variant="ghost" aria-label="Remove the repository setting" disabled={busy} onClick={() => setDraft({ ...draft, repos: draft.repos.filter((_, j) => j !== i) })}><Trash2 /></Button>}
        </div>
      ))}
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      {admin && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setDraft({ ...draft, repos: [...draft.repos, { repo: '', on: draft.on, approval: draft.approval }] })}><Plus /> A setting for a repository</Button>
          <Button size="sm" disabled={busy || !dirty || !checked.ok} onClick={() => void save()}>Save settings</Button>
        </div>
      )}
    </section>
  );
}

export function RepoMemory() {
  const admin = useCanAdmin();
  const [view, setView] = useState<RepoMemoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  const load = useCallback(() => {
    get<RepoMemoryView>('/api/repo-memory').then((v) => {
      // An answer without its parts is refused, never read as no entry.
      if (Array.isArray(v?.entries) && v.settings && typeof v.version === 'string') setView(v);
    }, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const repos = view ? memoryRepos(view.entries) : [];
  const shown = view ? view.entries.filter((e) => repo === '' || e.repo === repo) : [];
  return (
    <div data-slot="repo-memory" className="space-y-4">
      <Panel title="Repository memory" icon={Brain} count={view?.entries.length} bodyClassName="space-y-4">
        {view ? (
          <>
            <p className="text-xs text-muted-foreground">
              What earlier jobs of a repository learned: its conventions and its past fixes. Each job of the repository is offered
              the approved entries that have not expired, the most confident first. A job writes a memory line in its final
              message to propose an entry, or to flag one as wrong. An edit, a removal or a disable takes effect for the next job.
            </p>
            <Settings key={view.version} view={view} onSaved={load} />
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">Entries</h3>
                <select aria-label="Repository" className={FIELD} value={repo} onChange={(e) => setRepo(e.target.value)}>
                  <option value="">Every repository</option>
                  {repos.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              {shown.length === 0 ? <Empty>No entry yet. A finished job of a repository proposes them.</Empty> : (
                <ul className="space-y-2">{shown.map((e) => <Entry key={`${e.id}:${e.updatedAt}:${e.state}`} e={e} admin={admin} onChanged={load} />)}</ul>
              )}
              {admin && <AddEntry key={repo} repo={repo} onAdded={load} />}
            </section>
          </>
        ) : <Empty>{error ?? 'loading…'}</Empty>}
      </Panel>
    </div>
  );
}
