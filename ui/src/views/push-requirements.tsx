// Push requirements (issue #2555), in Settings, an admin's: the hopper's default requirements, which apply to every
// repository's push below its own requirements file. Edited as JSON, in the shape of a requirements file; saved to the
// daemon and read at each evaluation and push, without a restart.
import { ClipboardCheck, Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { PUSH_REQUIREMENTS_NOTE, pushRequirementMetricsLine, pushRequirementsSummary, requirementsDraft, requirementsText } from '@/model/push-requirements';
import type { PushRequirement, PushRequirementMetrics } from '@/model/wire';
import { useHopper } from '@/store';

type Saved = { requirements: PushRequirement[] };

function Form({ view, onSaved }: { view: Saved; onSaved: (v: Saved) => void }) {
  const [draft, setDraft] = useState(view.requirements.length === 0 ? '' : requirementsText(view.requirements));
  const [busy, setBusy] = useState(false);
  const checked = requirementsDraft(draft);
  const save = async () => {
    if (!checked.ok) return;
    setBusy(true);
    try {
      onSaved(await post<Saved>('/ui/api/push-requirements', checked.body));
      toast.success('Push requirements saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the push requirements' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="push-requirements" className="space-y-3 text-sm">
      <p role="note" className="flex gap-2 rounded-md border p-3 text-xs text-muted-foreground"><Info className="size-4 shrink-0" />{PUSH_REQUIREMENTS_NOTE}</p>
      <p data-slot="push-requirements-summary" className="font-medium">{pushRequirementsSummary(view.requirements)}</p>
      <Textarea aria-label="Default push requirements" className="min-h-48 font-mono text-xs" spellCheck={false} disabled={busy} value={draft}
        placeholder={requirementsText([{ id: 'workflows', when: { workflows: true }, checks: [{ name: 'actionlint', run: 'actionlint' }] }])}
        onChange={(e) => setDraft(e.target.value)} />
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <Button size="sm" disabled={busy || !checked.ok} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; an answer without a `requirements` list is refused, never read as none. Keyed by what was saved. */
export function PushRequirements() {
  const [view, setView] = useState<Saved | null>(null);
  const [metrics, setMetrics] = useState<(PushRequirementMetrics & { days: number }) | null>(null);
  useEffect(() => { get<Saved>('/api/push-requirements').then((v) => { if (Array.isArray(v?.requirements)) setView(v); }, () => {}); }, []);
  useEffect(() => { get<PushRequirementMetrics & { days: number }>('/api/push-requirements/metrics').then((m) => { if (typeof m?.caught === 'number') setMetrics(m); }, () => {}); }, []);
  return (
    <Panel title="Push requirements" icon={ClipboardCheck} className="max-w-3xl">
      {metrics && <p data-slot="push-requirements-metrics" className="mb-3 text-sm text-muted-foreground">{pushRequirementMetricsLine(metrics)}</p>}
      {view ? <Form key={JSON.stringify(view.requirements)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
