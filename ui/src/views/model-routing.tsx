// Model routing (issue #2848, part 2), in Settings, an admin's: on and off, the executors it routes, the model and budget of
// each model choice, escalation, and the model rules and the repositories' budgets as JSON. Saved to the daemon (POST
// /ui/api/model-routing), which checks it and says why it refuses; read at each intake, so it applies to the next job.
// Part 3: tuning from grades.
import { Split } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { modelRoutingDraftOf, modelRoutingPatch, modelRoutingSummary, type ModelRoutingDraft } from '@/model/model-routing';
import type { ModelRoutingSettings } from '@/model/wire';
import { useHopper } from '@/store';

type TextField = Exclude<keyof ModelRoutingDraft, 'on' | 'escalate' | 'tuneOn' | 'rules' | 'repos'>;

function Form({ view, onSaved }: { view: ModelRoutingSettings; onSaved: (v: ModelRoutingSettings) => void }) {
  const [draft, setDraft] = useState<ModelRoutingDraft>(() => modelRoutingDraftOf(view));
  const [busy, setBusy] = useState(false);
  const checked = modelRoutingPatch(view, draft);
  const save = async () => {
    if (!checked.ok || !checked.patch) return;
    setBusy(true);
    try {
      onSaved(await post<ModelRoutingSettings>('/ui/api/model-routing', checked.patch));
      toast.success('Model routing saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes model routing' : (e as Error).message);
    }
    setBusy(false);
  };
  const field = (key: TextField, label: string, unit: string, wide = false) => (
    <label className="flex flex-wrap items-center gap-2">
      <span className="min-w-56">{label}</span>
      <Input className={wide ? 'h-8 w-72' : 'h-8 w-32'} aria-label={label} disabled={busy} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      <span className="text-xs text-muted-foreground">{unit}</span>
    </label>
  );
  const toggle = (key: 'on' | 'escalate' | 'tuneOn', label: string) => (
    <label className="flex items-center gap-2">
      <Switch checked={draft[key]} disabled={busy} aria-label={label} onCheckedChange={(v) => setDraft({ ...draft, [key]: v })} />
      <span>{label}</span>
    </label>
  );
  const json = (key: 'rules' | 'repos', label: string) => (
    <label className="block space-y-1">
      <span>{label}</span>
      <Textarea aria-label={label} className="min-h-32 font-mono text-xs" disabled={busy} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
    </label>
  );
  return (
    <div data-slot="model-routing" className="space-y-3 text-sm">
      <p data-slot="model-routing-summary" className="font-medium">{modelRoutingSummary(view)}</p>
      <p className="text-xs text-muted-foreground">
        At intake the hopper reads the class of each job's work: its size, its kind, its risk and its repository. A label hopper:model-cheap or
        hopper:model-strong picks the model. Else the first model rule that matches picks it. Else the strong model. The job keeps its model and its
        budget. A job over its budget is paused, not stopped. An empty model is the agent's own default. 0 takes a cap off: the token budget's job cap holds.
      </p>
      {toggle('on', 'Model routing on')}
      {field('executors', 'Executors it routes', 'names, with commas', true)}
      {field('cheapModel', 'Cheap model', 'model alias or id')}
      {field('cheapTokens', 'Cheap model: tokens per job', 'tokens')}
      {field('cheapCost', 'Cheap model: cost per job', 'US dollars')}
      {field('strongModel', 'Strong model', 'model alias or id')}
      {field('strongTokens', 'Strong model: tokens per job', 'tokens')}
      {field('strongCost', 'Strong model: cost per job', 'US dollars')}
      {toggle('escalate', 'Escalate: a cheap job that fails, or that a person picks up after its budget or a stall paused it, goes on on the strong model')}
      {toggle('tuneOn', 'Tune from grades: grade history can change the model a rule picks')}
      {field('tuneMinSamples', 'Tune: graded jobs of each model', 'at least')}
      {field('tuneMargin', 'Tune: margin', 'points of 100')}
      {json('rules', 'Model rules (JSON, in order: name, match on repo, label, kind, size, risk, and choice)')}
      {json('repos', 'Repository budgets (JSON: owner/name to each choice\'s jobTokens and jobCostUsd)')}
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <Button size="sm" disabled={busy || !checked.ok || !checked.patch} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; keyed by the saved values, so a save starts the form from them. */
export function ModelRouting() {
  const [view, setView] = useState<ModelRoutingSettings | null>(null);
  useEffect(() => { get<ModelRoutingSettings>('/api/model-routing').then((v) => { if (typeof v?.on === 'boolean' && Array.isArray(v.rules)) setView(v); }, () => {}); }, []);
  return (
    <Panel title="Model routing" icon={Split} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
