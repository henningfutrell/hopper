// Settings → GitHub webhook (issue #1079), the hopper's admin's: where GitHub, or a relay in front of the hopper, sends its
// `issues` deliveries, the GitHub webhook secret — made here and shown once, to paste into GitHub — and what came in since
// the start. A delivery makes its repository due at the sources whose job repository it is, so a new issue reaches
// intake in seconds; the timed listing stays for the deliveries that never come.
import { Copy, GitPullRequestArrow, KeyRound, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { deliveriesLine, deliverySecretLine, deliveryUrl, relayCommand } from '@/model/github-deliveries';
import type { GitHubDeliveriesView } from '@/model/wire';
import { useHopper } from '@/store';

const copy = (value: string) => navigator.clipboard?.writeText(value).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked: select and copy it'));

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-28 text-xs text-muted-foreground">{label}</span>
      <code className="font-mono text-xs break-all select-all">{value}</code>
      <Button size="sm" variant="ghost" aria-label={`Copy ${label}`} onClick={() => void copy(value)}><Copy className="size-4" /></Button>
    </div>
  );
}

function Form({ view, onSaved }: { view: GitHubDeliveriesView; onSaved: (v: GitHubDeliveriesView) => void }) {
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string | undefined>();
  const url = deliveryUrl(window.location.origin, view.path);
  const act = async (action: 'make' | 'remove') => {
    setBusy(true);
    try {
      const { generatedSecret, ...next } = await post<GitHubDeliveriesView & { generatedSecret?: string }>('/ui/api/github-deliveries', { action });
      onSaved(next);
      setMade(generatedSecret);
      if (action === 'remove') toast.success('GitHub webhook secret removed');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only the hopper\'s admin changes the GitHub webhook' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="github-deliveries" className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        GitHub tells the hopper at once when an issue is opened, edited, labelled, assigned, closed or reopened. The hopper then lists that
        repository again in a few seconds, not at the next intake sync. GitHub must reach the hopper for this. Most hoppers are not on the
        internet: run a relay, such as the GitHub CLI&apos;s webhook forward, on a computer that reaches the hopper. Without deliveries, intake
        still lists each job repository at the intake sync interval.
      </p>
      <div className="space-y-1 rounded-lg border p-3">
        <Line label="Payload URL" value={url} />
        <div className="flex flex-wrap items-center gap-2"><span className="min-w-28 text-xs text-muted-foreground">Content type</span><code className="font-mono text-xs">application/json</code></div>
        <div className="flex flex-wrap items-center gap-2"><span className="min-w-28 text-xs text-muted-foreground">Events</span><code className="font-mono text-xs">{view.events.join(', ')}</code></div>
        <Line label="Relay" value={relayCommand(url)} />
      </div>
      <div className="space-y-2">
        <p data-slot="github-deliveries-secret"><KeyRound className="mr-1 inline size-4" />{deliverySecretLine(view.secret)}</p>
        {view.problem && <p role="alert" className="text-xs text-destructive">{view.problem}</p>}
        {made !== undefined && (
          <div role="alert" className="space-y-2 rounded-lg border border-warn p-3">
            <div className="text-sm font-medium">New GitHub webhook secret</div>
            <div className="text-xs text-muted-foreground">Shown once. Paste it into the webhook&apos;s Secret on GitHub, or the relay&apos;s --secret, now: the hopper keeps it encrypted and never shows it again.</div>
            <code className="block font-mono text-xs break-all select-all">{made}</code>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void copy(made)}><Copy />Copy</Button>
              <Button size="sm" onClick={() => setMade(undefined)}>Done</Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || view.problem !== undefined} onClick={() => void act('make')}>{view.secret.set ? 'Rotate secret' : 'Make secret'}</Button>
          {view.secret.set && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('remove')}><Trash2 />Remove secret</Button>}
        </div>
      </div>
      <div className="space-y-1 border-t pt-3">
        <h3 className="text-xs font-medium uppercase text-muted-foreground">Deliveries</h3>
        <p data-slot="github-deliveries-received">{deliveriesLine(view)}</p>
        {view.lastRefused && <p className="text-xs text-muted-foreground">Last refused: {view.lastRefused.why}.</p>}
      </div>
    </div>
  );
}

/** Read when shown. */
export function GitHubDeliveries() {
  const [view, setView] = useState<GitHubDeliveriesView | null>(null);
  useEffect(() => { get<GitHubDeliveriesView>('/api/github-deliveries').then((v) => { if (typeof v?.path === 'string' && v.secret) setView(v); }, () => {}); }, []);
  return (
    <Panel title="GitHub webhook" icon={GitPullRequestArrow} className="max-w-3xl">
      {view ? <Form view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
