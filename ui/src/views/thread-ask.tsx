// Asking on the issue thread (issue #435), in Settings, an admin's: what the hopper does with a GitHub job's question once
// it reaches a person — in repositories your connected account owns, and in any other. Saved to the daemon and read at
// each sync, without a restart.
import { MessagesSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { POLICY_LABELS, threadAskPatch, threadAskSummary } from '@/model/thread-ask';
import type { ThreadAskPolicy, ThreadAskSettings } from '@/model/wire';
import { useHopper } from '@/store';

const POLICIES = Object.keys(POLICY_LABELS) as ThreadAskPolicy[];

function Form({ view, onSaved }: { view: ThreadAskSettings; onSaved: (v: ThreadAskSettings) => void }) {
  const [draft, setDraft] = useState<ThreadAskSettings>(view);
  const [busy, setBusy] = useState(false);
  const patch = threadAskPatch(view, draft);
  const save = async () => {
    if (!patch) return;
    setBusy(true);
    try {
      onSaved(await post<ThreadAskSettings>('/ui/api/thread-ask', patch));
      toast.success('Issue thread saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the issue thread policy' : (e as Error).message);
    }
    setBusy(false);
  };
  const field = (key: keyof ThreadAskSettings, label: string) => (
    <label className="flex flex-wrap items-center gap-2">
      <span className="min-w-56">{label}</span>
      <select aria-label={label} disabled={busy} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value as ThreadAskPolicy })}
        className="h-8 rounded-md border bg-background px-2 text-xs">
        {POLICIES.map((p) => <option key={p} value={p}>{POLICY_LABELS[p]}</option>)}
      </select>
    </label>
  );
  return (
    <div data-slot="thread-ask" className="space-y-3 text-sm">
      <p data-slot="thread-ask-summary" className="font-medium">{threadAskSummary(view)}</p>
      <p className="text-xs text-muted-foreground">
        When a job from a GitHub issue is blocked on a question for a person, the hopper can ask it on the issue, so the people there can answer.
        The job parks while it waits. The first reply from your account or a maintainer of the repository answers the question, and the job resumes by itself.
        Posts go out under your account. A held question waits on its card for you to approve it. You can always answer in the hopper.
        A question that a risk rule or the consequential guard sent to you is never posted.
      </p>
      {field('ownRepos', 'Repositories you own')}
      {field('otherRepos', 'Other repositories')}
      <Button size="sm" disabled={busy || !patch} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; keyed by the saved values, so a save starts the form from them. */
export function ThreadAsk() {
  const [view, setView] = useState<ThreadAskSettings | null>(null);
  useEffect(() => { get<ThreadAskSettings>('/api/thread-ask').then((v) => { if (typeof v?.ownRepos === 'string' && typeof v.otherRepos === 'string') setView(v); }, () => {}); }, []);
  return (
    <Panel title="Issue thread" icon={MessagesSquare} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
