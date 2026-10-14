// Landing batches (issue #1073), in Settings, an admin's: per repository, the tested branch a green batch run moves, and
// when a batch run starts (after N merges into the landing branch, or a timer; none while nothing is new). A job's pull
// request lands on the repository's default branch, the landing branch (`main` for the hopper's own); the full
// test suite runs on its tip as a batch run. Each configured repository says where its batch runs stand.
import { Layers } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { landingBatchLine, landingBatchPatch } from '@/model/landing-batches';
import type { LandingBatchesView, LandingBatchSettings } from '@/model/wire';
import { useHopper } from '@/store';

const DEFAULTS = { tested: 'dev', everyMerges: 5, everyMinutes: 60 };

function Form({ view, onSaved }: { view: LandingBatchesView; onSaved: (v: LandingBatchesView) => void }) {
  const [draft, setDraft] = useState<LandingBatchSettings>(view.settings);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const patch = landingBatchPatch(view.settings, draft);
  const free = view.choices.repos.filter((r) => !draft.repos[r.toLowerCase()]);
  const setRepo = (repo: string, part: Partial<typeof DEFAULTS>) => setDraft({ repos: { ...draft.repos, [repo]: { ...draft.repos[repo]!, ...part } } });
  const save = async () => {
    if (!patch) return;
    setBusy(true);
    try {
      onSaved(await post<LandingBatchesView>('/ui/api/landing-batches', patch));
      toast.success('Landing batches saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the landing batches' : (e as Error).message);
    }
    setBusy(false);
  };
  const number = (v: string) => Math.max(1, Math.floor(Number(v) || 1));
  return (
    <div data-slot="landing-batches" className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        A job&apos;s pull request merges into the repository&apos;s default branch, the landing branch, after the fast checks only.
        The full test suite then runs on the landing branch&apos;s tip as a batch run, and a green batch run moves the tested
        branch in one merge. Make the landing branch the default branch on GitHub first.
      </p>
      {Object.entries(draft.repos).map(([repo, c]) => {
        const row = view.repos.find((r) => r.repo === repo);
        return (
          <fieldset key={repo} className="grid gap-2 rounded-md border p-3">
            <legend className="px-1 font-mono text-xs">{repo}</legend>
            {row && <p data-slot="landing-batch-line" className="text-xs">{landingBatchLine(row)}</p>}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="flex items-center gap-1">Tested branch
                <Input className="h-8 w-28" value={c.tested} disabled={busy} aria-label={`Tested branch of ${repo}`} onChange={(e) => setRepo(repo, { tested: e.target.value.trim() })} />
              </label>
              <label className="flex items-center gap-1">after
                <Input type="number" min={1} className="h-8 w-20" value={c.everyMerges} disabled={busy} aria-label={`Merges before a batch run of ${repo}`} onChange={(e) => setRepo(repo, { everyMerges: number(e.target.value) })} />
                merges, or every
              </label>
              <label className="flex items-center gap-1">
                <Input type="number" min={1} className="h-8 w-20" value={c.everyMinutes} disabled={busy} aria-label={`Minutes between batch runs of ${repo}`} onChange={(e) => setRepo(repo, { everyMinutes: number(e.target.value) })} />
                minutes
              </label>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { const { [repo]: _, ...rest } = draft.repos; setDraft({ repos: rest }); }}>Remove</Button>
            </div>
          </fieldset>
        );
      })}
      {free.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select className="h-8 rounded-md border bg-background px-2 text-xs" aria-label="Repository to add" value={adding} disabled={busy} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a repository…</option>
            {free.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <Button size="sm" variant="outline" disabled={busy || !adding} onClick={() => { setDraft({ repos: { ...draft.repos, [adding.toLowerCase()]: DEFAULTS } }); setAdding(''); }}>Add</Button>
        </div>
      )}
      <Button size="sm" disabled={busy || !patch} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; keyed by the saved values, so a save starts the form from them. */
export function LandingBatches() {
  const [view, setView] = useState<LandingBatchesView | null>(null);
  useEffect(() => { get<LandingBatchesView>('/api/landing-batches').then((v) => { if (v?.settings?.repos && Array.isArray(v.repos)) setView(v); }, () => {}); }, []);
  return (
    <Panel title="Landing batches" icon={Layers} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view.settings)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
